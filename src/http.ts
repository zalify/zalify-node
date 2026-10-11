import { ZalifyError } from "./errors";

export type HttpConfig = {
  apiKey: string;
  baseUrl: string;
  fetch: typeof fetch;
  maxRetries: number;
  timeoutMs: number;
  /** Longest single wait between retries, in ms. */
  maxRetryDelayMs: number;
  userAgent: string;
};

type RequestInit = {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  idempotencyKey?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with full jitter: 0.5s, 1s, 2s… capped. */
const backoffMs = (attempt: number, cap: number) =>
  Math.min(cap, 500 * 2 ** attempt) * (0.5 + Math.random() / 2);

const parseRetryAfter = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
};

/**
 * One API call with retries for what's safe to retry: 429, 503, an in-flight
 * idempotent request (409 idempotency_in_progress), timeouts and network
 * errors. Callers pass an idempotency key for sends, so a retry never sends
 * twice.
 */
export async function request<T>(
  config: HttpConfig,
  init: RequestInit
): Promise<T> {
  let lastError: ZalifyError | undefined;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (attempt > 0 && lastError) {
      const asked =
        lastError.retryAfter !== undefined
          ? lastError.retryAfter * 1000
          : undefined;
      // A wait longer than we're willing to sit through is the caller's call.
      if (asked !== undefined && asked > config.maxRetryDelayMs) break;
      await sleep(asked ?? backoffMs(attempt - 1, config.maxRetryDelayMs));
    }
    try {
      return await once<T>(config, init);
    } catch (error) {
      if (!(error instanceof ZalifyError) || !error.retryable) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function once<T>(config: HttpConfig, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await config.fetch(`${config.baseUrl}${init.path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": config.userAgent,
        ...(init.idempotencyKey
          ? { "Idempotency-Key": init.idempotencyKey }
          : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");
    throw new ZalifyError({
      message: aborted
        ? `Request timed out after ${config.timeoutMs} ms`
        : `Network error: ${error instanceof Error ? error.message : String(error)}`,
      code: aborted ? "timeout" : "network_error",
      status: 0,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (response.ok) return body as T;

  const payload = (body ?? {}) as {
    error?: unknown;
    code?: unknown;
    details?: unknown;
  };
  throw new ZalifyError({
    message:
      typeof payload.error === "string"
        ? payload.error
        : `Zalify API request failed with status ${response.status}`,
    code:
      typeof payload.code === "string"
        ? payload.code
        : response.status === 401
          ? "unauthorized"
          : response.status === 429
            ? "rate_limited"
            : response.status >= 500
              ? "unavailable"
              : "invalid_request",
    status: response.status,
    details: Array.isArray(payload.details)
      ? payload.details.filter((d): d is string => typeof d === "string")
      : undefined,
    retryAfter: parseRetryAfter(response.headers.get("retry-after")),
  });
}
