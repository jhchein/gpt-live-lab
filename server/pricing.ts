import type { PricingConfig } from "../shared/pricing.ts";

export class PricingConfigError extends Error {
  constructor(public readonly variable: string, requirement: string) {
    super(`${variable} must be ${requirement}.`);
    this.name = "PricingConfigError";
  }
}

/**
 * Reads only the supplied map, never process.env. Unset Web pricing defaults to
 * $7/thousand; an explicitly blank rate is unknown. No model rate defaults.
 */
export function readPricing(env: Readonly<Record<string, string | undefined>>): PricingConfig {
  const number = (name: string, fallback?: number, positive = false): number | undefined => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = raw.trim();
    if (!value) return undefined;
    const parsed = Number(value);
    // Do not silently turn a nonzero, underflowing price into a free rate.
    const underflows = parsed === 0 && /[1-9]/.test(value.split(/[eE]/)[0]);
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) ||
      !Number.isFinite(parsed) || parsed > Number.MAX_SAFE_INTEGER || underflows || (positive ? parsed <= 0 : parsed < 0)) {
      throw new PricingConfigError(name, positive
        ? "a finite number greater than zero and no greater than Number.MAX_SAFE_INTEGER"
        : "a finite non-negative number no greater than Number.MAX_SAFE_INTEGER");
    }
    return parsed;
  };
  return {
    liveUsdPerMinute: number("LIVE_USD_PER_MINUTE"),
    liveMinimumSeconds: number("LIVE_MINIMUM_SECONDS", 15) ?? 15,
    liveRoundingSeconds: number("LIVE_ROUNDING_SECONDS", 1, true) ?? 1,
    inputUsdPerMillion: number("INPUT_USD_PER_MILLION"),
    cachedInputUsdPerMillion: number("CACHED_INPUT_USD_PER_MILLION"),
    outputUsdPerMillion: number("OUTPUT_USD_PER_MILLION"),
    webUsdPerThousand: number("WEB_USD_PER_THOUSAND", 7),
  };
}
