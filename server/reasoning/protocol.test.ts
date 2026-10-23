import { test } from "node:test";
import assert from "node:assert/strict";
import { outputText, parseSseFrames, takeCompleteSentences } from "./protocol.ts";

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
