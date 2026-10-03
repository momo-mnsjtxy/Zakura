import assert from "node:assert/strict";
import test from "node:test";
import { HttpJsonRpcTransport, JsonLineTransport, JsonRpcClient, type JsonRpcMessage } from "../src/json-rpc-client.js";

function fakeStdio() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const writes: Uint8Array[] = [];
  const readable = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const writable = new WritableStream<Uint8Array>({ write(chunk) { writes.push(chunk); } });
  return { controller, writes, transport: new JsonLineTransport(readable, writable) };
}
const text = (chunks: Uint8Array[]) => Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString();

test("stdio transport reassembles fragmented JSON-RPC and isolates malformed lines", async () => {
  const io = fakeStdio();
  const client = new JsonRpcClient(io.transport, 100);
  const request = client.request<{ ok: boolean }>("tools/list", { cursor: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(JSON.parse(text(io.writes).trim()), { jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: 1 } });
  io.controller.enqueue(Buffer.from("not json\n{\"jsonrpc\":\"2.0\",\"id\":"));
  io.controller.enqueue(Buffer.from("1,\"result\":{\"ok\":true}}\n"));
  assert.deepEqual(await request, { ok: true });
  await client.close();
});

test("timeouts and cancellation remove pending requests and late replies are ignored", async () => {
  const io = fakeStdio();
  const client = new JsonRpcClient(io.transport, 3);
  await assert.rejects(client.request("slow"), { name: "TimeoutError" });
  const controller = new AbortController();
  const cancelled = client.request("cancel", undefined, { signal: controller.signal, timeoutMs: 100 });
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  io.controller.enqueue(Buffer.from('{"jsonrpc":"2.0","id":2,"result":"late"}\n'));
  await client.close();
});

test("close is idempotent and rejects all pending/future requests", async () => {
  const io = fakeStdio();
  const client = new JsonRpcClient(io.transport, 100);
  const pending = client.request("pending");
  const one = client.close();
  const two = client.close();
  assert.equal(one, two);
  await one;
  await assert.rejects(pending, /closed/);
  await assert.rejects(client.request("future"), /closed/);
});

test("HTTP transport uses injected fake fetch and returns JSON-RPC result", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    const body = JSON.parse(String(init?.body)) as JsonRpcMessage;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const transport = new HttpJsonRpcTransport("https://fake.invalid/mcp", fakeFetch, { authorization: "Bearer fake" });
  const client = new JsonRpcClient(transport);
  assert.deepEqual(await client.request("tools/list"), { tools: [] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.init?.method, "POST");
  assert.match(String(requests[0]!.init?.body), /tools\/list/);
  await client.close();
});

test("HTTP errors and aborts propagate without real network access", async () => {
  const errorFetch: typeof fetch = async () => new Response("down", { status: 503 });
  const errors = new JsonRpcClient(new HttpJsonRpcTransport("https://fake.invalid", errorFetch));
  await assert.rejects(errors.request("ping"), /HTTP 503/);
  await errors.close();

  const abortFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  const cancelled = new JsonRpcClient(new HttpJsonRpcTransport("https://fake.invalid", abortFetch));
  const controller = new AbortController();
  const request = cancelled.request("slow", undefined, { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  await cancelled.close();
});

test("HTTP transport reassembles fragmented MCP SSE responses", async () => {
  const encoder = new TextEncoder();
  const fakeFetch: typeof fetch = async (_input, init) => {
    const id = (JSON.parse(String(init?.body)) as JsonRpcMessage).id;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`event: message\ndata: {"jsonrpc":"2.0","id":`));
        controller.enqueue(encoder.encode(`${id},"result":{"ok":true}}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  };
  const client = new JsonRpcClient(new HttpJsonRpcTransport("https://fake.invalid/mcp", fakeFetch));
  assert.deepEqual(await client.request("initialize"), { ok: true });
  await client.close();
});

test("closing HTTP client aborts an in-flight fake request", async () => {
  let observedAbort = false;
  const fakeFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { observedAbort = true; reject(new DOMException("aborted", "AbortError")); }, { once: true });
  });
  const client = new JsonRpcClient(new HttpJsonRpcTransport("https://fake.invalid", fakeFetch), 100);
  const request = client.request("pending");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await client.close();
  await assert.rejects(request, /closed/);
  assert.equal(observedAbort, true);
});
