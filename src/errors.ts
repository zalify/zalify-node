/**
 * Codes the Zalify API returns in `{ error, code }`, plus `network_error` and
 * `timeout` for requests that never got an answer.
 */
export type ZalifyErrorCode =
  | "unauthorized"
  | "missing_scope"
  | "email_not_enabled"
  | "usage_paused"
  | "invalid_json"
  | "invalid_request"
  | "too_large"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "rate_limited"
  | "unavailable"
  | "unverified_sender"
  | "not_subscribed"
  | "suppressed"
  | "rejected"
  | "network_error"
  | "timeout"
  | (string & {});

export class ZalifyError extends Error {
  /** Machine-readable reason; branch on this, not on `message`. */
  readonly code: ZalifyErrorCode;
  /** HTTP status, or 0 when no response arrived. */
  readonly status: number;
  /** Field-level validation messages for `invalid_request`. */
  readonly details?: string[];
  /** Seconds the API asked to wait (429, 409 in progress). */
  readonly retryAfter?: number;

  constructor(init: {
    message: string;
    code: ZalifyErrorCode;
    status: number;
    details?: string[];
    retryAfter?: number;
  }) {
    super(init.message);
    this.name = "ZalifyError";
    this.code = init.code;
    this.status = init.status;
    if (init.details) this.details = init.details;
    if (init.retryAfter !== undefined) this.retryAfter = init.retryAfter;
  }

  /** Whether sending the same request again (same idempotency key) may succeed. */
  get retryable(): boolean {
    return (
      this.code === "rate_limited" ||
      this.code === "unavailable" ||
      this.code === "idempotency_in_progress" ||
      this.code === "network_error" ||
      this.code === "timeout"
    );
  }
}
