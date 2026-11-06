export { Zalify, type ZalifyOptions } from "./client";
export { ZalifyError, type ZalifyErrorCode } from "./errors";
export type {
  Contacts,
  UpsertContactParams,
  UpsertContactResult,
} from "./contacts";
export type {
  CatalogEvent,
  CatalogEventProperty,
  EventCatalog,
  EventCustomer,
  EventInput,
  Events,
  TrackBatchItem,
  TrackBatchResult,
  TrackEventResult,
  TrackOptions,
} from "./events";
export { threadHeaders } from "./emails";
export type {
  EmailAttachment,
  EmailMessage,
  EmailSender,
  EmailSendError,
  EmailType,
  SendBatchParams,
  SendBatchResult,
  SendEmailParams,
  SendEmailResult,
  SenderEmail,
  RequestOptions,
  Inbound,
  InboundEmail,
  InboundEmailAttachment,
  InboundEmailSummary,
  ListInboundParams,
  ListInboundResult,
} from "./emails";
export type { RawBody } from "./http";
export {
  verifyWebhook,
  Webhooks,
  WebhookVerificationError,
  type EmailWebhookEvent,
  type ReceivedWebhookEvent,
  type VerifyOptions,
  type WebhookEvent,
  type WebhookEventType,
} from "./webhooks";
