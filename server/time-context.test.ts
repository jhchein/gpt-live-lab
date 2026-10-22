import { test } from "node:test";
import assert from "node:assert/strict";
import { timeContext } from "./time-context.ts";

test("time context supplies UTC and an explicit local calendar, not an inferred deployment region", () => {
  const text = timeContext(new Date("2026-10-22T18:48:33Z"), "Europe/Berlin");
  assert.match(text, /2026-10-22T18:48:33\.000Z/);
  assert.match(text, /2026-10-22T20:48:33/);
  assert.match(text, /Europe\/Berlin/);
  assert.match(text, /explicit historical dates/);
});

test("local dates cross midnight and year boundaries correctly, including DST changes", () => {
  assert.match(timeContext(new Date("2026-12-31T23:30:00Z"), "Europe/Berlin"), /2027-01-01T00:30:00/);
  assert.match(timeContext(new Date("2026-10-25T00:30:00Z"), "Europe/Berlin"), /2026-10-25T02:30:00/);
  assert.match(timeContext(new Date("2026-10-25T02:30:00Z"), "Europe/Berlin"), /2026-10-25T03:30:00/);
  assert.throws(() => timeContext(new Date("invalid"), "UTC"));
  assert.throws(() => timeContext(new Date(), "invalid-zone"));
});
