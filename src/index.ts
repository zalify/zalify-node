export { Zalify, type ZalifyOptions } from "./client";
export { ZalifyError, type ZalifyErrorCode } from "./errors";
export type {
  Contacts,
  UpsertContactParams,
  UpsertContactResult,
} from "./contacts";
export type {
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
} from "./emails";
export {
  verifyWebhook,
  Webhooks,
  WebhookVerificationError,
  type VerifyOptions,
  type WebhookEvent,
  type WebhookEventType,
} from "./webhooks";
