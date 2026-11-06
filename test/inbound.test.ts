import assert from "node:assert/strict";
import test from "node:test";
import { threadHeaders, Zalify, ZalifyError } from "../src/index";

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

test("attachments go out base64-encoded, with thread headers", async () => {
  const { calls, fetchImpl } = scripted([json({ id: "msg_1" })]);
  await client(fetchImpl).emails.send({
    from: "Emma <emma@zalify.com>",
    to: "creator@gmail.com",
    subject: "Re: Collab",
    html: "<p>Brief attached</p>",
    headers: threadHeaders({ messageId: "<a@email.amazonses.com>" }),
    attachments: [
      { filename: "brief.pdf", content: Buffer.from("%PDF"), contentType: "application/pdf" },
      { filename: "note.txt", content: "aGk=" },
    ],
  });
  const body = JSON.parse(String(calls[0]?.init.body));
  assert.deepEqual(body.headers, {
    "In-Reply-To": "<a@email.amazonses.com>",
    References: "<a@email.amazonses.com>",
  });
  assert.deepEqual(body.attachments, [
    { filename: "brief.pdf", content: "JVBERg==", contentType: "application/pdf" },
    { filename: "note.txt", content: "aGk=" },
  ]);
});

test("threadHeaders extends References and keeps root plus newest", () => {
  assert.deepEqual(
    threadHeaders({ messageId: "<c@x>", references: "<a@x> <b@x>" }),
    { "In-Reply-To": "<c@x>", References: "<a@x> <b@x> <c@x>" }
  );
  const ids = Array.from({ length: 20 }, (_, i) => `<m${i}@x>`).join(" ");
  const refs = threadHeaders({ messageId: "<last@x>", references: ids }).References.split(" ");
  assert.equal(refs.length, 10);
  assert.equal(refs[0], "<m0@x>");
  assert.equal(refs.at(-2), "<m19@x>");
  assert.throws(() => threadHeaders({ messageId: "nope" }), ZalifyError);
});

test("inbound.list sends filters as a query; get and attachments read back", async () => {
  const { calls, fetchImpl } = scripted([
    json({ data: [], nextCursor: null }),
    json({ id: "in_1", messageId: "<g@mail.gmail.com>", references: null }),
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "application/pdf" },
    }),
  ]);
  const zalify = client(fetchImpl);
  await zalify.emails.inbound.list({ mailbox: "emma@zalify.com", limit: 10 });
  const email = await zalify.emails.inbound.get("in_1");
  const file = await zalify.emails.inbound.getAttachment("in_1", "att_1");

  assert.equal(
    calls[0]?.url,
    "https://app.zalify.com/api/v1/email/inbound?mailbox=emma%40zalify.com&limit=10"
  );
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(email.messageId, "<g@mail.gmail.com>");
  assert.equal(calls[2]?.url, "https://app.zalify.com/api/v1/email/inbound/in_1/attachments/att_1");
  assert.deepEqual([...file.content], [1, 2, 3]);
  assert.equal(file.contentType, "application/pdf");
});

test("an unknown inbound id is a ZalifyError not_found", async () => {
  const { fetchImpl } = scripted([json({ error: "No received email", code: "not_found" }, 404)]);
  await assert.rejects(client(fetchImpl).emails.inbound.get("x"), (error: unknown) =>
    error instanceof ZalifyError && error.code === "not_found" && error.status === 404
  );
});

test("a received email threads straight from inbound.get", () => {
  const email = { messageId: "<g@mail.gmail.com>", references: "<a@email.amazonses.com>" };
  assert.deepEqual(threadHeaders(email), {
    "In-Reply-To": "<g@mail.gmail.com>",
    References: "<a@email.amazonses.com> <g@mail.gmail.com>",
  });
  assert.throws(() => threadHeaders({ messageId: null }), ZalifyError);
});
