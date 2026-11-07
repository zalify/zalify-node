import { randomUUID } from "node:crypto";
import type { EmailAttachment, EmailType, RequestOptions } from "./emails";
import { type HttpConfig, type RawBody, request } from "./http";

/** Channels a conversation can use. Email today; SMS and WhatsApp next. */
export type Channel = "email";

/** Your side of conversations: one per sender email, plus receive-only reply domains. */
export type Inbox = {
  id: string;
  name: string;
  email: string;
  /** False for a receive-only address. */
  canSend: boolean;
};

export type ConversationChannel = {
  channel: Channel;
  /** The inbox's address on this channel. */
  address: string;
  /** The other party's address: where replies go. */
  contact: string;
  sendable: boolean;
  /** Why it can't send, when it can't. */
  reason: string | null;
};

export type Conversation = {
  id: string;
  inboxId: string;
  inbox: Inbox;
  status: "open" | "closed";
  subject: string;
  contact: { email: string | null };
  /** Your own id for what it's about; unique in the workspace. */
  externalId: string | null;
  metadata: Record<string, unknown> | null;
  /** The channel the contact last wrote on; replies default to it. */
  lastChannel: Channel | (string & {});
  channels: ConversationChannel[];
  lastMessageAt: string;
  lastInboundAt: string | null;
  createdAt: string;
};

export type ConversationAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
};

export type MessageStatus =
  | "queued"
  | "sent"
  | "delayed"
  | "delivered"
  | "opened"
  | "bounced"
  | "complained"
  | "failed"
  | "received";

export type ConversationMessage = {
  id: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  channel: Channel | (string & {});
  from: string;
  to: string;
  text: string | null;
  /** Null in webhook events; read it with `messages.list`. */
  html: string | null;
  /** Inbound email: what they wrote this time, without the quoted thread. */
  textWithoutQuote: string | null;
  attachments: ConversationAttachment[];
  status: MessageStatus | (string & {});
  statusAt: string | null;
  /** The bounce type, or why it failed. */
  statusDetail: string | null;
  email?: { subject: string; messageId: string | null };
  createdAt: string;
};

/** Give `text` or `html` (or both); text alone is sent as simple HTML too. */
export type MessageContent = {
  text?: string;
  html?: string;
  /** Up to 10 files, 10 MB together. */
  attachments?: EmailAttachment[];
};

export type CreateConversationParams = MessageContent & {
  /** An inbox id, or its email address (e.g. `emma@brand.com`). */
  inbox: string;
  contact: { email: string };
  channel?: Channel;
  subject: string;
  /** Your own id for what it's about, e.g. a campaign-creator id. */
  externalId?: string;
  /** Your JSON, up to 8 KB. */
  metadata?: Record<string, unknown>;
  /** Default `transactional`. */
  type?: EmailType;
};

export type ReplyParams = MessageContent & {
  /** Defaults to the channel the contact last wrote on. */
  channel?: Channel;
};

export type ListConversationsParams = {
  /** An inbox id or address. */
  inbox?: string;
  status?: "open" | "closed";
  /** The contact's email address. */
  contact?: string;
  externalId?: string;
  /** 1–100, default 25. */
  limit?: number;
  cursor?: string;
};

export type UpdateConversationParams = {
  status?: "open" | "closed";
  /** Null clears it. */
  externalId?: string | null;
  /** Replaces it; null clears it. */
  metadata?: Record<string, unknown> | null;
};

export type ImportConversationParams = {
  inbox: string;
  contact: { email: string };
  subject: string;
  /** The thread's Message-IDs, oldest first, with angle brackets (up to 50). */
  messageIds: string[];
  lastMessageAt?: string;
  externalId?: string;
  metadata?: Record<string, unknown>;
};

export type Page<T> = {
  data: T[];
  /** Pass as `cursor` for the next page; null on the last. */
  nextCursor: string | null;
};

export type ConversationWithMessage = {
  conversation: Conversation;
  message: ConversationMessage;
};

const toBase64 = (content: Uint8Array | string) =>
  typeof content === "string"
    ? content
    : Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString(
        "base64"
      );

const toWire = <T extends MessageContent>(params: T): T =>
  params.attachments
    ? {
        ...params,
        attachments: params.attachments.map((file) => ({
          ...file,
          content: toBase64(file.content),
        })),
      }
    : params;

const query = (params: Record<string, unknown>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
};

const path = (id: string) => `/conversations/${encodeURIComponent(id)}`;

/** A conversation's messages. */
export class Messages {
  constructor(private readonly http: HttpConfig) {}

  /** Oldest first, every channel together. */
  async list(
    conversationId: string,
    params: { limit?: number; cursor?: string } = {}
  ): Promise<Page<ConversationMessage>> {
    return request<Page<ConversationMessage>>(this.http, {
      method: "GET",
      path: `${path(conversationId)}/messages${query(params)}`,
    });
  }

  /** A received attachment's bytes and type. */
  async getAttachment(
    conversationId: string,
    messageId: string,
    attachmentId: string
  ): Promise<RawBody> {
    return request<RawBody>(this.http, {
      method: "GET",
      path: `${path(conversationId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      raw: true,
    });
  }
}

/**
 * Two-way exchanges with one person. Start one, reply in it; what comes back
 * arrives as `conversation.message.received` webhook events. Zalify fills in
 * the sender, recipient, subject and thread headers. Needs a key with the
 * Conversations permission.
 */
export class Conversations {
  readonly messages: Messages;

  constructor(private readonly http: HttpConfig) {
    this.messages = new Messages(http);
  }

  /** Start a conversation with its first message. */
  async create(
    params: CreateConversationParams,
    options: RequestOptions = {}
  ): Promise<ConversationWithMessage> {
    return request<ConversationWithMessage>(this.http, {
      method: "POST",
      path: "/conversations",
      body: toWire(params),
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
    });
  }

  /**
   * Reply, or follow up before they answer. Goes to the contact, from the
   * conversation's inbox, threaded under its newest message.
   */
  async reply(
    conversationId: string,
    params: ReplyParams,
    options: RequestOptions = {}
  ): Promise<ConversationWithMessage> {
    return request<ConversationWithMessage>(this.http, {
      method: "POST",
      path: `${path(conversationId)}/messages`,
      body: toWire(params),
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
    });
  }

  /** Newest activity first. */
  async list(params: ListConversationsParams = {}): Promise<Page<Conversation>> {
    return request<Page<Conversation>>(this.http, {
      method: "GET",
      path: `/conversations${query(params)}`,
    });
  }

  /** Throws ZalifyError `not_found` for an unknown id. */
  async get(conversationId: string): Promise<Conversation> {
    return request<Conversation>(this.http, {
      method: "GET",
      path: path(conversationId),
    });
  }

  /** Close or reopen it, or change its externalId or metadata. */
  async update(
    conversationId: string,
    params: UpdateConversationParams
  ): Promise<Conversation> {
    return request<Conversation>(this.http, {
      method: "PATCH",
      path: path(conversationId),
      body: params,
    });
  }

  /**
   * Bring over a thread that started with another mailbox provider, so your
   * next reply continues it and its replies come back here.
   */
  async import(params: ImportConversationParams): Promise<Conversation> {
    return request<Conversation>(this.http, {
      method: "POST",
      path: "/conversations/import",
      body: params,
    });
  }
}

/** Where conversations happen. */
export class Inboxes {
  constructor(private readonly http: HttpConfig) {}

  async list(): Promise<{ data: Inbox[] }> {
    return request<{ data: Inbox[] }>(this.http, {
      method: "GET",
      path: "/inboxes",
    });
  }
}
