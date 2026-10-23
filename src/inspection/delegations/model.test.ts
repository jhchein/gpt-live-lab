import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDelegations, buildWaterfall } from "./model.ts";
import type { TraceEvent } from "../../../shared/protocol.ts";

test("delegation view correlates streamed commentary and shows time to first text", () => {
  const event = (type: string, payload: unknown, durationMs?: number): TraceEvent => ({
    id: type, time: "2026-10-22T00:00:00.000Z", source: "backend", category: "delegation",
    type, label: type, payload, delegationId: "delegation_stream", durationMs,
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
