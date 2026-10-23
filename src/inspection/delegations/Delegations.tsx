import { useState, type ReactNode } from "react";
import { NOT_REPORTED, byteLength, formatBytes, formatCount, formatDuration, formatOffset, shortId } from "../../ui/format";
import { JsonView } from "../../ui/JsonView";
import { buildWaterfall, describeStep, hasUsage, readLunaRequest, readLunaResponse, simpleEntries, type Chunk, type Delegation } from "./model";
import { severityOf, timeOf } from "../events";
import { MAX_EVENTS } from "../observation";
import { Badge, SeverityTag, SourceTag, severityTone, type Tone } from "../../ui/indicators";
import type { TraceEvent } from "../../../shared/protocol";

const contextLabels: Record<string, string> = { fragments: "Fragments", snapshotBytes: "Snapshot size" };

function status(d: Delegation): { label: string; tone: Tone } {
  switch (d.status) {
    case "failed": return { label: "Failed", tone: "bad" };
    case "cancelled": return { label: "Cancelled", tone: "warn" };
    case "rejected": return { label: "Rejected", tone: "warn" };
    case "waiting": return { label: "Waiting", tone: "idle" };
    case "running": return { label: "Reasoning", tone: "accent" };
    default:
      if (!d.chunks.length) return { label: "Response received", tone: "accent" };
      return d.acks.length >= d.chunks.length
        ? { label: "Accepted by Azure", tone: "ok" }
        : { label: "Sent to GPT-Live", tone: "info" };
  }
}

function eventMessage(event: TraceEvent | undefined): string | undefined {
  const payload = event?.payload;
  return typeof payload === "object" && payload !== null && "message" in payload && typeof payload.message === "string"
    ? payload.message : undefined;
}

function Waterfall({ d, now }: { d: Delegation; now: number }) {
  const { span, lanes } = buildWaterfall(d, now);
  const pct = (ms: number) => Math.min(100, Math.max(0, (ms / span) * 100));
  return <div className="waterfall" role="group" aria-label="Delegation timeline">
    <div className="wf-lane wf-axis" aria-hidden="true">
      <span />
      <div className="wf-scale"><span>0 s</span><span>{formatDuration(span / 2)}</span><span>{formatDuration(span)}</span></div>
      <span />
    </div>
    {lanes.map((lane) => <div className={`wf-lane tone-${lane.tone} ${lane.empty ? "is-empty" : ""}`} key={lane.key}>
      <span className="wf-label">{lane.label}</span>
      <div className="wf-track" aria-hidden="true">
        {lane.from !== undefined && lane.to !== undefined && <i className={`wf-bar ${lane.open ? "is-open" : ""}`}
          style={{ left: `min(${pct(lane.from)}%, calc(100% - 6px))`, width: `max(${Math.max(0, pct(lane.to) - pct(lane.from))}%, 6px)` }} />}
        {lane.ticks.map((tick, index) => <i className="wf-tick" key={index}
          style={{ left: `clamp(0px, calc(${pct(tick)}% - 4px), calc(100% - 8px))` }} />)}
      </div>
      <span className="wf-value">{lane.value}</span>
    </div>)}
  </div>;
}

function StepRow({ event, offset, title, detail }: { event: TraceEvent; offset: number; title: string; detail?: string }) {
  const [open, setOpen] = useState(false);
  const severity = severityOf(event);
  return <li className={`step tone-${severityTone(severity)}`}>
    <details onToggle={(toggle) => setOpen(toggle.currentTarget.open)}>
      <summary>
        <span className="step-time">{Number.isFinite(offset) ? formatOffset(offset) : "time unknown"}</span>
        <span className="step-main">
          <span className="step-title">{title} <SeverityTag severity={severity} /></span>
          <span className="step-sub"><SourceTag source={event.source} /><code>{event.type}</code>{detail && <span>{detail}</span>}</span>
        </span>
        {event.durationMs !== undefined && <span className="step-duration">{formatDuration(event.durationMs)}</span>}
      </summary>
      {open && <div className="step-json"><JsonView payload={event.payload} label={`Payload for ${event.type}`} /></div>}
    </details>
  </li>;
}

function stepDetail(event: TraceEvent, chunk?: Chunk): string | undefined {
  const payload = event.payload as Record<string, unknown> | null;
  switch (event.type) {
    case "delegation.queued":
      return typeof payload?.queueLength === "number" ? `Queue: ${payload.queueLength}` : undefined;
    case "luna.context.ready":
      return simpleEntries(payload).map(([key, value]) => `${contextLabels[key] ?? key}: ${value}`).join(", ") || undefined;
    case "luna.request":
      return typeof payload?.model === "string" ? payload.model : undefined;
    case "luna.failed":
    case "luna.cancelled":
      return eventMessage(event);
    case "session.thinking.append":
    case "session.commentary.append":
      return chunk?.bytes === undefined ? undefined : formatBytes(chunk.bytes);
    default:
      return undefined;
  }
}

function Section({ title, meta, children, initiallyOpen = false }: { title: string; meta?: string; children: ReactNode; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return <details className="sect" open={open} onToggle={(toggle) => setOpen(toggle.currentTarget.open)}>
    <summary><span className="sect-title">{title}</span>{meta && <span className="sect-meta">{meta}</span>}</summary>
    <div className="sect-body">{children}</div>
  </details>;
}

function Card({ d, open, onToggle, now, partial }: {
  d: Delegation; open: boolean; onToggle: (open: boolean) => void; now: number; partial: boolean;
}) {
  const state = status(d);
  const request = d.request ? readLunaRequest(d.request.payload) : undefined;
  const response = d.response ? readLunaResponse(d.response.payload) : undefined;
  const lunaMs = d.response?.durationMs ?? d.failure?.durationMs ?? d.cancelled?.durationMs;
  const total = Number.isFinite(d.end - d.start) ? d.end - d.start : undefined;
  const contextEntries = d.ready ? simpleEntries(d.ready.payload) : [];
  const bodyId = `delegation-body-${encodeURIComponent(d.id)}`;
  const failureMessage = eventMessage(d.failure) ?? eventMessage(d.cancelled);
  const hint = d.status === "failed" || d.status === "cancelled" || d.status === "rejected";

  const chunkNumber = new Map<string, number>();
  d.chunks.forEach((chunk, index) => {
    chunkNumber.set(chunk.append.id, index + 1);
    if (chunk.ack) chunkNumber.set(chunk.ack.id, index + 1);
  });
  const chunkByEvent = new Map(d.chunks.map((chunk) => [chunk.append.id, chunk]));

  return <article className={`dlg tone-${state.tone}`} id={`delegation-${encodeURIComponent(d.id)}`}>
    <h3 className="dlg-head">
      <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => onToggle(!open)}>
        <span className="dlg-title">Delegation <code title={d.id}>{shortId(d.id)}</code></span>
        <Badge tone={state.tone}>{state.label}</Badge>
        <span className="dlg-figures">
          <span>Reasoning {formatDuration(lunaMs, d.request ? "running" : "not started")}</span>
          <span>Total {formatDuration(total)}</span>
          <span>{response && hasUsage(response.usage) ? `${formatCount(response.usage.totalTokens)} tokens` : "Tokens not reported"}</span>
        </span>
        <span className="chevron" aria-hidden="true" />
      </button>
    </h3>
    {open && <div className="dlg-body" id={bodyId}>
      {partial && <p className="callout tone-warn">Earlier events left the buffer. This timeline is incomplete.</p>}
      <Waterfall d={d} now={now} />
      {d.duplicates.length > 0 && <p className="hint">{d.duplicates.length} duplicate events ignored. Only one reasoning request ran.</p>}
      {d.chunks.length > 0 && <p className="hint">Azure acceptance confirms delivery, not spoken or audible output.</p>}
      {(d.searches.length > 0 || d.sources.length > 0) && <div className="search-sources">
        <h4>Web search</h4>
        <ul>{d.searches.map((event) => <li key={event.id}>
          {event.type === "search.failed" ? "Failed: " : "Query: "}
          {typeof event.payload === "object" && event.payload !== null && "query" in event.payload
            ? String(event.payload.query) : "See trace"}
        </li>)}</ul>
        {d.sources.length > 0 && <ul>{d.sources.map((source) => <li key={source.id}>
          <a href={source.url} target="_blank" rel="noopener noreferrer">[{source.id}] {source.title}</a>
          <span>{d.citedIds.includes(source.id) ? " Cited by the reasoning answer" : " Retrieved, not cited"}</span>
        </li>)}</ul>}
        <p className="hint">Citations identify returned pages, not a guarantee that each claim is supported. Open a source to verify it.</p>
      </div>}

      <Section title="Reasoning request"
        meta={request ? `${request.model ?? "unknown model"}, context ${request.input === undefined ? "unknown" : formatBytes(byteLength(request.input))}` : "not sent"}>
        {request ? <>
          <dl className="kv">
            <div><dt>Model</dt><dd>{request.model ?? "unknown"}</dd></div>
            <div><dt>store</dt><dd>{request.store === undefined ? "unknown" : String(request.store)}</dd></div>
            <div><dt>max_output_tokens</dt><dd>{formatCount(request.maxOutputTokens, "unknown")}</dd></div>
            {contextEntries.map(([key, value]) => <div key={key}><dt>{contextLabels[key] ?? key}</dt><dd>{key === "snapshotBytes" && Number.isFinite(Number(value)) ? formatBytes(Number(value)) : value}</dd></div>)}
            {d.ready?.durationMs !== undefined && <div><dt>Context wait</dt><dd>{formatDuration(d.ready.durationMs)}</dd></div>}
          </dl>
          <h4>Instructions</h4>
          <pre className="plain" tabIndex={0}>{request.instructions ?? "(not present)"}</pre>
          <h4>Context, exactly as sent</h4>
          <pre className="plain" tabIndex={0}>{request.input ?? "(not present)"}</pre>
        </> : <p className="hint">No reasoning request was logged for this delegation.</p>}
      </Section>

      <Section title="Reasoning output" initiallyOpen
        meta={response ? (response.output === undefined ? "no text" : `${response.output.length.toLocaleString("en-US")} characters`) : "no response"}>
        {response ? <>
          {response.status && response.status !== "completed" && <p className="callout tone-bad">Response status: {response.status}. This is not a completed answer. Earlier streamed text may already have reached GPT-Live.</p>}
          {response.output !== undefined
            ? <blockquote className="model-output">{response.output}</blockquote>
            : <p className="hint">The response contains no output_text.</p>}
          {response.detail !== undefined && response.detail !== null && <JsonView payload={response.detail} label="Response details" />}
          {response.reasoningItems > 0 && <p className="hint">Internal reasoning is not displayed or forwarded. Only answer text goes to GPT-Live.</p>}
          <p className="hint">Final step tokens: {hasUsage(response.usage)
            ? `input ${formatCount(response.usage.inputTokens)}${response.usage.cachedInputTokens !== undefined ? `, cached subset ${formatCount(response.usage.cachedInputTokens)}` : ""}; output ${formatCount(response.usage.outputTokens)}${response.usage.reasoningOutputTokens !== undefined ? `, reasoning subset ${formatCount(response.usage.reasoningOutputTokens)}` : ""}; total ${formatCount(response.usage.totalTokens)}.`
            : `${NOT_REPORTED}.`}</p>
          {d.events.some((event) => event.type === "luna.step.request") &&
            <p className="hint">This delegation used multiple model steps. Usage and cost totals include every step; open Trace events to inspect each request.</p>}
          {d.failure && <p className="callout tone-bad">The response was rejected or could not be delivered{failureMessage ? `: ${failureMessage}` : "."}</p>}
        </> : d.failure ? <p className="callout tone-bad">Reasoning failed{failureMessage ? `: ${failureMessage}` : "."} No completed response is available. Partial text may already have reached GPT-Live.</p>
          : d.cancelled ? <p className="callout tone-warn">Request cancelled locally{failureMessage ? `: ${failureMessage}` : "."} Azure computation may continue.</p>
            : <p className="hint">{d.status === "running" ? "Waiting for the reasoning response." : d.status === "rejected" ? "No reasoning request was started." : "No request sent yet."}</p>}
      </Section>

      <Section title="Sent to GPT-Live"
        meta={d.chunks.length ? `${d.chunks.length} chunks, ${d.acks.length} accepted` : "nothing sent"}>
        {d.chunks.length ? <ol className="chunks">
          {d.chunks.map((chunk, index) => {
            const wait = chunk.ack ? timeOf(chunk.ack) - timeOf(chunk.append) : undefined;
            return <li key={chunk.append.id}>
              <span className="chunk-n">Chunk {index + 1}</span>
              <span className="chunk-bytes">{formatBytes(chunk.bytes, "size unknown")}</span>
              <span className="chunk-text">{chunk.content ?? "(content unavailable)"}</span>
              {chunk.ack
                ? <Badge tone="ok">accepted {Number.isFinite(wait) ? formatOffset(wait!) : ""}</Badge>
                : <Badge tone="warn">not confirmed</Badge>}
            </li>;
          })}
        </ol> : <p className="hint">Nothing has been sent to GPT-Live for this delegation.</p>}
        {hint && d.chunks.length > 0 && <p className="hint">These chunks may include a partial answer and a failure notice. They do not represent a completed response.</p>}
      </Section>

      <Section title="Trace events" meta={`${d.events.length} events`}>
        <ol className="steps">
          {d.events.map((event) => <StepRow key={event.id} event={event} offset={timeOf(event) - d.start}
            title={describeStep(event, chunkNumber.get(event.id))} detail={stepDetail(event, chunkByEvent.get(event.id))} />)}
        </ol>
        <p className="hint">Times are relative to this delegation's first backend event. Expand a row for its JSON.</p>
      </Section>
    </div>}
  </article>;
}

interface Props {
  delegations: Delegation[];
  openIds: Record<string, boolean>;
  onToggle: (id: string, open: boolean) => void;
  now: number;
  eventsDropped: boolean;
}

export function Delegations({ delegations, openIds, onToggle, now, eventsDropped }: Props) {
  const ordered = [...delegations].reverse();
  const newest = ordered[0]?.id;
  return <section className="panel delegations" aria-labelledby="delegations-title">
    <div className="panel-head">
      <h2 id="delegations-title">Delegations</h2>
      {delegations.length > 0 && <span className="panel-meta">{delegations.length} buffered</span>}
    </div>
    {eventsDropped && <p className="callout tone-warn">Only the latest {MAX_EVENTS} events are kept. Older delegations may be missing or incomplete. Usage totals cover the whole session.</p>}
    {ordered.length === 0
      ? <div className="empty">
        <h3>No delegation yet</h3>
        <p>GPT-Live decides when it needs deeper reasoning. Requests, streamed answers and delivery timings will appear here.</p>
      </div>
      : <div className="dlg-list">
        {ordered.map((d) => <Card key={d.id} d={d} now={now} partial={eventsDropped && !d.created}
          open={openIds[d.id] ?? d.id === newest} onToggle={(open) => onToggle(d.id, open)} />)}
      </div>}
  </section>;
}
