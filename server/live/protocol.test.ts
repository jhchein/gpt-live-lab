import { test } from "node:test";
import assert from "node:assert/strict";
import { contextChunks, readTranscript } from "./protocol.ts";

test("transcript fragments preserve speaker, text and server timestamps", () => {
  assert.deepEqual(readTranscript({
    type: "session.input_transcript.delta", delta: "Hello ", start_ms: 100, end_ms: 200,
  }), { speaker: "user", text: "Hello ", startMs: 100, endMs: 200 });
  assert.equal(readTranscript({ type: "session.updated" }), undefined);
  assert.throws(() => readTranscript({ type: "session.output_transcript.delta", delta: 4 }));
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
