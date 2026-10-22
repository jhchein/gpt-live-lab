import { test } from "node:test";
import assert from "node:assert/strict";
import { contextChunks, outputText, parseObject, parseSseFrames, readTranscript, scrub, takeCompleteSentences } from "./protocol.ts";

test("JSON objects are required, not scalar or array payloads", () => {
  assert.deepEqual(parseObject('{"type":"test"}'), { type: "test" });
  for (const value of ["null", "[]", '"hello"', "{"]) {
    assert.throws(() => parseObject(value));
  }
});

test("transcript fragments preserve speaker, text and server timestamps", () => {
  assert.deepEqual(readTranscript({
    type: "session.input_transcript.delta", delta: "Hello ", start_ms: 100, end_ms: 200,
  }), { speaker: "user", text: "Hello ", startMs: 100, endMs: 200 });
  assert.equal(readTranscript({ type: "session.updated" }), undefined);
  assert.throws(() => readTranscript({ type: "session.output_transcript.delta", delta: 4 }));
});

test("Responses text comes from completed message output, not reasoning internals", () => {
  assert.equal(outputText({
    status: "completed",
    output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "Not speech" }] },
      { type: "message", content: [{ type: "output_text", text: "Answer one." }, { type: "output_text", text: "Answer two." }] },
    ],
  }), "Answer one.\nAnswer two.");
  assert.throws(() => outputText({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }), /incomplete/);
  assert.throws(() => outputText({ status: "completed", output: [] }), /no output_text/);
  assert.throws(() => outputText({
    status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "No" }] }],
  }), /no output_text/);
});

test("context append chunks preserve Unicode and remain strictly below 500 UTF-8 bytes", () => {
  const text = "Reasoning result: \u00e4\u00f6\u00fc \ud83d\ude00 \u65e5\u672c\u8a9e ".repeat(300);
  const chunks = contextChunks(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 480));
  assert.ok(chunks.every((chunk) => !chunk.includes("\ufffd")));
  assert.deepEqual(contextChunks(""), []);
});

test("SSE frames survive arbitrary chunk boundaries and ignore the done marker", () => {
  const first = parseSseFrames('event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\n');
  assert.deepEqual(first.events, []);
  const second = parseSseFrames(first.remainder + 'data: "delta":"Hello."}\r\n\r\n' +
    'data: [DONE]\r\n\r\n' +
    'data: {"type":"response.completed","response":{"status":"completed"}}\r\n\r\n');
  assert.deepEqual(second.events, [
    { type: "response.output_text.delta", delta: "Hello." },
    { type: "response.completed", response: { status: "completed" } },
  ]);
  assert.equal(second.remainder, "");
});

test("sentence streaming holds incomplete text and preserves complete UTF-8 content", () => {
  const first = takeCompleteSentences("The answer is 42. The second");
  assert.deepEqual(first, { complete: ["The answer is 42. "], remainder: "The second" });
  const second = takeCompleteSentences(first.remainder + " sentence! Still open");
  assert.deepEqual(second, { complete: ["The second sentence! "], remainder: "Still open" });
  assert.deepEqual(takeCompleteSentences("Fertig 😀."), { complete: [], remainder: "Fertig 😀." });
});

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
