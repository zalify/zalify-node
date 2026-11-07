import { randomUUID } from "node:crypto";
import { ZalifyError } from "./errors";
import { type HttpConfig, type RawBody, request } from "./http";

/**
 * `transactional` (sign-in, password reset, receipts, notifications) goes out
 * at once with no unsubscribe link. `marketing` gets an unsubscribe link and
 * headers, respects unsubscribes and only reaches subscribed contacts.
 */
export type EmailType = "transactional" | "marketing";

/**
 * The sender: a `from` address, or `senderEmailId`, a sender email set up in
 * Zalify (Settings → Email; list them with `emails.listSenders()`) whose
 * name, address and Reply-To are then used.
 */
export type EmailSender =
  | {
      /** `Name <address>` or a bare address, on a domain verified in Zalify. */
      from: string;
      senderEmailId?: never;
    }
  | {
      /** A sender email's `id` from `emails.listSenders()`. */
      senderEmailId: string;
      from?: never;
    };

export type EmailMessage = EmailSender & {
  /** One recipient. Send one message per recipient. */
  to: string;
  /** Defaults to the sender email's Reply-To with `senderEmailId`. */
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
  /**
   * Up to 10 extra headers. For back-and-forth with a person, use
   * `zalify.conversations`, which threads replies for you. From, To, Cc,
   * Subject, Reply-To, Message-ID, Date, Content-Type, List-Unsubscribe and
   * the like are set by Zalify and refused.
   */
  headers?: Record<string, string>;
  /** Up to 10 files, 10 MB together. */
  attachments?: EmailAttachment[];
};

export type EmailAttachment = {
  filename: string;
  /** The file: bytes (Buffer, Uint8Array) or a base64 string. */
  content: Uint8Array | string;
  contentType?: string;
  /** Shows the file inline, referenced from the HTML as `cid:<contentId>`. */
  contentId?: string;
};

export type SendEmailParams = EmailMessage & { type?: EmailType };

/** A sender email from Settings → Email. */
export type SenderEmail = {
  /** Pass as `senderEmailId`. */
  id: string;
  name: string;
  email: string;
  /** Where replies go; null when they go to `email`. */
  replyTo: string | null;
  /** Ready to send from. Sends from an unverified sender fail with `unverified_sender`. */
  verified: boolean;
};

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
  code:
    | "unverified_sender"
    | "not_subscribed"
    | "new_recipient_limit"
    | "suppressed"
    | "rejected";
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

const toBase64 = (content: Uint8Array | string) =>
  typeof content === "string"
    ? content
    : Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString(
        "base64"
      );

/** The message as the API takes it: attachments base64-encoded. */
const toWire = <T extends EmailMessage>(message: T): T =>
  message.attachments
    ? {
        ...message,
        attachments: message.attachments.map((file) => ({
          ...file,
          content: toBase64(file.content),
        })),
      }
    : message;

/** A received email in a list. */
export type InboundEmailSummary = {
  id: string;
  /** The mailbox it came in on, e.g. support@brand.com. */
  mailbox: string;
  from: string;
  subject: string;
  /** The start of the text body. */
  preview: string;
  /** The `id` of your email it replies to, when it answers one you sent. */
  inReplyToEmailId: string | null;
  receivedAt: string;
};

export type InboundEmailAttachment = {
  id: string;
  filename: string;
  contentType: string;
  /** Bytes. */
  size: number;
  contentId: string | null;
  /** Shown in the HTML (`cid:<contentId>`) rather than attached. */
  inline: boolean;
};

/** A received email, whole. */
export type InboundEmail = InboundEmailSummary & {
  /** The address it was delivered to (the forwarding address for forwarded mail). */
  to: string;
  cc: string[];
  replyTo: string | null;
  /** Its Message-ID. To answer it, reply in its conversation. */
  messageId: string | null;
  references: string | null;
  text: string | null;
  html: string | null;
  /** Every header, names lowercased; a repeated header is an array. */
  headers: Record<string, string | string[]>;
  attachments: InboundEmailAttachment[];
};

export type ListInboundParams = {
  /** 1–100, default 25. */
  limit?: number;
  /** `nextCursor` from the previous page. */
  cursor?: string;
  /** Only email that came in on this mailbox (a sender address). */
  mailbox?: string;
  /** Only email from this address. */
  from?: string;
};

export type ListInboundResult = {
  data: InboundEmailSummary[];
  /** Pass as `cursor` for the next page; null on the last. */
  nextCursor: string | null;
};

/**
 * Email received at your mailboxes: senders forwarded to Zalify and reply
 * domains (Settings → Email → Receiving). Each new one is also an
 * `email.received` webhook event. Uses the same Send email key.
 */
export class Inbound {
  constructor(private readonly http: HttpConfig) {}

  /** Newest first. */
  async list(params: ListInboundParams = {}): Promise<ListInboundResult> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    const qs = query.toString();
    return request<ListInboundResult>(this.http, {
      method: "GET",
      path: `/email/inbound${qs ? `?${qs}` : ""}`,
    });
  }

  /** The whole email. Throws ZalifyError `not_found` for an unknown id. */
  async get(id: string): Promise<InboundEmail> {
    return request<InboundEmail>(this.http, {
      method: "GET",
      path: `/email/inbound/${encodeURIComponent(id)}`,
    });
  }

  /** An attachment's bytes and type. */
  async getAttachment(id: string, attachmentId: string): Promise<RawBody> {
    return request<RawBody>(this.http, {
      method: "GET",
      path: `/email/inbound/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,
      raw: true,
    });
  }
}

export class Emails {
  /** Email received at your mailboxes. */
  readonly inbound: Inbound;

  constructor(private readonly http: HttpConfig) {
    this.inbound = new Inbound(http);
  }

  /** Send one email. Throws ZalifyError when it isn't accepted. */
  async send(
    params: SendEmailParams,
    options: RequestOptions = {}
  ): Promise<SendEmailResult> {
    return request<SendEmailResult>(this.http, {
      method: "POST",
      path: "/email/send",
      body: toWire(params),
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
    });
  }

  /** The sender emails your workspace can send from, for `senderEmailId`. */
  async listSenders(): Promise<{ data: SenderEmail[] }> {
    return request<{ data: SenderEmail[] }>(this.http, {
      method: "GET",
      path: "/email/senders",
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
    const given = Array.isArray(params) ? { messages: params } : params;
    const body = { ...given, messages: given.messages.map(toWire) };
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
