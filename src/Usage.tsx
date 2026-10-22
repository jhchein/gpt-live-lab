import type { ReactNode } from "react";
import type { SessionMetrics } from "../shared/protocol";
import { NOT_REPORTED, formatCount, formatSeconds } from "./format";
import { JsonView } from "./JsonView";
import { buildExport } from "./trace";
import { MAX_EVENTS, MAX_FRAGMENTS, type LiveSession } from "./useLiveSession";
import { Badge, type Tone } from "./ui";
import { CostBreakdown } from "./CostTicker";

function closeSummary(metrics: SessionMetrics, active: boolean, stopping: boolean, ended: boolean, hasSessionId: boolean): { label: string; tone: Tone; detail: string } {
  if (!hasSessionId && !active) {
    return { label: "no session", tone: "idle", detail: ended ? "No Azure session was created." : "Not started." };
  }
  if (metrics.closeStatus === "confirmed") {
    return { label: "confirmed", tone: "ok", detail: "Azure sent session.closed. Usage fields may still be missing." };
  }
  if (!ended) {
    return stopping || metrics.closeStatus === "requested"
      ? { label: "requested", tone: "warn", detail: "Waiting for session.closed from Azure." }
      : { label: "open", tone: "idle", detail: "Session is running." };
  }
  return {
    label: "unconfirmed", tone: "warn",
    detail: "Session ended without session.closed. Final Live usage is unknown.",
  };
}

function Stat({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return <div className="stat"><dt>{label}</dt><dd>{value}</dd>{note && <dd className="stat-note">{note}</dd>}</div>;
}

export function Usage({ session, deployments }: { session: LiveSession; deployments?: { live: string; reasoning: string } }) {
  const { metrics, metricsReceived, phase, sessionId, startedAt, endedAt } = session;
  const active = phase === "starting" || phase === "live" || phase === "stopping";
  const ended = (phase === "idle" || phase === "error") && startedAt !== undefined;
  const hasSession = startedAt !== undefined || active;
  const none = !metricsReceived ? "no data yet" : undefined;
  const count = (value: number) => (none ?? formatCount(value));
  const tokenFallback = none ?? (metrics.lunaResponses === 0 ? "no response yet" : NOT_REPORTED);
  const token = (value: number | undefined) =>
    value === undefined ? tokenFallback : `${metrics.lunaUsageIncomplete ? "≥ " : ""}${formatCount(value)}`;
  const usage = metrics.lunaUsage;
  const close = closeSummary(metrics, active, phase === "stopping", ended, sessionId !== "");

  const liveValue = metrics.liveSeconds !== undefined
    ? <>{formatSeconds(metrics.liveSeconds)} <Badge tone={metrics.liveUsageFinal ? "ok" : "warn"}>{metrics.liveUsageFinal ? "final" : "provisional"}</Badge></>
    : none ?? NOT_REPORTED;
  const liveNote = metrics.liveSeconds === undefined
    ? (ended ? "Azure reported no Live seconds. Final usage is unknown." : "Waiting for Azure usage.")
    : metrics.liveUsageFinal ? "Final seconds reported in session.closed."
      : "Latest Azure snapshot, not a final billing value.";

  function download() {
    const body = buildExport({
      sessionId, phase, startedAt, endedAt, deployments, metrics, events: session.events, fragments: session.fragments,
      totalEvents: session.totalEvents, totalFragments: session.totalFragments, maxEvents: MAX_EVENTS, maxFragments: MAX_FRAGMENTS,
    });
    const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
    const link = document.createElement("a");
    link.href = url;
    link.download = `gpt-live-lab-session-${stamp}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <section className="panel usage" aria-labelledby="usage-title">
    <div className="panel-head">
      <h2 id="usage-title">Usage</h2>
    </div>
    <dl className="usage-summary">
      <Stat label="Reasoning requests" value={hasSession ? count(metrics.lunaRequests) : "–"} />
      <Stat label="Reasoning tokens" value={hasSession ? token(usage.totalTokens) : "–"} />
      <Stat label="Live seconds" value={hasSession ? liveValue : "–"} />
    </dl>
    <details className="disclosure">
      <summary>Usage details</summary>
      <div className="usage-grid">
        <div className="stat-card">
          <h3>Reasoning requests</h3>
          <dl>
            <Stat label="Started" value={hasSession ? count(metrics.lunaRequests) : "–"} note="Attempts, including failures before HTTP transmission." />
            <Stat label="Responses" value={hasSession ? count(metrics.lunaResponses) : "–"} note="Includes responses whose output was later rejected." />
            <Stat label="Failed" value={hasSession ? count(metrics.lunaFailures) : "–"} note="Includes context and delivery errors, even without HTTP." />
            <Stat label="Cancelled" value={hasSession ? count(metrics.lunaCancelled) : "–"} />
          </dl>
        </div>
        <div className="stat-card">
          <h3>Reasoning tokens</h3>
          <dl>
            <Stat label="Input" value={hasSession ? token(usage.inputTokens) : "–"} note={hasSession ? `Cached subset: ${usage.cachedInputTokens === undefined ? tokenFallback : formatCount(usage.cachedInputTokens)}${metrics.lunaCachedUsageIncomplete ? " (incomplete)" : ""}` : undefined} />
            <Stat label="Output" value={hasSession ? token(usage.outputTokens) : "–"} note={hasSession ? `Reasoning subset: ${usage.reasoningOutputTokens === undefined ? tokenFallback : formatCount(usage.reasoningOutputTokens)}` : undefined} />
            <Stat label="Total reported" value={hasSession ? token(usage.totalTokens) : "–"} />
            <Stat label="Responses with usage" value={hasSession ? (none ?? `${formatCount(metrics.lunaUsageReports)} of ${formatCount(metrics.lunaResponses)}`) : "–"}
              note={metrics.lunaUsageIncomplete ? "Some token fields are missing. Totals are lower bounds." : "Cached and reasoning tokens are already included in input and output."} />
          </dl>
        </div>
        <div className="stat-card">
          <h3>GPT-Live</h3>
          <dl>
            <Stat label="Azure usage" value={hasSession ? liveValue : "–"} note={hasSession ? liveNote : undefined} />
            <Stat label="Session closure" value={hasSession ? <Badge tone={close.tone}>{close.label}</Badge> : "–"} note={hasSession ? close.detail : undefined} />
            {sessionId && <Stat label="Session ID" value={<code>{sessionId}</code>} />}
          </dl>
        </div>
      </div>
    </details>
    {metrics.cost && <details className="disclosure">
      <summary>Estimated cost details</summary>
      <CostBreakdown cost={metrics.cost} />
    </details>}
    {metrics.liveUsage && <details className="disclosure">
      <summary>Raw Live usage</summary>
      <div className="disclosure-body"><JsonView payload={metrics.liveUsage} label="Live usage" /></div>
    </details>}
    <details className="disclosure export">
      <summary>Export session</summary>
      <div className="disclosure-body">
        <p>Downloads conversation text, model requests and responses, and usage as JSON. The export is created locally and is not uploaded.</p>
        <p>Credentials, SDP, encrypted state and microphone identifiers are removed. Free text can still contain private data. Review before sharing. The file includes the latest {MAX_EVENTS} events and {MAX_FRAGMENTS} transcript fragments; totals cover the whole session.</p>
        <button type="button" className="btn" onClick={download} disabled={!hasSession}>Download JSON</button>
      </div>
    </details>
  </section>;
}
