import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { calculateCost, type PricingConfig } from "../shared/pricing.ts";
import { emptySessionMetrics, type SessionMetrics } from "../shared/protocol.ts";
import { CostBreakdown, CostTicker, formatCostUsd } from "../src/CostTicker.tsx";
import { PricingConfigError, readPricing } from "./pricing.ts";

const configured: PricingConfig = {
  liveUsdPerMinute: 60, liveMinimumSeconds: 15, liveRoundingSeconds: 1,
  inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 8, webUsdPerThousand: 7,
};
const metrics = (patch: Partial<SessionMetrics> = {}): SessionMetrics => ({ ...emptySessionMetrics(), ...patch });
const finalLive = (seconds: number) => metrics({ liveSeconds: seconds, liveUsageFinal: true, closeStatus: "confirmed" });
const reasoningMetrics = (patch: Partial<SessionMetrics> = {}) => metrics({
  lunaRequests: 1, lunaResponses: 1, lunaUsageReports: 1, lunaPendingRequests: 0,
  lunaUsage: { inputTokens: 1_000_000, cachedInputTokens: 250_000, outputTokens: 125_000, reasoningOutputTokens: 100_000 },
  ...patch,
});
const rateVariables = [
  "LIVE_USD_PER_MINUTE", "INPUT_USD_PER_MILLION", "CACHED_INPUT_USD_PER_MILLION",
  "OUTPUT_USD_PER_MILLION", "WEB_USD_PER_THOUSAND",
];

test("partial cached usage across steps cannot silently price missing cached tokens as uncached", () => {
  const sample = reasoningMetrics({ lunaCachedUsageIncomplete: true });
  const partial = calculateCost(configured, sample, 0);
  assert.equal(partial.reasoning.complete, false);
  assert.equal(partial.reasoning.inputUsd, undefined);
  assert.match(partial.reasons.join(" "), /Cached input token usage was not reported/);
  const equal = calculateCost({ ...configured, cachedInputUsdPerMillion: configured.inputUsdPerMillion }, sample, 0);
  assert.equal(equal.reasoning.inputUsd, 2);
  assert.equal(equal.reasoning.complete, true);
});

test("uncertain search billing is a subset of outcomes, not a second dispatched request", () => {
  const cost = calculateCost(configured, metrics({ searchRequests: 1, searchFailed: 1, searchUncertain: 1 }), 0);
  assert.equal(cost.search.knownUsd, 0.007);
  assert.doesNotMatch(cost.reasons.join(" "), /counts are incomplete or inconsistent|Search requests are pending/);
  assert.equal(cost.complete, false);
});

test("pricing defaults contain no personal/model rates or unrelated environment keys", () => {
  assert.deepEqual(readPricing({ UNRELATED_PRIVATE_KEY: "fixture-private-value" }), {
    liveUsdPerMinute: undefined, liveMinimumSeconds: 15, liveRoundingSeconds: 1,
    inputUsdPerMillion: undefined, cachedInputUsdPerMillion: undefined, outputUsdPerMillion: undefined,
    webUsdPerThousand: 7,
  });
  assert.ok(!JSON.stringify(readPricing({ UNRELATED_PRIVATE_KEY: "fixture-private-value" })).includes("fixture-private-value"));
});

test("blank rates are unknown, while absent Web pricing uses its explicit default", () => {
  const blank = Object.fromEntries(rateVariables.map((name) => [name, " \t "]));
  const config = readPricing(blank);
  for (const field of ["liveUsdPerMinute", "inputUsdPerMillion", "cachedInputUsdPerMillion", "outputUsdPerMillion", "webUsdPerThousand"] as const) {
    assert.equal(config[field], undefined, field);
  }
  assert.equal(readPricing({}).webUsdPerThousand, 7);
  assert.equal(readPricing({ LIVE_MINIMUM_SECONDS: "", LIVE_ROUNDING_SECONDS: " " }).liveMinimumSeconds, 15);
  assert.equal(readPricing({ LIVE_ROUNDING_SECONDS: "" }).liveRoundingSeconds, 1);
});

test("explicit zero rates and minimum are valid; ordinary decimal and exponent syntax is accepted", () => {
  assert.deepEqual(readPricing({
    ...Object.fromEntries(rateVariables.map((name) => [name, "0"])),
    LIVE_MINIMUM_SECONDS: "0", LIVE_ROUNDING_SECONDS: ".25",
  }), {
    liveUsdPerMinute: 0, liveMinimumSeconds: 0, liveRoundingSeconds: 0.25,
    inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, webUsdPerThousand: 0,
  });
  assert.equal(readPricing({ INPUT_USD_PER_MILLION: " 1.25e+2 " }).inputUsdPerMillion, 125);
  assert.equal(readPricing({ OUTPUT_USD_PER_MILLION: "+.5" }).outputUsdPerMillion, 0.5);
});

test("invalid rates and durations fail with the variable name, never the supplied value", () => {
  for (const name of [...rateVariables, "LIVE_MINIMUM_SECONDS", "LIVE_ROUNDING_SECONDS"]) {
    for (const value of ["-1", "-0.01", "NaN", "Infinity", "-Infinity", "1e308", "1e309", "1e-999", "-1e-999", "0x10", "1_000", "2usd", "1 2", "fixture-private-value"]) {
      assert.throws(() => readPricing({ [name]: value }), (error: unknown) => {
        assert.ok(error instanceof PricingConfigError);
        assert.equal(error.name, "PricingConfigError");
        assert.equal(error.variable, name);
        assert.ok(error.message.startsWith(`${name} must be a finite`));
        assert.ok(!error.message.includes(value));
        return true;
      }, `${name}=${value}`);
    }
  }
  for (const value of ["0", "-0", "0.0", "1e-999"]) {
    assert.throws(() => readPricing({ LIVE_ROUNDING_SECONDS: value }), /LIVE_ROUNDING_SECONDS.*greater than zero/);
  }
});

test("no activity is a known zero, without a fabricated Live timer or minimum charge", () => {
  for (const config of [configured, readPricing({}), readPricing({ WEB_USD_PER_THOUSAND: "" })]) {
    const cost = calculateCost(config, metrics(), 9_999_999);
    assert.equal(cost.totalKnownUsd, 0);
    assert.equal(cost.complete, true);
    assert.equal(cost.provisional, false);
    assert.equal(cost.live.seconds, undefined);
    assert.equal(cost.live.billableSeconds, undefined);
    assert.equal(cost.reasoning.knownUsd, 0);
    assert.equal(cost.search.knownUsd, 0);
    assert.deepEqual(cost.reasons, []);
  }
});

test("default model pricing yields only the known search subtotal, not free model usage", () => {
  const cost = calculateCost(readPricing({}), reasoningMetrics({
    liveStartedAt: 0, searchRequests: 1, searchSucceeded: 1,
  }), 10_000);
  assert.equal(cost.live.billableSeconds, 15);
  assert.equal(cost.live.knownUsd, 0);
  assert.equal(cost.reasoning.knownUsd, 0);
  assert.equal(cost.search.knownUsd, 0.007);
  assert.equal(cost.totalKnownUsd, 0.007);
  assert.equal(cost.complete, false);
  for (const label of ["Live", "Uncached input", "Cached input", "Output"]) {
    assert.ok(cost.reasons.some((reason) => reason.includes(label) && reason.includes("not configured")), label);
  }
});

test("Live minimum and whole-second rounding are exact on either side of each threshold", () => {
  for (const [seconds, expected] of [
    [0, 15], [0.001, 15], [14.999, 15], [15, 15], [15.001, 16], [15.999, 16],
    [16, 16], [16.0001, 17], [59.999, 60], [60, 60], [60.0001, 61],
  ]) {
    const cost = calculateCost(configured, finalLive(seconds), 100_000);
    assert.equal(cost.live.seconds, seconds);
    assert.equal(cost.live.billableSeconds, expected, `${seconds} seconds`);
    assert.equal(cost.live.knownUsd, expected);
    assert.equal(cost.totalKnownUsd, expected);
    assert.equal(cost.complete, true);
    assert.equal(cost.provisional, false);
  }
});

test("Live rounding applies after the minimum, including exact fractional thresholds", () => {
  for (const [minimum, increment, seconds, expected] of [
    [15.1, 2, 1, 16], [15, 10, 15, 20], [0, 0.01, 0.07, 0.07],
    [0, 0.01, 0.07000000000000002, 0.08], [0, 0.1, 0.3, 0.3],
    [0, 0.1, 0.30000000000000004, 0.4], [0, 0.01, 0, 0],
    [0, 1e-7, 3e-7, 3e-7], [0, 1e-7, 3.0000001e-7, 4e-7],
  ]) {
    const cost = calculateCost({ ...configured, liveMinimumSeconds: minimum, liveRoundingSeconds: increment }, finalLive(seconds), 0);
    assert.equal(cost.live.billableSeconds, expected, `${minimum}/${increment}/${seconds}`);
    assert.equal(cost.live.knownUsd, expected);
  }
  assert.equal(calculateCost({ ...configured, liveUsdPerMinute: 4.5 }, finalLive(15), 0).totalKnownUsd, 1.125);
});

test("provisional Live duration is the maximum of reported and elapsed time", () => {
  const base = metrics({ liveStartedAt: 1_000 });
  const local = calculateCost(configured, base, 16_500);
  assert.equal(local.live.seconds, 15.5);
  assert.equal(local.live.billableSeconds, 16);
  assert.equal(local.provisional, true);
  assert.equal(calculateCost(configured, { ...base, liveSeconds: 5 }, 16_500).live.seconds, 15.5);
  assert.equal(calculateCost(configured, { ...base, liveSeconds: 30 }, 16_500).live.seconds, 30);
  assert.equal(calculateCost(configured, base, 0).live.seconds, 0);
});

test("Live per-minute division preserves terminating decimals and correctly rounds repeating amounts", () => {
  const price = (rate: number, seconds: number, increment = 1e-7) =>
    calculateCost({
      ...configured, liveMinimumSeconds: 0, liveRoundingSeconds: increment, liveUsdPerMinute: rate,
    }, finalLive(seconds), 0).live.knownUsd;
  assert.equal(price(60, 4e-7), 4e-7);
  assert.equal(price(0.06, 15, 1), 0.015);
  assert.equal(price(0.0123456, 61, 1), 0.01255136);
  assert.equal(price(60, 0), 0);
  assert.equal(price(1, 1, 1), 1 / 60);
  assert.equal(price(1, 7, 1), 7 / 60);
  assert.equal(price(0.1, 7, 1), 7 / 600);
  assert.equal(price(1, 1000, 1), 1000 / 60);
});

test("a local end freezes the timer but unconfirmed closure remains provisional", () => {
  const ended = metrics({ liveStartedAt: 1_000, liveEndedAt: 16_500, closeStatus: "unconfirmed" });
  const cost = calculateCost(configured, ended, 100_000);
  assert.equal(cost.live.seconds, 15.5);
  assert.equal(cost.live.billableSeconds, 16);
  assert.equal(cost.provisional, true);
  assert.match(cost.reasons.join(" "), /provisional/);
  assert.deepEqual(calculateCost(configured, ended, 1_000_000), cost);
});

test("final reported usage overrides both local and previously reported time, permitting downward corrections", () => {
  const initial = metrics({ liveStartedAt: 0, liveEndedAt: 80_000, liveSeconds: 90, closeStatus: "unconfirmed" });
  const before = calculateCost(configured, initial, 100_000);
  const after = calculateCost(configured, { ...initial, liveSeconds: 4, liveUsageFinal: true }, 100_000);
  assert.equal(before.totalKnownUsd, 90);
  assert.equal(after.live.seconds, 4);
  assert.equal(after.totalKnownUsd, 15);
  assert.equal(after.provisional, false);
  assert.equal(after.complete, true);
  assert.equal(calculateCost(configured, finalLive(100), 0).totalKnownUsd, 100);
});

test("missing Live duration remains unknown, even after confirmed closure", () => {
  for (const closeStatus of ["requested", "confirmed", "unconfirmed"] as const) {
    const cost = calculateCost(configured, metrics({ closeStatus }), 1_000_000);
    assert.equal(cost.live.seconds, undefined);
    assert.equal(cost.live.billableSeconds, undefined);
    assert.equal(cost.live.knownUsd, 0);
    assert.equal(cost.complete, false);
    assert.ok(cost.reasons.some((reason) => reason.includes("duration is unknown")));
  }
  assert.equal(calculateCost(configured, metrics({ liveSeconds: 4 }), 1_000_000).live.billableSeconds, 15);
  const closed = calculateCost(configured, metrics({ liveStartedAt: 0, liveEndedAt: 20_000, closeStatus: "confirmed" }), 50_000);
  assert.equal(closed.provisional, true);
  assert.match(closed.reasons.join(" "), /final Live seconds were not reported/);
});

test("cached input and reasoning output are subsets, never double-counted", () => {
  const cost = calculateCost(configured, reasoningMetrics(), 0);
  assert.equal(cost.reasoning.inputUsd, 1.5);
  assert.equal(cost.reasoning.cachedInputUsd, 0.125);
  assert.equal(cost.reasoning.outputUsd, 1);
  assert.equal(cost.reasoning.knownUsd, 2.625);
  assert.equal(cost.totalKnownUsd, 2.625);
  assert.equal(cost.complete, true);
  assert.equal(cost.reasoning.inputIncludesCached, false);
});

test("an unknown cached split is priceable only when both known input rates match", () => {
  const usage = reasoningMetrics({ lunaUsage: { inputTokens: 1_000, outputTokens: 1_000 } });
  const unknown = calculateCost(configured, usage, 0);
  assert.equal(unknown.reasoning.inputUsd, undefined);
  assert.equal(unknown.reasoning.cachedInputUsd, undefined);
  assert.equal(unknown.totalKnownUsd, 0.008);
  assert.equal(unknown.complete, false);
  assert.match(unknown.reasons.join(" "), /Cached input token usage was not reported/);
  const equal = calculateCost({ ...configured, cachedInputUsdPerMillion: 2 }, usage, 0);
  assert.equal(equal.reasoning.inputUsd, 0.002);
  assert.equal(equal.reasoning.cachedInputUsd, undefined);
  assert.equal(equal.reasoning.inputIncludesCached, true);
  assert.equal(equal.totalKnownUsd, 0.01);
  assert.equal(equal.complete, true);
});

test("missing rates preserve known input/output subtotals without treating unknown prices as zero", () => {
  const missingCached = calculateCost({ ...configured, cachedInputUsdPerMillion: undefined }, reasoningMetrics(), 0);
  assert.equal(missingCached.reasoning.inputUsd, 1.5);
  assert.equal(missingCached.reasoning.cachedInputUsd, undefined);
  assert.equal(missingCached.reasoning.outputUsd, 1);
  assert.equal(missingCached.totalKnownUsd, 2.5);
  assert.equal(missingCached.complete, false);
  const missingInput = calculateCost(configured, reasoningMetrics({
    lunaUsage: { cachedInputTokens: 100_000, outputTokens: 0 },
  }), 0);
  assert.equal(missingInput.totalKnownUsd, 0.05);
  assert.equal(missingInput.complete, false);
});

test("reported zero tokens and zero rates are valid, unlike missing usage", () => {
  const zeroUsage = reasoningMetrics({ lunaUsage: { inputTokens: 0, outputTokens: 0 } });
  const unknownRates = readPricing({});
  assert.equal(calculateCost(unknownRates, zeroUsage, 0).complete, true);
  const zeroRates = { ...configured, inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  assert.equal(calculateCost(zeroRates, reasoningMetrics(), 0).totalKnownUsd, 0);
  assert.equal(calculateCost(zeroRates, reasoningMetrics(), 0).complete, true);
  const missing = calculateCost(zeroRates, reasoningMetrics({ lunaUsage: {} }), 0);
  assert.equal(missing.totalKnownUsd, 0);
  assert.equal(missing.complete, false);
});

test("decimal prices and known-subtotal addition do not add binary arithmetic artifacts", () => {
  const tiny = calculateCost({ ...configured, inputUsdPerMillion: 0.1, cachedInputUsdPerMillion: 0.1 }, reasoningMetrics({
    lunaUsage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 },
  }), 0);
  assert.equal(tiny.totalKnownUsd, 0.0000001);
  const sum = calculateCost({ ...configured, inputUsdPerMillion: 100_000, outputUsdPerMillion: 200_000 }, reasoningMetrics({
    lunaUsage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
  }), 0);
  assert.equal(sum.totalKnownUsd, 0.3);
});

test("total tokens or reasoning subset alone never fabricate input or output totals", () => {
  for (const lunaUsage of [{ totalTokens: 100 }, { reasoningOutputTokens: 100 }, {}]) {
    const cost = calculateCost(configured, reasoningMetrics({ lunaUsage }), 0);
    assert.equal(cost.reasoning.inputUsd, undefined);
    assert.equal(cost.reasoning.outputUsd, undefined);
    assert.equal(cost.totalKnownUsd, 0);
    assert.equal(cost.complete, false);
  }
  const invalid = calculateCost(configured, reasoningMetrics({
    lunaUsage: { inputTokens: 10, cachedInputTokens: 11, outputTokens: 1_000 },
  }), 0);
  assert.equal(invalid.reasoning.inputUsd, undefined);
  assert.equal(invalid.reasoning.cachedInputUsd, undefined);
  assert.equal(invalid.totalKnownUsd, 0.008);
  assert.match(invalid.reasons.join(" "), /exceeds total input/);
});

test("pending and partial reasoning usage remain incomplete, preserving only reported costs", () => {
  for (const patch of [
    { lunaPendingRequests: 1 },
    { lunaRequests: 2, lunaPendingRequests: undefined },
    { lunaUsageIncomplete: true },
    { lunaResponses: 2 },
  ]) {
    const cost = calculateCost(configured, reasoningMetrics(patch), 0);
    assert.equal(cost.totalKnownUsd, 2.625);
    assert.equal(cost.complete, false);
    assert.ok(cost.reasons.some((reason) => /pending|incomplete/.test(reason)));
  }
  assert.equal(calculateCost(configured, reasoningMetrics({ lunaPendingRequests: 1 }), 0).provisional, true);
  for (const patch of [{ lunaFailures: 1 }, { lunaCancelled: 1 }]) {
    const cost = calculateCost(configured, metrics({ lunaRequests: 1, ...patch }), 0);
    assert.equal(cost.complete, false);
    assert.equal(cost.totalKnownUsd, 0);
  }
});

test("search uses dispatched requests, including failures and uncertain outcomes, not successful-only charges", () => {
  const cost = calculateCost(configured, metrics({
    searchRequests: 4, searchSucceeded: 2, searchFailed: 1, searchUncertain: 1,
  }), 0);
  assert.equal(cost.search.knownUsd, 0.028);
  assert.equal(cost.totalKnownUsd, 0.028);
  assert.equal(cost.complete, false);
  assert.equal(cost.provisional, true);
  assert.match(cost.reasons.join(" "), /not an invoice/);
  assert.match(cost.reasons.join(" "), /may still be billable/);
});

test("search pending, missing counts and missing rates are explicit, without inventing requests", () => {
  const pending = calculateCost(configured, metrics({ searchRequests: 2, searchSucceeded: 1 }), 0);
  assert.equal(pending.totalKnownUsd, 0.014);
  assert.equal(pending.complete, false);
  assert.equal(pending.provisional, true);
  assert.match(pending.reasons.join(" "), /Search requests are pending/);
  const noCount = calculateCost(configured, metrics({ searchSucceeded: 1 }), 0);
  assert.equal(noCount.search.requests, 0);
  assert.equal(noCount.totalKnownUsd, 0);
  assert.equal(noCount.complete, false);
  const unknown = calculateCost({ ...configured, webUsdPerThousand: undefined }, metrics({ searchRequests: 1, searchSucceeded: 1 }), 0);
  assert.equal(unknown.totalKnownUsd, 0);
  assert.equal(unknown.complete, false);
  assert.match(unknown.reasons.join(" "), /Search USD-per-thousand rate is not configured/);
});

test("successful searches with explicit zero pricing are known zero; enabling search alone is not usage", () => {
  const zero = calculateCost({ ...configured, webUsdPerThousand: 0 }, metrics({ searchRequests: 1, searchSucceeded: 1 }), 0);
  assert.equal(zero.totalKnownUsd, 0);
  assert.equal(zero.complete, true);
  assert.equal(zero.provisional, false);
  const enabled = calculateCost(readPricing({ WEB_USD_PER_THOUSAND: "" }), metrics({ webSearchEnabled: true }), 0);
  assert.equal(enabled.totalKnownUsd, 0);
  assert.equal(enabled.complete, true);
  assert.deepEqual(enabled.reasons, []);
});

test("calculation is deterministic, USD-only and does not mutate config, metrics, or nested usage", () => {
  const config = Object.freeze({ ...configured });
  const usage = Object.freeze({ ...reasoningMetrics().lunaUsage });
  const input = Object.freeze({ ...reasoningMetrics(), lunaUsage: usage, liveStartedAt: 0 });
  const before = JSON.stringify({ config, input });
  const first = calculateCost(config, input, 20_000);
  assert.equal(first.currency, "USD");
  assert.deepEqual(calculateCost(config, input, 20_000), first);
  assert.equal(JSON.stringify({ config, input }), before);
});

test("ticker renders unknown rates, visible small amounts, reusable reasons and downward corrections", () => {
  assert.match(renderToStaticMarkup(createElement(CostTicker, {})), /Start a session/);
  const unknown = calculateCost(readPricing({}), finalLive(30), 0);
  assert.match(renderToStaticMarkup(createElement(CostTicker, { cost: unknown })), /Rates not configured/);
  const before = calculateCost({ ...configured, liveUsdPerMinute: 2 }, finalLive(30), 0);
  const after = calculateCost({ ...configured, liveUsdPerMinute: 2 }, finalLive(5), 0);
  assert.match(renderToStaticMarkup(createElement(CostTicker, { cost: before })), /\$1\.000000/);
  assert.match(renderToStaticMarkup(createElement(CostTicker, { cost: after })), /\$0\.500000/);
  const details = renderToStaticMarkup(createElement(CostBreakdown, { cost: unknown }));
  assert.match(details, /Live USD-per-minute rate is not configured/);
  assert.match(details, /unknown usage or rates are not treated as free/);
  assert.match(details, /not an invoice/);
  assert.equal(formatCostUsd(0.0000001), "$0.0000001");
  assert.equal(formatCostUsd(0.00000000001), "$1.0000e-11");
  assert.equal(formatCostUsd(0), "$0.000000");
});
