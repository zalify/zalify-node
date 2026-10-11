export { Zalify, type ZalifyOptions } from "./client";
export { ZalifyError, type ZalifyErrorCode } from "./errors";
export type {
  EmailMessage,
  EmailSendError,
  EmailType,
  SendBatchParams,
  SendBatchResult,
  SendEmailParams,
  SendEmailResult,
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
