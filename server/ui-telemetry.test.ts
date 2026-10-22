import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDelegations, buildWaterfall, sanitizeForExport } from "../src/trace.ts";
import type { TraceEvent } from "../shared/protocol.ts";

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

test("delegation view correlates streamed commentary and shows time to first text", () => {
  const event = (type: string, payload: unknown, durationMs?: number): TraceEvent => ({
    id: type, time: "2026-10-22T00:00:00.000Z", source: "backend", category: "delegation",
    type, label: type, payload, delegationId: "delegation_stream", durationMs,
  });

  test("source links use only safe tool-provided URLs and exports redact the Web IQ header", () => {
    const base: TraceEvent = {
      id: "search", time: "2026-01-01T00:00:00Z", source: "web", category: "search",
      type: "search.response", label: "Sources", delegationId: "d", payload: { sources: [
        { id: "S1", title: "Safe", url: "https://example.com", content: "evidence" },
        { id: "S2", title: "Unsafe", url: "javascript:alert(1)", content: "bad" },
        { id: "S3", title: "Credentials", url: "https://user:pass@example.com", content: "bad" },
      ] },
    };
    const [delegation] = buildDelegations([base]);
    assert.equal(delegation.sources.length, 1);
    assert.equal(delegation.sources[0].id, "S1");
    assert.ok(!JSON.stringify(sanitizeForExport({ "x-apikey": "fixture-web-key" })).includes("fixture-web-key"));
  });
  const events = [
    event("luna.request", {}),
    event("luna.first_text", {}, 720),
    event("session.commentary.append", { event_id: "append_1", content: "First sentence. " }),
    event("session.commentary.appended", { client_event_id: "append_1" }),
    event("luna.response", {}),
  ];
  const [delegation] = buildDelegations(events);
  assert.equal(delegation.firstText?.durationMs, 720);
  assert.equal(delegation.chunks.length, 1);
  assert.equal(delegation.chunks[0].content, "First sentence. ");
  assert.equal(delegation.chunks[0].ack?.type, "session.commentary.appended");
  const waterfall = buildWaterfall(delegation, Date.parse("2026-10-22T00:00:10.000Z"));
  assert.match(waterfall.lanes.find((lane) => lane.key === "luna")?.value ?? "", /first text/);
});
