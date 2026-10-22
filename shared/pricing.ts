import type { SessionMetrics } from "./protocol.ts";

/** Public, USD-only rates. No credentials or model-specific default prices. */
export interface PricingConfig {
  liveUsdPerMinute?: number;
  liveMinimumSeconds: number;
  liveRoundingSeconds: number;
  inputUsdPerMillion?: number;
  cachedInputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  webUsdPerThousand?: number;
}

export interface CostSubtotal {
  /** Only usage that can actually be priced; not a claim that other usage was free. */
  knownUsd: number;
  complete: boolean;
}

export interface LiveCost extends CostSubtotal {
  seconds?: number;
  billableSeconds?: number;
  usdPerMinute?: number;
  provisional: boolean;
}

export interface ReasoningCost extends CostSubtotal {
  inputUsd?: number;
  cachedInputUsd?: number;
  outputUsd?: number;
  /** An unknown cached split can still be priced when the two input rates match. */
  inputIncludesCached: boolean;
  inputUsdPerMillion?: number;
  cachedInputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}

export interface SearchCost extends CostSubtotal {
  requests: number;
  succeeded: number;
  failed: number;
  uncertain: number;
  usdPerThousand?: number;
}

export interface CostEstimate {
  currency: "USD";
  live: LiveCost;
  reasoning: ReasoningCost;
  search: SearchCost;
  totalKnownUsd: number;
  /** All applicable rates and usage are known, independently of provisional status. */
  complete: boolean;
  provisional: boolean;
  reasons: string[];
}

// Round decimal seconds at the actual threshold, rather than e.g. treating
// 0.07 / 0.01 = 7.000000000000001 as eight increments.
function decimal(value: number): { coefficient: bigint; exponent: number } {
  const [mantissa, power = "0"] = value.toString().toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  return { coefficient: BigInt(whole + fraction), exponent: Number(power) - fraction.length };
}

function roundSeconds(seconds: number, increment: number): number {
  const value = decimal(seconds);
  const step = decimal(increment);
  const exponent = Math.min(value.exponent, step.exponent);
  const numerator = value.coefficient * 10n ** BigInt(value.exponent - exponent);
  const denominator = step.coefficient * 10n ** BigInt(step.exponent - exponent);
  const units = (numerator + denominator - 1n) / denominator;
  return Number(`${units * step.coefficient}e${step.exponent}`);
}

function multiplyDecimal(left: number, right: number, decimalPlaces = 0): number {
  const a = decimal(left);
  const b = decimal(right);
  return Number(`${a.coefficient * b.coefficient}e${a.exponent + b.exponent - decimalPlaces}`);
}

function liveUsd(seconds: number, rate: number): number {
  const time = decimal(seconds);
  const price = decimal(rate);
  // Divide before converting to binary64, avoiding a double-rounded product.
  // A nonzero remainder contributes a sticky digit after forty guard places.
  const numerator = time.coefficient * price.coefficient * 10n ** 40n;
  const quotient = numerator / 60n;
  const inexact = numerator % 60n !== 0n;
  return Number(`${quotient}${inexact ? "5" : ""}e${time.exponent + price.exponent - 40 - (inexact ? 1 : 0)}`);
}

function sumUsd(...values: number[]): number {
  const parts = values.map(decimal);
  const exponent = Math.min(...parts.map((part) => part.exponent));
  const coefficient = parts.reduce((sum, part) =>
    sum + part.coefficient * 10n ** BigInt(part.exponent - exponent), 0n);
  return Number(`${coefficient}e${exponent}`);
}

/** Pure estimate from reported usage and a caller-owned clock; never estimates tokens. */
export function calculateCost(config: PricingConfig, metrics: SessionMetrics, now: number): CostEstimate {
  const reasons: string[] = [];
  const live: LiveCost = {
    knownUsd: 0, complete: true, provisional: false, usdPerMinute: config.liveUsdPerMinute,
  };
  const hasLive = metrics.liveStartedAt !== undefined || metrics.liveEndedAt !== undefined ||
    metrics.liveSeconds !== undefined || metrics.liveUsageFinal || metrics.closeStatus !== "open";
  if (hasLive) {
    const finalSeconds = metrics.liveUsageFinal && metrics.liveSeconds !== undefined;
    const localSeconds = metrics.liveStartedAt === undefined ? undefined
      : Math.max(0, ((metrics.liveEndedAt ?? now) - metrics.liveStartedAt) / 1000);
    live.seconds = finalSeconds ? metrics.liveSeconds
      : localSeconds === undefined ? metrics.liveSeconds
        : Math.max(metrics.liveSeconds ?? 0, localSeconds);
    live.provisional = !finalSeconds;
    if (live.provisional) {
      reasons.push(metrics.closeStatus === "confirmed"
        ? "Live closure is confirmed, but final Live seconds were not reported."
        : "Live usage is provisional; final usage or confirmed closure has not been received.");
    }
    if (live.seconds === undefined) {
      live.complete = false;
      reasons.push("Live duration is unknown: no reported seconds or local session timer.");
    } else {
      live.billableSeconds = roundSeconds(Math.max(config.liveMinimumSeconds, live.seconds), config.liveRoundingSeconds);
    }
    if (config.liveUsdPerMinute === undefined) {
      live.complete = false;
      reasons.push("Live USD-per-minute rate is not configured.");
    } else if (live.billableSeconds !== undefined) {
      live.knownUsd = liveUsd(live.billableSeconds, config.liveUsdPerMinute);
    }
  }

  const reasoning: ReasoningCost = {
    knownUsd: 0, complete: true, inputIncludesCached: false,
    inputUsdPerMillion: config.inputUsdPerMillion,
    cachedInputUsdPerMillion: config.cachedInputUsdPerMillion,
    outputUsdPerMillion: config.outputUsdPerMillion,
  };
  const usage = metrics.lunaUsage;
  const pending = metrics.lunaPendingRequests ??
    Math.max(0, metrics.lunaRequests - metrics.lunaResponses - metrics.lunaFailures - metrics.lunaCancelled);
  const hasReasoning = metrics.lunaRequests > 0 || metrics.lunaResponses > 0 ||
    metrics.lunaFailures > 0 || metrics.lunaCancelled > 0 || metrics.lunaUsageReports > 0 ||
    pending > 0 || metrics.lunaUsageIncomplete || Object.values(usage).some((value) => value !== undefined);
  const missingReasoning = (reason: string) => { reasoning.complete = false; reasons.push(reason); };
  const tokenCost = (tokens: number | undefined, rate: number | undefined, label: string): number | undefined => {
    if (tokens === undefined) {
      missingReasoning(`${label} token usage was not reported.`);
      if (rate === undefined) missingReasoning(`${label} USD-per-million rate is not configured.`);
      return undefined;
    }
    if (tokens === 0) return 0; // Reported zero usage is known even without a rate.
    if (rate === undefined) {
      missingReasoning(`${label} USD-per-million rate is not configured.`);
      return undefined;
    }
    return multiplyDecimal(tokens, rate, 6);
  };
  if (!hasReasoning) {
    reasoning.inputUsd = reasoning.cachedInputUsd = reasoning.outputUsd = 0;
  } else {
    if (pending > 0) missingReasoning("Reasoning requests are pending; their usage is not yet known.");
    if (metrics.lunaUsageIncomplete || metrics.lunaUsageReports < metrics.lunaResponses) {
      missingReasoning("Reasoning usage is incomplete; reported totals may be partial.");
    }
    const { inputTokens } = usage;
    const cachedInputTokens = metrics.lunaCachedUsageIncomplete ? undefined : usage.cachedInputTokens;
    if (inputTokens === 0 && (cachedInputTokens === undefined || cachedInputTokens === 0)) {
      reasoning.inputUsd = reasoning.cachedInputUsd = 0;
    } else if (cachedInputTokens !== undefined) {
      if (inputTokens !== undefined && cachedInputTokens > inputTokens) {
        missingReasoning("Cached input token usage exceeds total input; the input split cannot be priced.");
      } else {
        reasoning.inputUsd = tokenCost(inputTokens === undefined ? undefined : inputTokens - cachedInputTokens,
          config.inputUsdPerMillion, "Uncached input");
        reasoning.cachedInputUsd = tokenCost(cachedInputTokens, config.cachedInputUsdPerMillion, "Cached input");
      }
    } else if (inputTokens !== undefined && config.inputUsdPerMillion !== undefined &&
      config.inputUsdPerMillion === config.cachedInputUsdPerMillion) {
      reasoning.inputUsd = tokenCost(inputTokens, config.inputUsdPerMillion, "Input");
      reasoning.inputIncludesCached = true;
    } else {
      missingReasoning("Cached input token usage was not reported; the input cost cannot be split across rates.");
      if (inputTokens === undefined) missingReasoning("Input token usage was not reported.");
      if (config.inputUsdPerMillion === undefined) missingReasoning("Uncached input USD-per-million rate is not configured.");
      if (config.cachedInputUsdPerMillion === undefined) missingReasoning("Cached input USD-per-million rate is not configured.");
    }
    // reasoningOutputTokens is already a subset of outputTokens, never an extra charge.
    reasoning.outputUsd = tokenCost(usage.outputTokens, config.outputUsdPerMillion, "Output");
    reasoning.knownUsd = sumUsd(reasoning.inputUsd ?? 0, reasoning.cachedInputUsd ?? 0, reasoning.outputUsd ?? 0);
  }

  const search: SearchCost = {
    knownUsd: 0, complete: true,
    requests: metrics.searchRequests ?? 0, succeeded: metrics.searchSucceeded ?? 0,
    failed: metrics.searchFailed ?? 0, uncertain: metrics.searchUncertain ?? 0,
    usdPerThousand: config.webUsdPerThousand,
  };
  const hasSearch = search.requests > 0 || search.succeeded > 0 || search.failed > 0 || search.uncertain > 0;
  if (hasSearch) {
    reasons.push("Search cost estimates dispatched requests, not an invoice or confirmed billable searches.");
    if (config.webUsdPerThousand === undefined) {
      search.complete = false;
      reasons.push("Search USD-per-thousand rate is not configured.");
    } else {
      search.knownUsd = multiplyDecimal(search.requests, config.webUsdPerThousand, 3);
    }
    if (metrics.searchRequests === undefined || search.succeeded + search.failed > search.requests) {
      search.complete = false;
      reasons.push("Search request counts are incomplete or inconsistent.");
    }
    if (search.failed > 0 || search.uncertain > 0) {
      search.complete = false;
      reasons.push("Search failures or uncertain outcomes may still be billable; charges are uncertain.");
    }
  }
  // Uncertain billing is a subset of completed/failed requests, not another outcome.
  const searchPending = search.requests > search.succeeded + search.failed;
  if (searchPending) {
    search.complete = false;
    reasons.push("Search requests are pending; their outcomes are not yet known.");
  }

  return {
    currency: "USD", live, reasoning, search,
    totalKnownUsd: sumUsd(live.knownUsd, reasoning.knownUsd, search.knownUsd),
    complete: live.complete && reasoning.complete && search.complete,
    provisional: live.provisional || pending > 0 || searchPending || search.failed > 0 || search.uncertain > 0,
    reasons,
  };
}
