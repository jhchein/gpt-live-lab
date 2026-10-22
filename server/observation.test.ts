import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionObservation, MAX_EVENTS, MAX_FRAGMENTS } from "../src/observation.ts";
import { deriveFlow } from "../src/flow.ts";
import type { TraceEvent } from "../shared/protocol.ts";

let number = 0;
function event(type: string, delegationId?: string, payload: unknown = {}): TraceEvent {
  return {
    id: String(++number), time: new Date(1_000_000 + number).toISOString(),
    type, delegationId, payload, source: "backend", category: "delegation", label: type,
  };
}

test("one observation keeps running A active while queued B has a separate card", () => {
  const observer = new SessionObservation();
  observer.trace(event("delegation.queued", "A"));
  observer.trace(event("luna.request", "A"));
  observer.trace(event("delegation.queued", "B"));
  const snapshot = observer.snapshot;
  assert.equal(snapshot.activeDelegation?.id, "A");
  assert.deepEqual(snapshot.queuedDelegations.map((item) => item.id), ["B"]);
  assert.equal(snapshot.delegations.find((item) => item.id === "A")?.status, "running");
  assert.equal(snapshot.delegations.find((item) => item.id === "B")?.status, "waiting");
  const flow = deriveFlow({
    observation: snapshot,
    phase: "live", rtcState: "connected", backendOpen: true, micSignal: false, now: 1_001_000,
  });
  assert.match(flow.nodes.reasoning.text, /Thinking/);
  assert.notEqual(flow.lanes.request, "off");
  const disconnected = deriveFlow({
    observation: snapshot,
    phase: "error", rtcState: "closed", backendOpen: false, micSignal: false, now: 1_001_000,
  });
  assert.equal(disconnected.lanes.request, "off");
  assert.equal(disconnected.lanes.stream, "off");
  observer.trace(event("luna.response", "A"));
  assert.equal(observer.snapshot.activeDelegation?.id, "B");
  observer.trace(event("luna.request", "B"));
  assert.equal(observer.snapshot.activeDelegation?.status, "running");
});

test("active summaries and the last search failure survive eviction, without preserving unlimited details", () => {
  const observer = new SessionObservation();
  observer.trace(event("delegation.queued", "A"));
  observer.trace(event("luna.request", "A"));
  observer.trace(event("search.failed", "A", { httpStatus: 503 }));
  for (let i = 0; i < MAX_EVENTS + 1; i++) observer.trace(event("browser.webrtc.audio.stats"));
  assert.equal(observer.snapshot.events.length, MAX_EVENTS);
  assert.equal(observer.snapshot.activeDelegation?.id, "A");
  assert.ok(observer.snapshot.activeDelegation?.request);
  assert.equal(observer.snapshot.searchState?.httpStatus, 503);
  assert.equal(observer.snapshot.delegations[0].id, "A");
  assert.equal(observer.snapshot.delegations[0].events.length, 0);
  observer.trace(event("luna.response", "A"));
  assert.equal(observer.snapshot.activeDelegation, undefined);
  observer.trace(event("search.request", "B"));
  assert.equal(observer.snapshot.searchState?.httpStatus, undefined);
});

test("transcripts and traces are bounded independently, reset discards all session state", () => {
  const observer = new SessionObservation();
  const original = observer.snapshot;
  for (let i = 0; i < MAX_FRAGMENTS + 2; i++) {
    observer.transcript({ speaker: "user", text: String(i), startMs: i, endMs: i + 1 }, i);
  }
  assert.equal(original.totalFragments, 0);
  assert.equal(observer.snapshot.fragments.length, MAX_FRAGMENTS);
  assert.equal(observer.snapshot.totalFragments, MAX_FRAGMENTS + 2);
  assert.equal(observer.snapshot.totalEvents, 0);
  observer.trace(event("delegation.queued", "A"));
  observer.trace(event("delegation.limit", "B"));
  observer.trace(event("luna.cancelled", "A"));
  assert.equal(observer.snapshot.activeDelegation, undefined);
  const reset = observer.reset();
  assert.equal(reset.events.length, 0);
  assert.equal(reset.fragments.length, 0);
  assert.equal(reset.delegations.length, 0);
  assert.equal(reset.searchState, undefined);
});
