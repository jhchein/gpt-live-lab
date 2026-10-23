import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeForExport } from "./export.ts";

test("session export removes credentials, SDP and encrypted state recursively", () => {
  const input = {
    authorization: "fixture-authorization",
    transport: { sdp: "fixture-sdp" },
    output: [{ encrypted_content: "fixture-encrypted-state" }],
    request: { input: "Keep the private conversation visible as disclosed." },
  };
  const result = sanitizeForExport(input);
  const json = JSON.stringify(result);
  for (const value of ["fixture-authorization", "fixture-sdp", "fixture-encrypted-state"]) {
    assert.ok(!json.includes(value));
  }
  assert.ok(json.includes(input.request.input));
  assert.equal(input.authorization, "fixture-authorization");
  assert.equal(input.transport.sdp, "fixture-sdp");
});

test("session export removes microphone and device identifiers in nested arrays", () => {
  const input = {
    microphone: { label: "fixture-private-microphone", deviceId: "fixture-device", groupId: "fixture-group" },
    devices: [{ label: "fixture-private-device", tracks: [{ label: "fixture-private-track", readyState: "ended" }] }],
    bareDevice: { label: "fixture-bare-device", deviceId: "fixture-bare-id" },
  };
  const json = JSON.stringify(sanitizeForExport(input));
  for (const value of [
    "fixture-private-microphone", "fixture-device", "fixture-group", "fixture-private-device",
    "fixture-private-track", "fixture-bare-device", "fixture-bare-id",
  ]) {
    assert.ok(!json.includes(value), `Export retained ${value}`);
  }
  assert.ok(json.includes("ended"));
  assert.equal(input.microphone.label, "fixture-private-microphone");
});

test("session export preserves trace labels, conversation text and ordinary payload labels", () => {
  const input = {
    label: "Luna request started",
    payload: { label: "Data channel", input: "What is seven factorial?", channel: { label: "events" } },
    fragments: [{ speaker: "user", text: "What is seven factorial?" }],
  };
  assert.deepEqual(sanitizeForExport(input), input);
});

test("session export preserves reported token counts and partial usage semantics", () => {
  const input = {
    metrics: {
      lunaUsage: { inputTokens: 692, outputTokens: 143, totalTokens: 835, reasoningOutputTokens: 70, cachedInputTokens: 0 },
      lunaUsageIncomplete: true, liveSeconds: 12.4, liveUsageFinal: false, closeStatus: "unconfirmed",
    },
    usage: { input_tokens: 692, output_tokens: 143, total_tokens: 835, output_tokens_details: { reasoning_tokens: 70 } },
  };
  assert.deepEqual(sanitizeForExport(input), input);
});
