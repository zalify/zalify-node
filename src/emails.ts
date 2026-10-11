import { randomUUID } from "node:crypto";
import { ZalifyError } from "./errors";
import { type HttpConfig, request } from "./http";

/**
 * `transactional` (sign-in, password reset, receipts, notifications) goes out
 * at once with no unsubscribe link. `marketing` gets an unsubscribe link and
 * headers, respects unsubscribes and only reaches subscribed contacts.
 */
export type EmailType = "transactional" | "marketing";

export type EmailMessage = {
  /** `Name <address>` or a bare address, on a domain verified in Zalify. */
  from: string;
  /** One recipient. Send one message per recipient. */
  to: string;
  replyTo?: string;
  subject: string;
  /** Rendered HTML, up to 5 MB. */
  html: string;
  /** Plain-text alternative. Recommended. */
  text?: string;
  /**
   * Up to 18 labels returned on webhook events: letters, digits and
   * `_ . @ -`. Keys can't start with `zalify_`, `_reach_`, `_zmg_`, `ses:`,
   * `automation_`, `broadcast_` or `message_`.
   */
  tags?: Record<string, string>;
};

export type SendEmailParams = EmailMessage & { type?: EmailType };

export type SendEmailResult = {
  /**
   * The message id. A recipient on your suppression list (an earlier hard
   * bounce or complaint) still gets an id; that message is not delivered.
   */
  id: string;
};

export type SendBatchParams = {
  type?: EmailType;
  /** 1–100 messages, all of the same `type`. */
  messages: EmailMessage[];
};

export type EmailSendError = {
  code: "unverified_sender" | "not_subscribed" | "suppressed" | "rejected";
  message: string;
};

export type SendBatchResult = {
  /** One entry per message, in request order. */
  data: Array<{ id: string } | { error: EmailSendError }>;
};

export type RequestOptions = {
  /**
   * Sends once per key, even across retries and restarts: use one per logical
   * email (e.g. `reset:${tokenId}`). When omitted, the SDK makes one for this
   * call, which protects its own retries but not a retry of the whole call.
   */
  idempotencyKey?: string;
};

const MAX_BATCH = 100;

export class Emails {
  constructor(private readonly http: HttpConfig) {}

  /** Send one email. Throws ZalifyError when it isn't accepted. */
  async send(
    params: SendEmailParams,
    options: RequestOptions = {}
  ): Promise<SendEmailResult> {
    return request<SendEmailResult>(this.http, {
      method: "POST",
      path: "/email/send",
      body: params,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
    });
  }

  /**
   * Send up to 100 emails in one request. A refused message doesn't fail the
   * others: check each entry of `data` for `id` or `error`.
   */
  async sendBatch(
    params: SendBatchParams | EmailMessage[],
    options: RequestOptions = {}
  ): Promise<SendBatchResult> {
    const body = Array.isArray(params) ? { messages: params } : params;
    if (body.messages.length === 0 || body.messages.length > MAX_BATCH) {
      throw new ZalifyError({
        message: `A batch holds 1 to ${MAX_BATCH} messages, got ${body.messages.length}`,
        code: "invalid_request",
        status: 0,
      });
    }
    return request<SendBatchResult>(this.http, {
      method: "POST",
      path: "/email/send/batch",
      body,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
    });
  }
}
