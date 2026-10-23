import { test } from "node:test";
import assert from "node:assert/strict";
import { scrub } from "./redaction.ts";

test("authorization values are removed recursively without hiding request content", () => {
  assert.deepEqual(scrub({
    Authorization: "Bearer private", request: { "api-key": "private", input: "question" },
    list: [{ access_token: "private" }],
  }), { Authorization: "[redacted]", request: { "api-key": "[redacted]", input: "question" }, list: [{ access_token: "[redacted]" }] });
});

test("trace payloads omit transport credentials and opaque encrypted model state", () => {
  assert.deepEqual(scrub({
    transport: { type: "webrtc", sdp: "v=0\r\na=ice-pwd:private-ice-password\r\n" },
    output: [{ type: "reasoning", encrypted_content: "opaque-private-state", summary: [] }],
    usage: { total_tokens: 19 },
  }), {
    transport: { type: "webrtc", sdp: "[redacted: WebRTC SDP]" },
    output: [{ type: "reasoning", encrypted_content: "[omitted: encrypted model state]", summary: [] }],
    usage: { total_tokens: 19 },
  });
});
