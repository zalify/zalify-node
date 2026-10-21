import assert from "node:assert/strict";
import test from "node:test";
import { Zalify, ZalifyError } from "../src/index";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const header = (init: RequestInit | undefined, name: string) =>
  (init?.headers as Record<string, string> | undefined)?.[name];

test("track posts the event with an ISO time and no idempotency key", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return json(
      { id: "e1", profileId: "p1", duplicate: false, recordedOnly: false },
      202
    );
  }) as unknown as typeof fetch;
  const zalify = new Zalify({ apiKey: "zalify_api_test", fetch: fetchImpl });

  const result = await zalify.events.track({
    event: "Quiz Completed",
    customer: { externalId: "u_1", email: "a@example.com" },
    properties: { score: 82 },
    uniqueId: "quiz:1",
    time: new Date("2026-10-21T08:00:00Z"),
  });

  assert.deepEqual(result, {
    id: "e1",
    profileId: "p1",
    duplicate: false,
    recordedOnly: false,
  });
  assert.equal(calls[0]?.url, "https://app.zalify.com/api/v1/events");
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    event: "Quiz Completed",
    customer: { externalId: "u_1", email: "a@example.com" },
    properties: { score: 82 },
    uniqueId: "quiz:1",
    time: "2026-10-21T08:00:00.000Z",
  });
  assert.equal(header(calls[0]?.init, "Idempotency-Key"), undefined);
});

test("track fixes time once, so a 503 retry resends the same body", async () => {
  const bodies: string[] = [];
  const keys: Array<string | undefined> = [];
  const responses = [
    json({ error: "Temporarily unavailable", code: "unavailable" }, 503),
    json({ id: "e1", profileId: "p1", duplicate: false, recordedOnly: false }, 202),
  ];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    keys.push(header(init, "Idempotency-Key"));
    return responses.shift();
  }) as unknown as typeof fetch;
  const zalify = new Zalify({
    apiKey: "zalify_api_test",
    fetch: fetchImpl,
    maxRetryDelayMs: 5,
  });

  await zalify.events.track({ event: "Signed Up", customer: { email: "a@example.com" } });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.match(JSON.parse(bodies[0] ?? "{}").time, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(keys, [undefined, undefined]);
});

test("trackBatch fixes time once, so a 503 retry resends the same body", async () => {
  const bodies: string[] = [];
  const responses = [
    json({ error: "Temporarily unavailable", code: "unavailable" }, 503),
    json({ accepted: 2, duplicates: 0, failed: 0, results: [] }),
  ];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return responses.shift();
  }) as unknown as typeof fetch;
  const zalify = new Zalify({ apiKey: "zalify_api_test", fetch: fetchImpl, maxRetryDelayMs: 5 });

  await zalify.events.trackBatch([
    { event: "A", customer: { email: "a@example.com" } },
    { event: "B", customer: { email: "b@example.com" } },
  ]);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

test("daily_limit 429 is not retried", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return json({ error: "Daily event limit reached", code: "daily_limit" }, 429);
  }) as unknown as typeof fetch;
  const zalify = new Zalify({ apiKey: "zalify_api_test", fetch: fetchImpl, maxRetryDelayMs: 5 });

  await assert.rejects(
    zalify.events.track({ event: "X", customer: { email: "a@example.com" } }),
    (error: unknown) => error instanceof ZalifyError && error.code === "daily_limit"
  );
  assert.equal(calls, 1);
});

test("an invalid Date or an over-long key fails before any request", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return json({});
  }) as unknown as typeof fetch;
  const zalify = new Zalify({ apiKey: "zalify_api_test", fetch: fetchImpl });

  await assert.rejects(
    zalify.events.track({ event: "X", customer: { email: "a@example.com" }, time: new Date("nope") }),
    (error: unknown) =>
      error instanceof ZalifyError && error.code === "invalid_request" && error.field === "time"
  );
  await assert.rejects(
    zalify.events.trackBatch(
      [{ event: "X", customer: { email: "a@example.com" } }],
      { idempotencyKey: "k".repeat(252) }
    ),
    (error: unknown) => error instanceof ZalifyError && error.code === "invalid_request"
  );
  await assert.rejects(
    zalify.events.track(
      { event: "X", customer: { email: "a@example.com" } },
      { idempotencyKey: "k".repeat(256) }
    ),
    (error: unknown) => error instanceof ZalifyError && error.code === "invalid_request"
  );
  assert.equal(calls, 0);
});

test("track passes a caller's idempotency key through", async () => {
  let key: string | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    key = header(init, "Idempotency-Key");
    return json({ id: "e1", profileId: "p1", duplicate: true, recordedOnly: false }, 202);
  }) as unknown as typeof fetch;
  const zalify = new Zalify({ apiKey: "zalify_api_test", fetch: fetchImpl });

  const result = await zalify.events.track(
    { event: "Signed Up", customer: { email: "a@example.com" } },
    { idempotencyKey: "signup:42" }
  );
  assert.equal(key, "signup:42");
  assert.equal(result.duplicate, true);
});

test("trackBatch returns per-event results in order", async () => {
  let body: unknown;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    assert.equal(url, "https://app.zalify.com/api/v1/events/batch");
    body = JSON.parse(String(init.body));
    return json({
      accepted: 1,
      duplicates: 0,
      failed: 1,
      results: [
        { index: 0, status: "accepted", id: "e1", profileId: "p1", duplicate: false, recordedOnly: false },
        {
          index: 1,
          status: "error",
          error: { code: "reserved_event", message: "'shopify_order_paid' belongs to Shopify", field: "event" },
        },
      ],
    });
  }) as unknown as typeof fetch;
  const zalify = new Zalify({ apiKey: "zalify_api_test", fetch: fetchImpl });

  const result = await zalify.events.trackBatch([
    { event: "Booking Confirmed", customer: { email: "a@example.com" }, time: "2026-10-21T08:00:00Z" },
    { event: "shopify_order_paid", customer: { email: "b@example.com" } },
  ]);

  assert.deepEqual(body, {
    events: [
      { event: "Booking Confirmed", customer: { email: "a@example.com" }, time: "2026-10-21T08:00:00Z" },
      { event: "shopify_order_paid", customer: { email: "b@example.com" }, time: (body as { events: Array<{ time: string }> }).events[1]?.time },
    ],
  });
  assert.equal(result.failed, 1);
  const second = result.results[1];
  assert.equal(second?.status, "error");
  if (second?.status === "error") assert.equal(second.error.code, "reserved_event");
});

test("event errors carry code and field and are not retried", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return json(
      {
        error: "properties must be 64 KB or less",
        code: "invalid_event",
        details: { field: "properties" },
      },
      422
    );
  }) as unknown as typeof fetch;
  const zalify = new Zalify({ apiKey: "zalify_api_test", fetch: fetchImpl, maxRetryDelayMs: 5 });

  await assert.rejects(
    zalify.events.track({ event: "Big", customer: { email: "a@example.com" } }),
    (error: unknown) =>
      error instanceof ZalifyError &&
      error.code === "invalid_event" &&
      error.status === 422 &&
      error.field === "properties"
  );
  assert.equal(calls, 1);
});

test("413 payload_too_large is not retried", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return json({ error: "The request body must be 8 MB or less.", code: "payload_too_large" }, 413);
  }) as unknown as typeof fetch;
  const zalify = new Zalify({ apiKey: "zalify_api_test", fetch: fetchImpl, maxRetryDelayMs: 5 });

  await assert.rejects(
    zalify.events.trackBatch([{ event: "X", customer: { email: "a@example.com" } }]),
    (error: unknown) =>
      error instanceof ZalifyError && error.code === "payload_too_large" && !error.retryable
  );
  assert.equal(calls, 1);
});

test("catalog reads the event catalog", async () => {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    assert.equal(url, "https://app.zalify.com/api/v1/events/catalog");
    assert.equal(init.method, "GET");
    return json({
      events: [
        {
          name: "Quiz Completed",
          label: null,
          source: "custom",
          canTrigger: true,
          canExit: true,
          valuePath: null,
          properties: [{ path: "/score", type: "number", label: null, lastSeenAt: "2026-10-21T08:00:00Z" }],
          available: true,
          unavailableReason: null,
          lastSeenAt: "2026-10-21T08:00:00Z",
          eventCount: 3,
        },
      ],
    });
  }) as unknown as typeof fetch;
  const zalify = new Zalify({ apiKey: "zalify_api_test", fetch: fetchImpl });

  const { events } = await zalify.events.catalog();
  assert.equal(events[0]?.name, "Quiz Completed");
  assert.equal(events[0]?.properties[0]?.type, "number");
});
