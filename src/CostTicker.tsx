import type { CostEstimate } from "../shared/pricing";

export function formatCostUsd(value: number): string {
  if (value > 0 && value < 0.0000000001) return `$${value.toExponential(4)}`;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 10 })}`;
}

/** Shared with the Usage panel; no local clock, inferred tokens, or animation. */
export function CostBreakdown({ cost }: { cost: CostEstimate }) {
  const { live, reasoning, search } = cost;
  const amount = (value: number | undefined) => value === undefined ? "Unknown" : formatCostUsd(value);
  return <div className="cost-breakdown">
    <dl>
      <dt>Live · known subtotal</dt><dd>{formatCostUsd(live.knownUsd)}</dd>
      {live.seconds !== undefined && <><dt>Live seconds</dt><dd>{live.seconds.toFixed(2)} estimated/reported · {live.billableSeconds} billable estimate</dd></>}
      <dt>Reasoning · known subtotal</dt><dd>{formatCostUsd(reasoning.knownUsd)}</dd>
      <dt>{reasoning.inputIncludesCached ? "Input (cached included)" : "Uncached input"}</dt><dd>{amount(reasoning.inputUsd)}</dd>
      <dt>Cached input</dt><dd>{reasoning.inputIncludesCached ? "Included in input; not added again" : amount(reasoning.cachedInputUsd)}</dd>
      <dt>Output (reasoning subset included)</dt><dd>{amount(reasoning.outputUsd)}</dd>
      <dt>Search · known subtotal</dt><dd>{formatCostUsd(search.knownUsd)} · {search.requests} requests</dd>
      <dt>Total · known subtotal</dt><dd>{formatCostUsd(cost.totalKnownUsd)}</dd>
    </dl>
    <p>{cost.complete ? "All applicable usage and rates accounted for." : "Partial estimate; unknown usage or rates are not treated as free."}
      {cost.provisional ? " Provisional; corrections can increase or decrease the estimate." : ""}
      {" "}Estimate only, not an invoice.</p>
    {cost.reasons.length > 0 && <ul>{cost.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
  </div>;
}

export function CostTicker({ cost }: { cost?: CostEstimate }) {
  const hasRates = cost !== undefined && (
    cost.live.usdPerMinute !== undefined || cost.reasoning.inputUsdPerMillion !== undefined ||
    cost.reasoning.cachedInputUsdPerMillion !== undefined || cost.reasoning.outputUsdPerMillion !== undefined ||
    (cost.search.requests > 0 && cost.search.usdPerThousand !== undefined)
  );
  return <details className="cost-ticker disclosure">
    <summary>
      <span>Estimated cost · USD</span>{" "}
      <strong>{cost === undefined ? "Start a session" : hasRates ? formatCostUsd(cost.totalKnownUsd) : "Rates not configured"}</strong>
      {cost && hasRates && (!cost.complete || cost.provisional) && <span> · {cost.complete ? "provisional" : "known subtotal"}</span>}
    </summary>
    {cost ? <CostBreakdown cost={cost} /> : <p>Waiting for backend cost data. No usage or prices are inferred.</p>}
  </details>;
}
