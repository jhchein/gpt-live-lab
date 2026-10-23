import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import WebSocket from "ws";
import { parseServerMessage, type ClientCommand } from "../shared/protocol.ts";
import { createApp } from "./app.ts";

test("gateway uses the shared command decoder and reports rejected input before authentication", { timeout: 5_000 }, async (t) => {
  let tokenCalls = 0;
  const app = createApp({
    endpoint: "https://example-resource.test", liveDeployment: "live-test", reasoningDeployment: "reasoning-test",
  }, {
    getToken: async () => { tokenCalls++; return "fixture-token"; },
    request: async () => { assert.fail("Command validation must not contact Azure."); },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const browser = new WebSocket(`ws://127.0.0.1:${address.port}/api/events`, { origin: "http://127.0.0.1:5173" });
  await once(browser, "open");
  for (const command of [
    "{", "null", '{"type":"unknown"}', '{"type":"start","sdp":null}', '{"type":"search","enabled":"yes"}',
  ]) {
    const next = once(browser, "message");
    browser.send(command);
    const [raw] = await next;
    const message = parseServerMessage(String(raw));
    assert.equal(message.type, "trace");
    assert.ok(message.type === "trace" && message.event.type === "browser.command.error");
  }
  assert.equal(tokenCalls, 0);
  const next = once(browser, "message");
  browser.send(JSON.stringify({ type: "prepare" } satisfies ClientCommand));
  const [raw] = await next;
  const message = parseServerMessage(String(raw));
  assert.ok(message.type === "trace" && message.event.type === "backend.auth.ready");
  assert.equal(tokenCalls, 1);
});
