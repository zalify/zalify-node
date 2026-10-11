import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyWebhook, WebhookVerificationError, Zalify } from "../src/index";

test("verifies the Standard Webhooks reference vector", () => {
  // https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
  const body = '{"test": 2432232314}';
  const headers = {
    "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
    "webhook-timestamp": "1614265330",
    "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
  };
  const now = () => 1614265330 * 1000;
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  assert.deepEqual(verifyWebhook(body, headers, secret, { now }), {
    test: 2432232314,
  });
  assert.throws(
    () => verifyWebhook(`${body} `, headers, secret, { now }),
    WebhookVerificationError
  );
  assert.throws(
    () => verifyWebhook(body, headers, secret, { now: () => (1614265330 + 301) * 1000 }),
    /too old/
  );
  assert.throws(
    () => verifyWebhook(body, { "webhook-id": "x" }, secret, { now }),
    /Missing/
  );
});

test("accepts Headers, Buffers and the client's secret", () => {
  const secret = `whsec_${Buffer.from("k".repeat(32)).toString("base64")}`;
  const event = {
    id: "evt_1",
    type: "email.delivered",
    created_at: "2026-10-11T10:00:00Z",
    data: { email_id: "m1", to: "a@b.c", tags: {} },
  };
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", Buffer.from("k".repeat(32)))
    .update(`evt_1.${ts}.${body}`)
    .digest("base64");
  const headers = new Headers({
    "webhook-id": "evt_1",
    "webhook-timestamp": String(ts),
    "webhook-signature": `v1,${sig}`,
  });
  const zalify = new Zalify({ apiKey: "k", webhookSecret: secret });
  assert.deepEqual(zalify.webhooks.verify(Buffer.from(body), headers), event);
  assert.equal(verifyWebhook(body, headers, secret).type, "email.delivered");
});
