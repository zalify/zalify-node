# @zalify/sdk

The official Node.js / TypeScript SDK for the [Zalify](https://zalify.com) API.

It sends transactional and marketing email from your own domains through Zalify, keeps contacts in sync, and records your own events for automations, with retries, idempotency, and typed errors. It has no runtime dependencies and needs Node 18+ (or any runtime with `fetch`).

```bash
npm install @zalify/sdk
```

## Before you start

1. In your Zalify workspace, go to **Settings → Email** and add a sending domain, then publish the DNS records it shows (DKIM TXT + MAIL FROM CNAME). Add a `_dmarc` TXT too (`v=DMARC1; p=none` to start).
2. In **Settings → Developer**, create an API key and tick **Send email** (**Manage contacts** to add contacts, **Track events** to record events). A key can only do what it was created with.
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
- Each day your workspace can email a limited number of addresses it has never emailed before. New workspaces start at 1,000 a day for transactional mail and 500 for marketing. The limit doubles after each day with low bounce and complaint rates, and goes away once it reaches 50,000. Over the limit, sends fail with `new_recipient_limit` (marketing waits until the next day). People you've emailed before are never limited.

### Send from a sender set up in Zalify

Instead of `from`, pass `senderEmailId`: a sender email from **Settings → Email**. Its name, address and Reply-To are used (your `replyTo` still wins), so they're managed in Zalify rather than in your code.

```ts
const { data: senders } = await zalify.emails.listSenders();
// [{ id, name, email, replyTo, verified }]

await zalify.emails.send(
  { senderEmailId: process.env.ZALIFY_SENDER_EMAIL_ID, to, subject, html },
  { idempotencyKey: `reset:${tokenId}` }
);
```

A message takes `from` or `senderEmailId`, not both. A sender that isn't in your workspace or isn't verified yet fails with `unverified_sender`.

## Send a batch

Send up to 100 messages in one request. A refused message doesn't fail the others.

```ts
const { data } = await zalify.emails.sendBatch(messages);
for (const [i, result] of data.entries()) {
  if ("error" in result) console.warn(messages[i].to, result.error.code);
}
```

## Contacts

Create or update a contact by email, e.g. when someone signs up. The key needs the **Manage contacts** permission.

```ts
const contact = await zalify.contacts.upsert({
  email: "user@example.com",
  firstName: "Ada",
  properties: { plan: "pro" },
  subscribed: true, // they ticked "send me product updates"
  lists: [PRODUCT_UPDATES_LIST_ID],
});
// { id, email, subscribed: true, lists: [{ id, status: "joined" }] }
```

- `subscribed: true` subscribes the contact to marketing email, `false` unsubscribes, and leaving it out keeps what's there. It's taken as given, so only send `true` for people who opted in. New senders start with a small daily volume that grows while bounces and complaints stay low.
- Marketing email (`type: "marketing"`) only reaches subscribed contacts.
- Contacts are matched by email. A phone that already belongs to another contact isn't attached (`phoneSkipped: true`).
- Adding a contact to a list can start that list's automations, such as a welcome series.
- Calls are safe to retry; the same email updates the same contact.

## Events

Record what people do in your product, e.g. a finished quiz or a confirmed booking, so automations can start on it, filter on its properties and stop on it. The key needs the **Track events** permission (记录事件).

```ts
await zalify.events.track({
  event: "Quiz Completed",
  customer: { externalId: user.id, email: user.email },
  properties: { result: "dry skin", score: 82 },
  uniqueId: `quiz:${attempt.id}`,
});
// { id, profileId, duplicate: false, recordedOnly: false }
```

- Any name works and needs no setup: the first time an event arrives it appears in the automation editor, with its properties. Names an integration owns (`shopify_*`, `zalify.*`) are refused (`reserved_event`).
- The person is found by `externalId`, then `email`, then `phone`. Someone new is created as a contact **without** a subscription, so an event never makes anyone marketable.
- Give each event a `uniqueId`: the same id is recorded once, however often you send it. `duplicate: true` means it was already recorded, by an earlier call or by an earlier attempt of this one that the SDK retried.
- Without a `uniqueId`, the API dedupes on the event's content (name, person, `time`, properties). The SDK sets `time` before the first attempt, so its own retries can't record an event twice.
- `time` defaults to now and may be up to 365 days back. Events more than 24 hours old are recorded but never start or end an automation (`recordedOnly: true`), so importing history won't email anyone.
- `properties` is any JSON object up to 64 KB. Automations compare a field the way the condition asks (`82` and `"82"` are the same to "at least 80"), so changing a field's type doesn't break them.

Send up to 100 at once; each event succeeds or fails on its own:

```ts
const { accepted, failed, results } = await zalify.events.trackBatch([
  { event: "Booking Confirmed", customer: { email: "a@example.com" }, uniqueId: "booking:1" },
  { event: "Booking Confirmed", customer: { email: "b@example.com" }, uniqueId: "booking:2" },
]);
for (const item of results) {
  if (item.status === "error") console.warn(item.index, item.error.code, item.error.message);
}
```

List the events your automations can use:

```ts
const { events } = await zalify.events.catalog();
// [{ name: "Quiz Completed", source: "custom", canTrigger: true, properties: [{ path: "/score", type: "number", … }], … }]
```

A batch counts as one request against the key's limit of 120 requests a minute, and a workspace can record up to 1,000,000 events a day (`daily_limit`).

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
| `missing_scope` | 403 | the key lacks the permission: **Send email**, **Manage contacts** or **Track events** |
| `email_not_enabled` | 403 | the workspace has no sending set up yet |
| `contacts_not_enabled` | 403 | the workspace has no contacts set up yet |
| `list_not_found` | 404 | a list in `lists` isn't in your workspace (nothing was written) |
| `usage_paused` | 403 | email sending is paused for the workspace (plan or balance) |
| `invalid_request` | 400 | the body doesn't match the schema (see `details`) |
| `unverified_sender` | 422 | the from address isn't on a verified domain |
| `not_subscribed` | 422 | a marketing recipient isn't a subscribed contact |
| `idempotency_conflict` | 409 | the idempotency key was used for a different request |
| `rate_limited` | 429 | over 120 requests a minute for this key (a batch counts once) |
| `new_recipient_limit` | 429 | the recipient is new to your workspace and today's allowance of new recipients is used; it resets at 00:00 UTC (`retryAfter`) |
| `invalid_event` | 422 | an event was refused, e.g. properties over 64 KB or `time` out of range (see `field`) |
| `reserved_event` | 422 | the event name belongs to an integration (`shopify_*`, `zalify.*`, …) |
| `payload_too_large` | 413 | the body is over 2 MB (one event) or 8 MB (a batch); not retried |
| `daily_limit` | 429 | the workspace recorded 1,000,000 events today (UTC) |
| `unavailable` | 503 | temporary; safe to retry with the same idempotency key |

The SDK retries `rate_limited`, `unavailable`, `idempotency_in_progress`, timeouts and network errors on its own, up to `maxRetries` (default 3). It honors `Retry-After`, and won't wait longer than `maxRetryDelayMs` (default 10 s). Retries always reuse the request's idempotency key, so they never send twice.

For events, give each one a `uniqueId` rather than an `idempotencyKey`. If you do pass an `idempotencyKey` to `track`/`trackBatch`, use a new one for every call: events without a `uniqueId` take `<key>` (or `<key>:<index>` in a batch) as their dedupe key, so reusing a key across different batches makes the later ones come back as duplicates without being recorded.

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

- Listing contacts and lists; batch upsert
- A sandbox key that renders without delivering

API reference: https://app.zalify.com/api/v1/reference

## License

MIT
