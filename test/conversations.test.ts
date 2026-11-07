import assert from "node:assert/strict";
import test from "node:test";
import { Zalify, ZalifyError } from "../src/index";

type Call = { url: string; init: RequestInit };

const scripted = (responses: Response[]) => {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more scripted responses");
    return next;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const client = (fetchImpl: typeof fetch) =>
  new Zalify({ apiKey: "zalify_api_test", fetch: fetchImpl, maxRetryDelayMs: 5 });

const BASE = "https://app.zalify.com/api/v1";
const body = (call: Call | undefined) => JSON.parse(String(call?.init.body));
const header = (call: Call | undefined, name: string) =>
  new Headers(call?.init.headers).get(name);

test("create and reply send content only; idempotency keys go along", async () => {
  const { calls, fetchImpl } = scripted([
    json({ conversation: { id: "conv_1" }, message: { id: "m1" } }, 201),
    json({ conversation: { id: "conv_1" }, message: { id: "m2" } }, 201),
  ]);
  const zalify = client(fetchImpl);
  const { conversation } = await zalify.conversations.create(
    {
      inbox: "emma@zalify.com",
      contact: { email: "creator@example.com" },
      subject: "Collab",
      html: "<p>Hi</p>",
      externalId: "cc_1",
      attachments: [{ filename: "brief.pdf", content: Buffer.from("%PDF") }],
    },
    { idempotencyKey: "outreach:cc_1" }
  );
  await zalify.conversations.reply(conversation.id, { text: "Following up" });

  assert.equal(calls[0]?.url, `${BASE}/conversations`);
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(header(calls[0], "idempotency-key"), "outreach:cc_1");
  assert.equal(body(calls[0]).attachments[0].content, "JVBERg==");
  assert.equal(calls[1]?.url, `${BASE}/conversations/conv_1/messages`);
  assert.deepEqual(body(calls[1]), { text: "Following up" });
  assert.ok(header(calls[1], "idempotency-key"), "a key is made per call");
});

test("list, get, update, messages, import and inboxes hit their routes", async () => {
  const { calls, fetchImpl } = scripted([
    json({ data: [], nextCursor: null }),
    json({ id: "c 1" }),
    json({ id: "c 1", status: "closed" }),
    json({ data: [], nextCursor: null }),
    json({ id: "c2" }, 201),
    json({ data: [] }),
    new Response(new Uint8Array([7]), { headers: { "content-type": "image/png" } }),
  ]);
  const zalify = client(fetchImpl);
  await zalify.conversations.list({ externalId: "cc_1", status: "open" });
  await zalify.conversations.get("c 1");
  await zalify.conversations.update("c 1", { status: "closed", metadata: null });
  await zalify.conversations.messages.list("c 1", { limit: 50 });
  await zalify.conversations.import({
    inbox: "emma@zalify.com",
    contact: { email: "creator@example.com" },
    subject: "Re: Collab",
    messageIds: ["<g1@mail.gmail.com>"],
  });
  await zalify.inboxes.list();
  const file = await zalify.conversations.messages.getAttachment("c 1", "m1", "a1");

  assert.equal(calls[0]?.url, `${BASE}/conversations?externalId=cc_1&status=open`);
  assert.equal(calls[1]?.url, `${BASE}/conversations/c%201`);
  assert.equal(calls[2]?.init.method, "PATCH");
  assert.deepEqual(body(calls[2]), { status: "closed", metadata: null });
  assert.equal(calls[3]?.url, `${BASE}/conversations/c%201/messages?limit=50`);
  assert.equal(calls[4]?.url, `${BASE}/conversations/import`);
  assert.equal(calls[5]?.url, `${BASE}/inboxes`);
  assert.equal(calls[6]?.url, `${BASE}/conversations/c%201/messages/m1/attachments/a1`);
  assert.equal(file.contentType, "image/png");
});

test("a taken externalId surfaces as conversation_exists", async () => {
  const { fetchImpl } = scripted([
    json(
      {
        error: "A conversation with this externalId already exists.",
        code: "conversation_exists",
        details: { conversationId: "conv_9" },
      },
      409
    ),
  ]);
  await assert.rejects(
    client(fetchImpl).conversations.create({
      inbox: "emma@zalify.com",
      contact: { email: "a@example.com" },
      subject: "Hi",
      text: "Hi",
      externalId: "dup",
    }),
    (error: unknown) =>
      error instanceof ZalifyError && error.code === "conversation_exists" && error.status === 409
  );
});
