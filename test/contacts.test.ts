import assert from "node:assert/strict";
import test from "node:test";
import { Zalify, ZalifyError } from "../src/index";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("upsert posts the contact and returns the result", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return json({
      id: "p1",
      email: "user@example.com",
      subscribed: true,
      lists: [{ id: "l1", status: "joined" }],
    });
  }) as unknown as typeof fetch;
  const zalify = new Zalify({ apiKey: "zalify_api_test", fetch: fetchImpl });

  const result = await zalify.contacts.upsert({
    email: "User@Example.com",
    subscribed: true,
    lists: ["l1"],
  });

  assert.equal(result.id, "p1");
  assert.equal(calls[0]?.url, "https://app.zalify.com/api/v1/contacts");
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    email: "User@Example.com",
    subscribed: true,
    lists: ["l1"],
  });
});

test("upsert retries 503 and surfaces list_not_found", async () => {
  const responses = [
    json({ error: "Temporarily unavailable", code: "unavailable" }, 503),
    json({ error: "List 'x' not found", code: "list_not_found" }, 404),
  ];
  const fetchImpl = (async () => responses.shift()) as unknown as typeof fetch;
  const zalify = new Zalify({
    apiKey: "zalify_api_test",
    fetch: fetchImpl,
    maxRetryDelayMs: 5,
  });

  await assert.rejects(
    zalify.contacts.upsert({ email: "a@example.com", lists: ["x"] }),
    (error: unknown) =>
      error instanceof ZalifyError &&
      error.code === "list_not_found" &&
      error.status === 404
  );
  assert.equal(responses.length, 0);
});
