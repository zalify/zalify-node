import assert from "node:assert/strict";
import test from "node:test";
import { Zalify, ZalifyError } from "../src/index";

type Call = { url: string; init: RequestInit };

/** A fetch that answers from a script of responses and records every call. */
const scripted = (responses: Array<Response | Error>) => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more scripted responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const header = (call: Call | undefined, name: string) =>
  new Headers(call?.init.headers).get(name);

const message = {
  from: "Makase <notifications@makase.im>",
  to: "user@example.com",
  subject: "Reset your password",
  html: "<p>Hi</p>",
};

const client = (fetchImpl: typeof fetch, extra = {}) =>
  new Zalify({
    apiKey: "zalify_api_test",
    fetch: fetchImpl,
    maxRetryDelayMs: 5,
    ...extra,
  });

test("send posts the message with the key and an idempotency key", async () => {
  const { calls, fetchImpl } = scripted([json({ id: "msg_1" })]);
  const result = await client(fetchImpl).emails.send(
    { ...message, tags: { kind: "reset" } },
    { idempotencyKey: "reset:42" }
  );

  assert.deepEqual(result, { id: "msg_1" });
  assert.equal(calls[0]?.url, "https://app.zalify.com/api/v1/email/send");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(header(calls[0], "authorization"), "Bearer zalify_api_test");
  assert.equal(header(calls[0], "idempotency-key"), "reset:42");
  assert.match(header(calls[0], "user-agent") ?? "", /^zalify-node\//);
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    ...message,
    tags: { kind: "reset" },
  });
});

test("retries 503 and network errors with the same idempotency key", async () => {
  const { calls, fetchImpl } = scripted([
    json({ error: "down", code: "unavailable" }, 503),
    new TypeError("fetch failed"),
    json({ id: "msg_2" }),
  ]);
  const result = await client(fetchImpl).emails.send(message);

  assert.deepEqual(result, { id: "msg_2" });
  assert.equal(calls.length, 3);
  const keys = calls.map((call) => header(call, "idempotency-key"));
  assert.ok(keys[0], "a key is generated when none is given");
  assert.equal(new Set(keys).size, 1, "every retry reuses it");
});

test("a 4xx is thrown at once with its code and details", async () => {
  const { calls, fetchImpl } = scripted([
    json(
      {
        error: "Invalid request",
        code: "invalid_request",
        details: ["to: Invalid email address"],
      },
      400
    ),
  ]);
  await assert.rejects(
    client(fetchImpl).emails.send(message),
    (error: unknown) =>
      error instanceof ZalifyError &&
      error.code === "invalid_request" &&
      error.status === 400 &&
      error.details?.[0] === "to: Invalid email address" &&
      !error.retryable
  );
  assert.equal(calls.length, 1);
});

test("a Retry-After longer than the SDK will wait is handed back, not slept on", async () => {
  const { calls, fetchImpl } = scripted([
    json({ error: "slow down", code: "rate_limited" }, 429, {
      "retry-after": "60",
    }),
  ]);
  await assert.rejects(
    client(fetchImpl).emails.send(message),
    (error: unknown) =>
      error instanceof ZalifyError &&
      error.code === "rate_limited" &&
      error.retryAfter === 60
  );
  assert.equal(calls.length, 1);
});

test("gives up after maxRetries", async () => {
  const { calls, fetchImpl } = scripted([
    json({ error: "down", code: "unavailable" }, 503),
    json({ error: "down", code: "unavailable" }, 503),
  ]);
  await assert.rejects(
    client(fetchImpl, { maxRetries: 1 }).emails.send(message),
    (error: unknown) => error instanceof ZalifyError && error.code === "unavailable"
  );
  assert.equal(calls.length, 2);
});

test("sendBatch takes an array or {type, messages} and returns per-message results", async () => {
  const data = [
    { id: "m0" },
    { error: { code: "unverified_sender", message: "not verified" } },
  ];
  const { calls, fetchImpl } = scripted([json({ data }), json({ data })]);
  const zalify = client(fetchImpl);

  assert.deepEqual(await zalify.emails.sendBatch([message, message]), { data });
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    messages: [message, message],
  });
  await zalify.emails.sendBatch({ type: "marketing", messages: [message] });
  assert.equal(calls[1]?.url, "https://app.zalify.com/api/v1/email/send/batch");
  assert.equal(JSON.parse(String(calls[1]?.init.body)).type, "marketing");

  await assert.rejects(zalify.emails.sendBatch([]), /1 to 100/);
  await assert.rejects(
    zalify.emails.sendBatch(Array.from({ length: 101 }, () => message)),
    /1 to 100/
  );
});

test("the key comes from the constructor or ZALIFY_API_KEY", () => {
  const saved = process.env.ZALIFY_API_KEY;
  try {
    delete process.env.ZALIFY_API_KEY;
    assert.throws(() => new Zalify(), /Missing Zalify API key/);
    process.env.ZALIFY_API_KEY = "zalify_api_env";
    assert.ok(new Zalify());
    assert.ok(new Zalify("zalify_api_arg"));
  } finally {
    if (saved === undefined) delete process.env.ZALIFY_API_KEY;
    else process.env.ZALIFY_API_KEY = saved;
  }
});

test("a custom baseUrl is used without a trailing slash", async () => {
  const { calls, fetchImpl } = scripted([json({ id: "x" })]);
  await client(fetchImpl, { baseUrl: "http://localhost:3000/api/v1/" }).emails.send(
    message
  );
  assert.equal(calls[0]?.url, "http://localhost:3000/api/v1/email/send");
});
