# @zalify/sdk

The official Node.js / TypeScript SDK for the [Zalify](https://zalify.com) API.

It sends transactional and marketing email from your own domains through Zalify, with retries, idempotency, and typed errors. It has no runtime dependencies and needs Node 18+ (or any runtime with `fetch`).

```bash
npm install @zalify/sdk
```

## Before you start

1. In your Zalify workspace, go to **Settings → Email** and add a sending domain, then publish the DNS records it shows (DKIM TXT + MAIL FROM CNAME). Add a `_dmarc` TXT too (`v=DMARC1; p=none` to start).
2. In **Settings → Developer**, create an API key and tick **Send email**. Keys without it can't send.
3. Keep the key on your server, e.g. in `ZALIFY_API_KEY`. Never ship it to a browser.

## Send an email

```ts
import { Zalify } from "@zalify/sdk";

const zalify = new Zalify(process.env.ZALIFY_API_KEY);

const { id } = await zalify.emails.send(
  {
    from: "Acme <notifications@acme.com>",
    to: "user@example.com",
    replyTo: "support@acme.com",
    subject: "Reset your password",
    html: "<p>…</p>",
    text: "…",
    tags: { kind: "password_reset" },
  },
  { idempotencyKey: `reset:${tokenId}` }
);
```

- `type` defaults to `"transactional"`: delivered at once, no unsubscribe link. Use `type: "marketing"` for newsletters and announcements. They get an unsubscribe link and headers, and only reach recipients who are subscribed contacts in your workspace.
- `to` is one address. Send one message per recipient, or use a batch.
- A recipient on your suppression list (an earlier hard bounce or spam complaint) still gets an `id`, but the message is not delivered.

## Send a batch

Send up to 100 messages in one request. A refused message doesn't fail the others.

```ts
const { data } = await zalify.emails.sendBatch(messages);
for (const [i, result] of data.entries()) {
  if ("error" in result) console.warn(messages[i].to, result.error.code);
}
```

## Errors, retries and idempotency

Every failure is a `ZalifyError` with a stable `code`, the HTTP `status`, and `details` for validation errors.

```ts
import { ZalifyError } from "@zalify/sdk";

try {
  await zalify.emails.send(message);
} catch (error) {
  if (error instanceof ZalifyError && error.code === "unverified_sender") {
    // The from address isn't on a verified domain.
  }
  throw error;
}
```

| code | status | meaning |
| --- | --- | --- |
| `unauthorized` | 401 | missing or invalid API key |
| `missing_scope` | 403 | the key wasn't created with **Send email** |
| `email_not_enabled` | 403 | the workspace has no sending set up yet |
| `usage_paused` | 403 | email sending is paused for the workspace (plan or balance) |
| `invalid_request` | 400 | the body doesn't match the schema (see `details`) |
| `unverified_sender` | 422 | the from address isn't on a verified domain |
| `not_subscribed` | 422 | a marketing recipient isn't a subscribed contact |
| `idempotency_conflict` | 409 | the idempotency key was used for a different request |
| `rate_limited` | 429 | over 120 requests a minute for this key (a batch counts once) |
| `unavailable` | 503 | temporary; safe to retry with the same idempotency key |

The SDK retries `rate_limited`, `unavailable`, `idempotency_in_progress`, timeouts and network errors on its own, up to `maxRetries` (default 3). It honors `Retry-After`, and won't wait longer than `maxRetryDelayMs` (default 10 s). Retries always reuse the request's idempotency key, so they never send twice.

Pass your own `idempotencyKey` per logical email, such as `reset:${tokenId}` or `invite:${inviteId}`. Then even retrying the whole call after a crash or deploy sends once. Without one, the SDK makes a key per call, which only covers its own retries.

## Options

```ts
new Zalify({
  apiKey: "zalify_api_…",                   // default: process.env.ZALIFY_API_KEY
  baseUrl: "https://app.zalify.com/api/v1", // default
  maxRetries: 3,
  timeoutMs: 30_000,                        // per attempt
  maxRetryDelayMs: 10_000,
  fetch: customFetch,                       // optional
});
```

## Webhooks

Add an endpoint in **Settings → Developer → Webhooks** to get events for email sent through the API:

- `email.sent`
- `email.delivered`
- `email.bounced`, with `bounce_type` `hard` or `soft`
- `email.complained`
- `email.opened`
- `email.clicked`, with `url`
- `contact.unsubscribed`

The signing secret (`whsec_…`) is shown once, when you create the endpoint.

Verify every request against the **raw** body before trusting it:

```ts
import express from "express";
import { verifyWebhook, WebhookVerificationError } from "@zalify/sdk";

app.post("/webhooks/zalify", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = verifyWebhook(req.body, req.headers, process.env.ZALIFY_WEBHOOK_SECRET!);
  } catch (error) {
    if (error instanceof WebhookVerificationError) return res.status(400).end();
    throw error;
  }
  if (event.type === "email.bounced" && event.data.bounce_type === "hard") {
    // stop emailing event.data.to
  }
  res.status(204).end();
});
```

In a Next.js route handler: `verifyWebhook(await req.text(), req.headers, secret)`. Or construct the client with `new Zalify({ webhookSecret })` and call `zalify.webhooks.verify(body, headers)`.

- Requests follow the [Standard Webhooks](https://www.standardwebhooks.com) spec.
- `webhook-id` stays the same across retries, so use it to drop duplicates.
- Answer `2xx` within 10 s. Failed deliveries are retried for about 13 hours.
- Events can arrive out of order.

## Coming from Resend or Postmark

The send call takes the same shape as Resend's `emails.send`. The differences:

- `to` is a single address.
- `replyTo` is a single address.
- `tags` is an object, not an array.

For Postmark, map `From`/`To`/`Subject`/`HtmlBody`/`TextBody`/`ReplyTo` to `from`/`to`/`subject`/`html`/`text`/`replyTo`. Message streams become `type`: `transactional` or `marketing`.

## Roadmap

- Contacts and lists
- A sandbox key that renders without delivering

API reference: https://app.zalify.com/api/v1/reference

## License

MIT
