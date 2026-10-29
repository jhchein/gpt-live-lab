import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpToolbox, mcpMessage, readMcpToolbox } from "./client.ts";
import { isObject, type JsonObject } from "../../shared/protocol.ts";

const tools = [
  { name: "get_item", description: "Read one item", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
  { name: "list_tasks", description: "List tasks", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } },
  { name: "apply_command_batch", description: "Write", inputSchema: { type: "object", properties: {} } },
  { name: "web_search", description: "Clash", annotations: { readOnlyHint: true } },
  { name: "bad name!", description: "Invalid", annotations: { readOnlyHint: true } },
];

function fakeServer(options: { sse?: boolean; failWith?: number } = {}) {
  const calls: { method: string; headers: Headers; params?: JsonObject }[] = [];
  const request: typeof fetch = async (_url, init) => {
    const body: unknown = JSON.parse(String(init?.body));
    assert.ok(isObject(body));
    const headers = new Headers(init?.headers);
    calls.push({ method: String(body.method), headers, params: isObject(body.params) ? body.params : undefined });
    if (options.failWith) return new Response("echo: secret board title", { status: options.failWith });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result = body.method === "initialize" ? { protocolVersion: "2025-06-18" }
      : body.method === "tools/list" ? { tools }
        : { content: [{ type: "text", text: "Task A" }, { type: "image" }], isError: false };
    const payload = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
    const out = options.sse
      ? new Response(`event: message\ndata: ${payload}\n\n`, { headers: { "Content-Type": "text/event-stream", "Mcp-Session-Id": "s1" } })
      : new Response(payload, { headers: { "Content-Type": "application/json" } });
    return out;
  };
  return { calls, request };
}
const signal = () => new AbortController().signal;

test("without an allowlist only tools that declare readOnlyHint are exposed", async () => {
  const server = fakeServer();
  const toolbox = createMcpToolbox({ url: "http://127.0.0.1:8000/mcp", token: "t", request: server.request });
  assert.deepEqual((await toolbox.tools(signal())).map((tool) => tool.name), ["list_tasks"]);
});

test("an allowlist replaces the hint and never exposes write tools by accident", async () => {
  const server = fakeServer();
  const toolbox = createMcpToolbox({ url: "http://127.0.0.1:8000/mcp", token: "t", allowedTools: ["get_item", "web_search", "bad name!"], request: server.request });
  assert.deepEqual((await toolbox.tools(signal())).map((tool) => tool.name), ["get_item"]);
  await assert.rejects(toolbox.call("apply_command_batch", "{}", signal()), /not exposed/);
});

test("requests carry the bearer token and the session from an event-stream reply", async () => {
  const server = fakeServer({ sse: true });
  const toolbox = createMcpToolbox({ url: "http://127.0.0.1:8000/mcp", token: "tok", allowedTools: ["get_item"], request: server.request });
  await toolbox.tools(signal());
  const result = await toolbox.call("get_item", '{"id":"1"}', signal());
  assert.deepEqual(server.calls.map((call) => call.method), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  assert.equal(server.calls[0].headers.get("authorization"), "Bearer tok");
  assert.equal(server.calls[3].headers.get("mcp-session-id"), "s1");
  assert.deepEqual(server.calls[3].params, { name: "get_item", arguments: { id: "1" } });
  assert.equal(result.text, "Task A\n[image content omitted]");
});

test("a failing server never leaks its response body into the error", async () => {
  const server = fakeServer({ failWith: 500 });
  const toolbox = createMcpToolbox({ url: "http://127.0.0.1:8000/mcp", token: "t", request: server.request });
  await assert.rejects(toolbox.tools(signal()), (error: unknown) => {
    assert.equal(mcpMessage(error), "MCP server HTTP 500.");
    return true;
  });
  assert.equal(mcpMessage(new SyntaxError('Unexpected token "secret board title"')), "MCP request failed.");
});

test("the toolbox is only created when URL and token are both configured", () => {
  assert.equal(readMcpToolbox({ MCP_SERVER_URL: "http://127.0.0.1:8000/mcp" }), undefined);
  assert.equal(readMcpToolbox({ MCP_SERVER_TOKEN: "t" }), undefined);
  assert.ok(readMcpToolbox({ MCP_SERVER_URL: "http://127.0.0.1:8000/mcp", MCP_SERVER_TOKEN: "t" }));
  assert.throws(() => readMcpToolbox({ MCP_SERVER_URL: "file:///x", MCP_SERVER_TOKEN: "t" }), /http or https/);
});
