import { test } from "node:test";
import assert from "node:assert/strict";
import { operatorContextNote, OPERATOR_CONTEXT_MAX_LENGTH, readOperatorContext } from "./operator-context.ts";

test("operator context is optional and blank means off", () => {
  assert.equal(readOperatorContext({}), undefined);
  assert.equal(readOperatorContext({ DEMO_CONTEXT: " \n " }), undefined);
  assert.equal(operatorContextNote(undefined), "");
});

test("operator context is collapsed to one line and length-limited", () => {
  assert.equal(readOperatorContext({ DEMO_CONTEXT: "  GPT-Live Lab\nis a repo.  " }), "GPT-Live Lab is a repo.");
  assert.equal(readOperatorContext({ DEMO_CONTEXT: "x".repeat(OPERATOR_CONTEXT_MAX_LENGTH) })?.length, OPERATOR_CONTEXT_MAX_LENGTH);
  assert.throws(() => readOperatorContext({ DEMO_CONTEXT: "x".repeat(OPERATOR_CONTEXT_MAX_LENGTH + 1) }), /DEMO_CONTEXT must be at most 500/);
});

test("operator note marks the text as unverified background and requires research for contents", () => {
  const note = operatorContextNote("GPT-Live Lab is at github.com/example/lab.");
  assert.match(note, /github\.com\/example\/lab/);
  assert.match(note, /unverified/);
  assert.match(note, /Research such questions/);
});
