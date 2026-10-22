import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isObject, type TraceEvent } from "../shared/protocol.ts";
import { App } from "../src/App.tsx";
import { Delegations } from "../src/Delegations.tsx";
import { formatCount, formatDuration, NOT_MEASURED, NOT_REPORTED, UNKNOWN } from "../src/format.ts";
import { buildDelegations } from "../src/trace.ts";

test("default interface is English and keeps diagnostics out of the main view", () => {
  const html = renderToStaticMarkup(createElement(App));
  for (const label of ["Start session", "Test microphone", "Conversation", "Delegations", "Usage", "Raw events"]) {
    assert.ok(html.includes(label), `Missing English label: ${label}`);
  }
  assert.match(html, /<summary>Connection details<\/summary>/);
  assert.match(html, /<summary>Usage details<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]+open=""/);
  assert.doesNotMatch(html, /Kosten|Session starten|Mikrofon|https:\/\/.*\.azure\.com/);
  assert.match(html, /Estimated cost/);
  assert.equal(formatCount(1234), "1,234");
  assert.equal(formatDuration(1250), "1.25 s");
  assert.deepEqual([UNKNOWN, NOT_REPORTED, NOT_MEASURED], ["unknown", "not reported", "not measured"]);
});

test("failed streamed delegation never describes partial output as a completed answer", () => {
  const event = (type: string, payload: unknown): TraceEvent => ({
    id: type, time: "2026-01-01T00:00:00Z", source: "backend",
    category: type === "luna.failed" ? "error" : "delegation",
    type, label: type, payload, delegationId: "test-delegation",
  });
  const delegations = buildDelegations([
    event("session.delegation.created", {}),
    event("luna.request", { model: "reasoning-test" }),
    event("session.commentary.append", { content: "A partial answer. ", event_id: "chunk-test" }),
    event("luna.failed", { message: "Fixture stream failure", partialTextSent: true }),
  ]);
  const html = renderToStaticMarkup(createElement(Delegations, {
    delegations, openIds: {}, onToggle: () => {}, now: Date.parse("2026-01-01T00:00:01Z"), eventsDropped: false,
  }));
  assert.match(html, />Failed</);
  assert.match(html, /Partial text may already have reached GPT-Live/);
  assert.match(html, /They do not represent a completed response/);
  assert.doesNotMatch(html, /There is no model output|Instead of an answer/);
});

test("publication templates contain no configured Azure values and use the public npm registry", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const assignments = example.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  assert.deepEqual(assignments.filter((line) => line.startsWith("AZURE_")),
    ["AZURE_ENDPOINT=", "AZURE_LIVE_DEPLOYMENT=", "AZURE_REASONING_DEPLOYMENT="]);
  assert.ok(assignments.includes("WEB_IQ_API_KEY="));
  const lock: unknown = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.ok(isObject(lock) && isObject(lock.packages));
  let resolved = 0;
  for (const pkg of Object.values(lock.packages)) {
    if (!isObject(pkg) || typeof pkg.resolved !== "string") continue;
    const url = new URL(pkg.resolved);
    assert.equal(url.origin, "https://registry.npmjs.org");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.equal(typeof pkg.integrity, "string");
    resolved++;
  }
  assert.ok(resolved > 0);
});
