import { createHmac, timingSafeEqual } from "node:crypto";
import type { Conversation, ConversationMessage } from "./conversations";

/** Event types a Zalify webhook endpoint can receive. */
export type WebhookEventType =
  | "email.sent"
  | "email.failed"
  | "email.delivered"
  | "email.bounced"
  | "email.complained"
  | "email.opened"
  | "email.clicked"
  | "contact.unsubscribed"
  | "email.received"
  | "conversation.created"
  | "conversation.message.received"
  | "conversation.message.updated"
  | "conversation.updated";

/** What happened to an email you sent through the Email API. */
export type EmailWebhookEvent = {
  /** Stable across retries: use it to drop duplicates. */
  id: string;
  type: Exclude<
    WebhookEventType,
    "email.received" | ConversationWebhookEvent["type"]
  >;
  created_at: string;
  data: {
    /** The `id` returned when the email was sent. */
    email_id: string;
    to: string;
    /** The tags sent with the email. */
    tags: Record<string, string>;
    /** email.sent: the Message-ID the recipient sees. */
    message_id?: string;
    /** email.failed: why it wasn't sent. */
    reason?: string;
    /** email.bounced: `hard` (permanent — stop sending) or `soft`. */
    bounce_type?: "hard" | "soft" | (string & {});
    /** email.clicked: the link that was clicked. */
    url?: string;
  };
};

/** An email arrived at one of your mailboxes. */
export type ReceivedWebhookEvent = {
  id: string;
  type: "email.received";
  created_at: string;
  data: {
    /** Fetch the whole email with `emails.inbound.get(inbound_id)`. */
    inbound_id: string;
    /** The `email_id` of your email it replies to, when it answers one. */
    in_reply_to_email_id: string | null;
    /** The mailbox it came in on, e.g. support@brand.com. */
    mailbox: string;
    from: string;
    subject: string;
    /** The start of the text body. */
    preview: string;
  };
};

/**
 * A conversation started, a message came in (any channel), a sent message's
 * delivery moved on, or a conversation's status or metadata changed.
 * `message.html` is left out; read it with `conversations.messages.list`.
 */
export type ConversationWebhookEvent = {
  id: string;
  type:
    | "conversation.created"
    | "conversation.message.received"
    | "conversation.message.updated"
    | "conversation.updated";
  created_at: string;
  data: {
    conversation: Conversation;
    message?: ConversationMessage;
  };
};

export type WebhookEvent =
  | EmailWebhookEvent
  | ReceivedWebhookEvent
  | ConversationWebhookEvent;

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

type HeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>;

const header = (headers: HeaderSource, name: string): string | undefined => {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  const value = key ? record[key] : undefined;
  return Array.isArray(value) ? value[0] : value;
};

export type VerifyOptions = {
  /** Reject events whose timestamp is further than this from now. Default 300 s. */
  toleranceSeconds?: number;
  /** For tests. */
  now?: () => number;
};

/**
 * Verify a webhook request from Zalify and return its event. Pass the raw
 * request body (string or Buffer, exactly as received — not re-serialized
 * JSON), the request headers and your endpoint's `whsec_…` signing secret.
 * Throws WebhookVerificationError when the signature or timestamp is off.
 *
 * Zalify signs per the Standard Webhooks spec (https://www.standardwebhooks.com).
 */
export function verifyWebhook(
  payload: string | Uint8Array,
  headers: HeaderSource,
  secret: string,
  options: VerifyOptions = {}
): WebhookEvent {
  const id = header(headers, "webhook-id");
  const timestamp = header(headers, "webhook-timestamp");
  const signatures = header(headers, "webhook-signature");
  if (!id || !timestamp || !signatures) {
    throw new WebhookVerificationError("Missing webhook-id, webhook-timestamp or webhook-signature header");
  }
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds)) {
    throw new WebhookVerificationError("Invalid webhook-timestamp");
  }
  const tolerance = options.toleranceSeconds ?? 300;
  const now = Math.floor((options.now ?? Date.now)() / 1000);
  if (Math.abs(now - seconds) > tolerance) {
    throw new WebhookVerificationError("Webhook timestamp is too old or in the future");
  }

  const body =
    typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
  const key = Buffer.from(
    secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret,
    "base64"
  );
  const expected = createHmac("sha256", key)
    .update(`${id}.${seconds}.${body}`)
    .digest();
  const matches = signatures.split(" ").some((entry) => {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matches) {
    throw new WebhookVerificationError("Webhook signature does not match");
  }

  try {
    return JSON.parse(body) as WebhookEvent;
  } catch {
    throw new WebhookVerificationError("Webhook body is not JSON");
  }
}

export class Webhooks {
  constructor(private readonly secret?: string) {}

  /** `verifyWebhook` with the client's `webhookSecret` (or `ZALIFY_WEBHOOK_SECRET`). */
  verify(
    payload: string | Uint8Array,
    headers: HeaderSource,
    options: VerifyOptions & { secret?: string } = {}
  ): WebhookEvent {
    const secret =
      options.secret ??
      this.secret ??
      (typeof process !== "undefined" ? process.env.ZALIFY_WEBHOOK_SECRET : undefined);
    if (!secret) {
      throw new WebhookVerificationError(
        "Missing webhook secret: pass webhookSecret to new Zalify() or set ZALIFY_WEBHOOK_SECRET."
      );
    }
    return verifyWebhook(payload, headers, secret, options);
  }
}
