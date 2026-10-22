import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TraceEvent } from "../shared/protocol.ts";
import { deriveFlow, laneOf, reachesBrowser, type FlowInput } from "../src/flow.ts";
import { reduceSearchFlow, SessionObservation, type SearchFlowState } from "../src/observation.ts";
import { App } from "../src/App.tsx";

const NOW = Date.parse("2026-01-01T00:00:10.000Z");
let counter = 0;
function event(type: string, source: TraceEvent["source"], secondsAgo = 5, extra: Partial<TraceEvent> = {}): TraceEvent {
  counter += 1;
  return {
    id: `event-${counter}`, time: new Date(NOW - secondsAgo * 1000).toISOString(), source, category: "session",
    type, label: type, payload: {}, ...extra,
  };
}
const delegationEvent = (type: string, source: TraceEvent["source"], secondsAgo: number) =>
  event(type, source, secondsAgo, { category: "delegation", delegationId: "delegation-test" });

function flow(overrides: Partial<FlowInput> & { events?: TraceEvent[]; searchState?: SearchFlowState } = {}) {
  const observer = new SessionObservation();
  for (const event of overrides.events ?? []) observer.trace(event);
  return deriveFlow({
    phase: "live", rtcState: "connected", backendOpen: true, micSignal: false,
    observation: overrides.searchState ? { ...observer.snapshot, searchState: overrides.searchState } : observer.snapshot,
    now: NOW, ...overrides,
  });
}

test("events map to the connection they travelled over", () => {
  assert.equal(laneOf(event("browser.azure.create.started", "browser")), "command");
  assert.equal(laneOf(event("browser.microphone.ready", "browser")), undefined);
  assert.equal(laneOf(event("live.session.request", "backend")), "append");
  assert.equal(laneOf(event("session.commentary.append", "backend")), "append");
  assert.equal(laneOf(event("luna.request", "backend")), "request");
  assert.equal(laneOf(event("luna.first_text", "luna")), "stream");
  assert.equal(laneOf(event("session.delegation.created", "live")), "sideband");
  assert.equal(reachesBrowser(event("browser.stop", "browser")), false);
  assert.equal(reachesBrowser(event("luna.request", "backend")), true);
});

test("before a session every connection is off and the caption invites a start", () => {
  const view = flow({ phase: "idle", rtcState: "none", backendOpen: false });
  assert.ok(Object.values(view.lanes).every((state) => state === "off"));
  assert.match(view.caption, /Start a session/);
  assert.equal(view.nodes.live.text, "No session");
});

test("a connected quiet session keeps both audio directions open and reasoning idle", () => {
  const view = flow();
  assert.equal(view.lanes.mic, "open");
  assert.equal(view.lanes.speech, "open");
  assert.equal(view.lanes.sideband, "open");
  assert.equal(view.lanes.request, "off");
  assert.equal(view.lanes.stream, "off");
  assert.match(view.caption, /directly between browser and GPT-Live/);
});

test("audio lanes are full duplex and light up independently", () => {
  const both = flow({ micSignal: true, lastSpeechAt: NOW - 400 });
  assert.equal(both.lanes.mic, "active");
  assert.equal(both.lanes.speech, "active");
  const onlyYou = flow({ micSignal: true, lastSpeechAt: NOW - 5000 });
  assert.equal(onlyYou.lanes.mic, "active");
  assert.equal(onlyYou.lanes.speech, "open");
  assert.equal(onlyYou.nodes.browser.text, "Hearing you");
});

test("session creation waits on the backend's HTTPS call before audio exists", () => {
  const events = [event("browser.start", "browser", 2), event("live.session.request", "backend", 1)];
  const view = flow({ phase: "starting", rtcState: "new", events });
  assert.equal(view.lanes.append, "waiting");
  assert.equal(view.lanes.mic, "off");
  assert.match(view.caption, /creating the Azure session over HTTPS/);
});

test("a delegation walks through waiting, streaming and finished", () => {
  const base = [
    delegationEvent("session.delegation.created", "live", 4),
    delegationEvent("luna.context.ready", "backend", 3.5),
  ];
  const preparing = flow({ events: base });
  assert.match(preparing.caption, /building the reasoning request/);
  assert.equal(preparing.nodes.backend.text, "Preparing context");

  const waiting = flow({ events: [...base, delegationEvent("luna.request", "backend", 3)] });
  assert.equal(waiting.lanes.request, "open");
  assert.equal(waiting.lanes.stream, "waiting");
  assert.match(waiting.nodes.reasoning.text, /^Thinking 3\.00 s$/);
  assert.match(waiting.caption, /waits for its first words/);

  const streaming = flow({ events: [
    ...base, delegationEvent("luna.request", "backend", 3), delegationEvent("luna.first_text", "luna", 2),
    delegationEvent("session.commentary.append", "backend", 1.5),
  ] });
  assert.equal(streaming.lanes.stream, "active");
  assert.equal(streaming.nodes.reasoning.text, "Streaming answer");
  assert.equal(streaming.nodes.live.text, "Result pending");
  assert.match(streaming.caption, /\(1 sent\)/);

  const done = flow({ events: [
    ...base, delegationEvent("luna.request", "backend", 3), delegationEvent("luna.first_text", "luna", 2),
    delegationEvent("session.commentary.append", "backend", 1.5), delegationEvent("session.commentary.appended", "live", 1),
    delegationEvent("luna.response", "luna", 0.5),
  ] });
  assert.equal(done.lanes.request, "off");
  assert.equal(done.lanes.stream, "off");
  assert.match(done.caption, /Reasoning finished\. 1 sentence was sent to GPT-Live; Azure accepted 1\./);
});

test("a failed delegation never reads as completed and old results leave the caption", () => {
  const failed = flow({ events: [
    delegationEvent("luna.request", "backend", 3), delegationEvent("session.commentary.append", "backend", 2),
    delegationEvent("luna.failed", "backend", 1),
  ] });
  assert.match(failed.caption, /failed after some text was sent/);
  assert.equal(failed.nodes.reasoning.tone, "bad");
  const old = flow({ events: [delegationEvent("luna.request", "backend", 30), delegationEvent("luna.response", "luna", 20)] });
  assert.doesNotMatch(old.caption, /Reasoning finished/);
});

test("stopping and errors do not claim live traffic", () => {
  const stopping = flow({ phase: "stopping" });
  assert.match(stopping.caption, /Stopping/);
  const error = flow({ phase: "error", rtcState: "closed", backendOpen: false });
  assert.ok(Object.values(error.lanes).every((state) => state === "off"));
  assert.equal(error.nodes.browser.tone, "bad");
});

test("the default page shows both zones, all four parts and the legend", () => {
  const html = renderToStaticMarkup(createElement(App));
  for (const text of ["Your computer", "Azure", "Browser", "Backend", "GPT-Live", "Reasoning model",
    "Local WebSocket", "Sideband WebSocket", "WebRTC audio, direct", "Data moving", "What each connection carries"]) {
    assert.ok(html.includes(text), `Missing ${text}`);
  }
  assert.equal((html.match(/class="lane lane-off"/g) ?? []).length, 10 + 1);
});

test("search uses the backend-to-Web-IQ route while reasoning waits for tool results", () => {
  const events = [
    delegationEvent("luna.request", "backend", 3),
    delegationEvent("luna.step.response", "luna", 2),
    delegationEvent("search.request", "backend", 1),
  ];
  const view = flow({ events, webSearchAvailable: true });
  assert.equal(view.lanes.search, "active");
  assert.equal(view.lanes.results, "waiting");
  assert.equal(view.lanes.stream, "off");
  assert.equal(view.nodes.reasoning.text, "Waiting for sources");
  assert.equal(laneOf(event("search.request", "backend")), "search");
  assert.equal(laneOf(event("search.response", "web")), "results");
});

test("a scheduled retry is waiting, not an active search or reasoning stream", () => {
  const events = [
    delegationEvent("luna.request", "backend", 3),
    delegationEvent("luna.step.response", "luna", 2),
    delegationEvent("search.request", "backend", 1),
    delegationEvent("search.retry", "backend", 0),
  ];
  const view = flow({ events, webSearchAvailable: true });
  assert.equal(view.lanes.search, "waiting");
  assert.equal(view.lanes.results, "off");
  assert.equal(view.lanes.stream, "off");
  assert.equal(view.nodes.backend.text, "Waiting to retry");
  assert.match(view.caption, /no request is being sent/);
  assert.equal(laneOf(event("search.attempt", "backend")), "search");
});

test("retry countdown decreases without inventing a second attempt when the wait expires", () => {
  const retry = event("search.retry", "backend", 0, {
    delegationId: "delegation-test", payload: { attempt: 2, retryAt: new Date(NOW + 2100).toISOString() },
  });
  const events = [delegationEvent("luna.request", "backend", 3), retry];
  assert.equal(flow({ events }).nodes.web.text, "503 · retry in 3 s");
  assert.equal(flow({ events, now: NOW + 1500 }).nodes.web.text, "503 · retry in 1 s");
  const due = flow({ events, now: NOW + 2200 });
  assert.equal(due.nodes.web.text, "503 · retry pending");
  assert.equal(due.nodes.web.tone, "warn");
  assert.equal(due.lanes.search, "waiting");
  assert.equal(due.lanes.results, "off");
});

test("the second attempt is active, then successful recovery is shown briefly", () => {
  const events = [
    delegationEvent("luna.request", "backend", 3),
    event("search.retry", "backend", 2, { payload: { retryAt: new Date(NOW - 1000).toISOString() } }),
    event("search.attempt", "backend", 1, { payload: { attempt: 2 } }),
  ];
  const active = flow({ events, webSearchAvailable: true });
  assert.equal(active.nodes.web.text, "Retrying · 2/2");
  assert.equal(active.lanes.search, "active");
  assert.equal(active.nodes.live.tone, "accent");
  events.push(event("search.response", "web", 0, { payload: { attempt: 2, sources: [] } }));
  const recovered = flow({ events, webSearchAvailable: true });
  assert.equal(recovered.nodes.web.text, "Recovered after retry");
  assert.equal(recovered.nodes.web.tone, "ok");
  assert.equal(recovered.lanes.search, "off");
  assert.match(recovered.caption, /succeeded after one retry/);
  assert.equal(flow({ events, now: NOW + 6000, webSearchAvailable: true }).nodes.web.text, "Ready");
});

test("search failure remains local and visible while reasoning completes or a new delegation starts", () => {
  for (const httpStatus of [503, 401, 403, 429, undefined]) {
    const failure = event("search.failed", "web", 2, { payload: { httpStatus } });
    const events = [
      delegationEvent("luna.request", "backend", 4), failure,
      delegationEvent("luna.response", "luna", 1),
      event("luna.request", "backend", 0, { delegationId: "new-delegation" }),
    ];
    const view = flow({ events, webSearchAvailable: true });
    assert.equal(view.nodes.web.text, `Search failed${httpStatus ? ` · ${httpStatus}` : ""}`);
    assert.equal(view.nodes.web.tone, "bad");
    assert.equal(view.lanes.search, "failed");
    assert.equal(view.lanes.results, "failed");
    assert.equal(view.lanes.mic, "open");
    assert.equal(view.lanes.speech, "open");
    assert.equal(view.nodes.browser.tone, "ok");
    assert.notEqual(view.nodes.live.tone, "bad");
    assert.notEqual(view.nodes.backend.tone, "bad");
    assert.notEqual(view.nodes.reasoning.tone, "bad");
    assert.match(view.caption, /voice conversation is still connected/);
  }
});

test("latched failure survives trace eviction, clears on a new search, and resets with a session", () => {
  const failure = event("search.failed", "web", 40, { payload: { httpStatus: 503 } });
  const saved = reduceSearchFlow([failure]);
  const unrelated = Array.from({ length: 800 }, () => event("browser.webrtc.audio.stats", "browser", 0));
  const state = reduceSearchFlow(unrelated, saved);
  assert.equal(state, saved);
  const persistent = flow({ events: unrelated, searchState: state, webSearchAvailable: true });
  assert.equal(persistent.nodes.web.text, "Search failed · 503");
  const next = reduceSearchFlow([event("search.request", "backend", 0)], state);
  assert.equal(flow({ searchState: next }).nodes.web.text, "Searching");
  assert.equal(reduceSearchFlow([]), undefined);
  assert.equal(flow({ phase: "idle", events: [], webSearchAvailable: true }).nodes.web.text, "Ready");
});

test("stopping clears retry activity without claiming the voice connection is still live", () => {
  const events = [event("search.retry", "backend", 0, { payload: { retryAt: new Date(NOW + 5000).toISOString() } })];
  const stopped = flow({ events, phase: "idle", rtcState: "closed", backendOpen: false, webSearchAvailable: true });
  assert.equal(stopped.nodes.web.text, "Ready");
  assert.ok(Object.values(stopped.lanes).every((state) => state === "off"));
  const failed = flow({
    events: [event("search.failed", "web", 0, { payload: { httpStatus: 503 } })],
    phase: "idle", rtcState: "closed", backendOpen: false, webSearchAvailable: true,
  });
  assert.equal(failed.nodes.web.text, "Search failed · 503");
  assert.doesNotMatch(failed.caption, /still connected/);
});
