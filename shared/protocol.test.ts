import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateCost } from "./pricing.ts";
import { emptySessionMetrics, parseClientCommand, parseObject, parsePublicConfig, parseServerMessage, type ClientCommand, type Phase, type ServerMessage, type TraceEvent } from "./protocol.ts";

test("JSON objects are required, not scalar or array payloads", () => {
  assert.deepEqual(parseObject('{"type":"test"}'), { type: "test" });
  for (const value of ["null", "[]", '"hello"', "{"]) {
    assert.throws(() => parseObject(value));
  }
});

test("all browser commands round trip through the shared contract", () => {
  const commands: ClientCommand[] = [
    { type: "prepare" }, { type: "start", sdp: "v=0\r\noffer" },
    { type: "stop" }, { type: "search", enabled: true }, { type: "search", enabled: false },
  ];
  for (const command of commands) {
    assert.deepEqual(parseClientCommand(JSON.stringify(command)), command);
  }
});

test("browser command decoding rejects malformed JSON, unknown commands and invalid fields", () => {
  for (const text of ["{", "null", "[]", '"prepare"']) {
    assert.throws(() => parseClientCommand(text));
  }
  for (const command of [
    {}, { type: "other" }, { type: 2 }, { type: "start" }, { type: "start", sdp: 3 },
    { type: "start", sdp: "" }, { type: "start", sdp: "offer" },
    { type: "search" }, { type: "search", enabled: "true" }, { type: "search", enabled: 1 },
  ]) {
    assert.throws(() => parseClientCommand(JSON.stringify(command)));
  }
});

test("SDP command size validation preserves the exact 100000-character limit", () => {
  const command: ClientCommand = { type: "start", sdp: "v=0" + "a".repeat(99_997) };
  assert.deepEqual(parseClientCommand(JSON.stringify(command)), command);
  assert.throws(() => parseClientCommand(JSON.stringify({ ...command, sdp: command.sdp + "a" })), /SDP offer/);
});

const event: TraceEvent = {
  id: "trace-one", time: "2026-01-01T00:00:00.000Z", source: "backend",
  category: "reasoning", type: "luna.request", label: "Reasoning started", payload: { input: "A question" },
  delegationId: "delegation-one", durationMs: 12.5, severity: "info",
};

test("all server message families and session phases decode without losing content", () => {
  const phases: Phase[] = ["idle", "starting", "live", "stopping", "error"];
  const messages: ServerMessage[] = [
    ...phases.map((phase): ServerMessage => ({ type: "state", phase, sessionId: "session-one" })),
    { type: "trace", event }, { type: "answer", sdp: "v=0\r\nanswer" },
    { type: "metrics", metrics: emptySessionMetrics() },
    { type: "transcript", fragment: { speaker: "user", text: "Hello", startMs: 0, endMs: 12.5 } },
  ];
  for (const message of messages) {
    assert.deepEqual(parseServerMessage(JSON.stringify(message)), message);
  }
});

test("server message decoding rejects invalid envelopes, discriminants and fragment fields", () => {
  for (const text of ["{", "null", "[]", '"state"']) {
    assert.throws(() => parseServerMessage(text));
  }
  for (const message of [
    {}, { type: "unknown" }, { type: "state", phase: "connected" }, { type: "state", phase: "idle", sessionId: 2 },
    { type: "answer", sdp: null }, { type: "transcript", fragment: {} },
    { type: "transcript", fragment: { speaker: "system", text: "Hello", startMs: 0, endMs: 1 } },
    { type: "trace", event: { ...event, source: "external" } },
    { type: "trace", event: { ...event, category: "external" } },
    { type: "trace", event: { ...event, severity: "fatal" } },
    { type: "trace", event: { ...event, durationMs: -1 } },
    { type: "trace", event: { ...event, delegationId: 7 } },
  ]) {
    assert.throws(() => parseServerMessage(JSON.stringify(message)), /Invalid message from backend/);
  }
  assert.throws(() => parseServerMessage('{"type":"transcript","fragment":{"speaker":"user","text":"Hello","startMs":0,"endMs":1e309}}'));
});

test("metrics decoding preserves partial usage, unknown prices and zero-valued estimates", () => {
  const metrics = {
    ...emptySessionMetrics(), lunaRequests: 1, lunaUsageIncomplete: true, lunaPendingRequests: 1,
    lunaUsage: { inputTokens: 0 }, lunaCachedUsageIncomplete: true, liveStartedAt: 1_000,
    searchRequests: 1, searchSucceeded: 0, searchFailed: 0, searchUncertain: 0, webSearchEnabled: true,
  };
  for (const rates of [
    { liveMinimumSeconds: 15, liveRoundingSeconds: 1 },
    { liveMinimumSeconds: 15, liveRoundingSeconds: 1, liveUsdPerMinute: 0, inputUsdPerMillion: 0,
      cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, webUsdPerThousand: 0 },
  ]) {
    const message: ServerMessage = { type: "metrics", metrics: { ...metrics, cost: calculateCost(rates, metrics, 2_000) } };
    const encoded = JSON.stringify(message);
    assert.deepEqual(parseServerMessage(encoded), JSON.parse(encoded));
  }
});

test("metrics decoding rejects invalid counts, usage, flags and closure status", () => {
  for (const invalid of [
    { lunaRequests: -1 }, { lunaResponses: "1" }, { lunaUsage: [] }, { lunaUsage: { inputTokens: -1 } },
    { lunaUsageIncomplete: "true" }, { lunaCachedUsageIncomplete: "true" }, { lunaPendingRequests: -1 },
    { liveSeconds: -1 }, { liveUsage: [] }, { liveUsageFinal: 0 }, { closeStatus: "closed" },
    { searchRequests: -1 }, { searchUncertain: "1" }, { webSearchEnabled: "yes" },
  ]) {
    assert.throws(() => parseServerMessage(JSON.stringify({ type: "metrics", metrics: { ...emptySessionMetrics(), ...invalid } })));
  }
});

test("cost decoding validates optional prices and subtotals as well as headline totals", () => {
  const metrics = emptySessionMetrics();
  const cost = calculateCost({ liveMinimumSeconds: 15, liveRoundingSeconds: 1 }, metrics, 0);
  for (const invalid of [
    { ...cost, currency: "EUR" }, { ...cost, totalKnownUsd: -1 }, { ...cost, reasons: [1] },
    { ...cost, live: { ...cost.live, seconds: "15" } },
    { ...cost, live: { ...cost.live, usdPerMinute: -1 } },
    { ...cost, reasoning: { ...cost.reasoning, inputUsd: "0" } },
    { ...cost, reasoning: { ...cost.reasoning, outputUsdPerMillion: -1 } },
    { ...cost, search: { ...cost.search, usdPerThousand: "7" } },
    { ...cost, search: { ...cost.search, complete: undefined } },
  ]) {
    assert.throws(() => parseServerMessage(JSON.stringify({ type: "metrics", metrics: { ...metrics, cost: invalid } })));
  }
});

test("unknown additive message fields remain compatible with existing consumers", () => {
  const message = { type: "state", phase: "live", futureMetadata: { enabled: true } };
  assert.deepEqual(parseServerMessage(JSON.stringify(message)), message);
  assert.deepEqual(parseClientCommand('{"type":"stop","futureMetadata":true}'), { type: "stop" });
});

test("browser configuration decoding projects deployment names and search capability", () => {
  const config = { endpoint: "https://example-resource.test", liveDeployment: "live-test", reasoningDeployment: "reasoning-test" };
  assert.deepEqual(parsePublicConfig(config), { ...config, webSearchAvailable: false });
  assert.deepEqual(parsePublicConfig({ ...config, webSearchAvailable: true, extra: "ignored", pricing: {} }),
    { ...config, webSearchAvailable: true });
});

test("browser configuration decoding rejects missing or malformed required fields", () => {
  for (const value of [
    null, [], {}, { endpoint: 1, liveDeployment: "live-test", reasoningDeployment: "reasoning-test" },
    { endpoint: "https://example-resource.test", liveDeployment: null, reasoningDeployment: "reasoning-test" },
  ]) {
    assert.throws(() => parsePublicConfig(value), /Invalid backend configuration/);
  }
});
