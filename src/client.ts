import { Emails } from "./emails";
import { Webhooks } from "./webhooks";
import type { HttpConfig } from "./http";

export const VERSION = "0.2.0";

export type ZalifyOptions = {
  /** A Zalify Public API key (`zalify_api_…`). Defaults to `ZALIFY_API_KEY`. */
  apiKey?: string;
  /** Defaults to `https://app.zalify.com/api/v1`. */
  baseUrl?: string;
  /** Retries for 429 / 503 / timeouts / network errors. Default 3. */
  maxRetries?: number;
  /** Per-attempt timeout. Default 30 s. */
  timeoutMs?: number;
  /** Longest wait between retries the SDK will sit through. Default 10 s. */
  maxRetryDelayMs?: number;
  /** A custom fetch (tests, proxies). Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Your endpoint's `whsec_…` secret, for `webhooks.verify`. Defaults to `ZALIFY_WEBHOOK_SECRET`. */
  webhookSecret?: string;
};

export class Zalify {
  readonly emails: Emails;
  readonly webhooks: Webhooks;

  constructor(apiKeyOrOptions?: string | ZalifyOptions) {
    const options: ZalifyOptions =
      typeof apiKeyOrOptions === "string"
        ? { apiKey: apiKeyOrOptions }
        : (apiKeyOrOptions ?? {});
    const apiKey =
      options.apiKey ??
      (typeof process !== "undefined" ? process.env.ZALIFY_API_KEY : undefined);
    if (!apiKey) {
      throw new Error(
        "Missing Zalify API key: pass it to new Zalify(key) or set ZALIFY_API_KEY."
      );
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error("No fetch available: use Node 18+ or pass options.fetch.");
    }
    const http: HttpConfig = {
      apiKey,
      baseUrl: (options.baseUrl ?? "https://app.zalify.com/api/v1").replace(
        /\/+$/,
        ""
      ),
      fetch: fetchImpl,
      maxRetries: options.maxRetries ?? 3,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetryDelayMs: options.maxRetryDelayMs ?? 10_000,
      userAgent: `zalify-node/${VERSION}`,
    };
    this.emails = new Emails(http);
    this.webhooks = new Webhooks(options.webhookSecret);
  }
}
