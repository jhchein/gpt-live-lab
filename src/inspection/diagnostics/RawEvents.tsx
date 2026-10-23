import { memo, useDeferredValue, useEffect, useMemo, useState } from "react";
import type { Category, Source, TraceEvent } from "../../../shared/protocol";
import { formatDuration, formatTime, shortId } from "../../ui/format";
import { JsonView } from "../../ui/JsonView";
import { matchesQuery } from "./search";
import { queryTerms } from "../../ui/json";
import { severityOf, timeOf } from "../events";
import { SeverityTag, SourceTag, severityTone, sourceLabels } from "../../ui/indicators";
import { MAX_EVENTS } from "../observation";

const categories: Category[] = ["session", "delegation", "reasoning", "search", "transcript", "error"];
const categoryLabels: Record<Category, string> = {
  session: "Session", delegation: "Delegation", reasoning: "Reasoning", search: "Web search", transcript: "Transcript", error: "Error",
};
const sources = Object.keys(sourceLabels) as Source[];

const isAudioStats = (event: TraceEvent) => event.type.startsWith("browser.webrtc.audio.stats");

const Row = memo(function Row({ event, selected, onSelect }: { event: TraceEvent; selected: boolean; onSelect: (id: string) => void }) {
  const severity = severityOf(event);
  return <li>
    <button type="button" className={`raw-row tone-${severityTone(severity)}`} aria-pressed={selected} onClick={() => onSelect(event.id)}>
      <time dateTime={event.time}>{formatTime(event.time)}</time>
      <SourceTag source={event.source} />
      <span className="raw-main">
        <span className="raw-label">{event.label} <SeverityTag severity={severity} /></span>
        <code>{event.type}</code>
      </span>
      <span className="raw-meta">
        {event.delegationId && <span title={event.delegationId}>#{shortId(event.delegationId)}</span>}
        {event.durationMs !== undefined && <span>{formatDuration(event.durationMs)}</span>}
      </span>
    </button>
  </li>;
});

interface Props {
  events: TraceEvent[];
  totalEvents: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
}

export function RawEvents({ events, totalEvents, open, onOpenChange, selectedId, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category | "all">("all");
  const [source, setSource] = useState<Source | "all">("all");
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const deferred = useDeferredValue(query);

  // A jump from elsewhere must be visible: relax filters that would hide the target.
  const selected = selectedId ? events.find((event) => event.id === selectedId) : undefined;
  useEffect(() => {
    if (!selected) return;
    setShowTranscript((value) => value || selected.category === "transcript");
    setShowStats((value) => value || isAudioStats(selected));
  }, [selected]);

  const terms = useMemo(() => queryTerms(deferred), [deferred]);
  const visible = useMemo(() => {
    const result: TraceEvent[] = [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.id !== selectedId) {
        if (!showTranscript && event.category === "transcript") continue;
        if (!showStats && isAudioStats(event)) continue;
        if (category !== "all" && event.category !== category) continue;
        if (source !== "all" && event.source !== source) continue;
        if (problemsOnly && severityOf(event) === "info") continue;
        if (!matchesQuery(event, terms)) continue;
      }
      result.push(event);
    }
    return result;
  }, [events, selectedId, showTranscript, showStats, category, source, problemsOnly, terms]);

  const hiddenByDefault = useMemo(() => events.filter((event) =>
    (!showTranscript && event.category === "transcript") || (!showStats && isAudioStats(event))).length, [events, showTranscript, showStats]);
  const dropped = Math.max(0, totalEvents - events.length);
  const capped = visible.slice(0, 300);
  const filtered = Boolean(query.trim()) || category !== "all" || source !== "all" || problemsOnly;

  return <details className="panel raw" id="raw-events" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
    <summary>
      <h2>Raw events</h2>
      <span className="panel-meta">{events.length === 0 ? "no events" : `${events.length} buffered${dropped ? `, ${dropped} older events discarded` : ""}`}</span>
    </summary>
    {open && <div className="raw-body">
      <p className="hint">
        Browser, backend and Azure events, newest first. Keeps the latest {MAX_EVENTS} events. Credentials, encrypted state and SDP are redacted.
        {dropped > 0 && ` ${dropped} older events are no longer searchable.`}
      </p>
      <div className="raw-filters" role="search">
        <label className="field raw-search">
          <span>Search</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Type, label or payload text" spellCheck={false} />
        </label>
        <label className="field">
          <span>Category</span>
          <select value={category} onChange={(event) => setCategory(event.target.value as Category | "all")}>
            <option value="all">All</option>
            {categories.map((name) => <option key={name} value={name}>{categoryLabels[name]}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Source</span>
          <select value={source} onChange={(event) => setSource(event.target.value as Source | "all")}>
            <option value="all">All</option>
            {sources.map((name) => <option key={name} value={name}>{sourceLabels[name]}</option>)}
          </select>
        </label>
        <div className="raw-toggles">
          <label className="check"><input type="checkbox" checked={problemsOnly} onChange={(event) => setProblemsOnly(event.target.checked)} />Warnings and errors only</label>
          <label className="check"><input type="checkbox" checked={showTranscript} onChange={(event) => setShowTranscript(event.target.checked)} />Transcript events</label>
          <label className="check"><input type="checkbox" checked={showStats} onChange={(event) => setShowStats(event.target.checked)} />Audio stats</label>
        </div>
      </div>
      <p className="raw-count" role="status">
        {visible.length} of {events.length} events{visible.length > capped.length ? `, showing the newest ${capped.length}` : ""}
        {hiddenByDefault > 0 && `. ${hiddenByDefault} transcript and audio-stats events hidden`}.
        {filtered && <> <button type="button" className="btn btn-quiet" onClick={() => {
          setQuery(""); setCategory("all"); setSource("all"); setProblemsOnly(false);
        }}>Reset filters</button></>}
      </p>
      <div className="raw-grid">
        {capped.length === 0
          ? <p className="empty-inline">{events.length === 0 ? "Events appear when you start a session." : "No events match these filters."}</p>
          : <ul className="raw-list" aria-label="Raw events">
            {capped.map((event) => <Row key={event.id} event={event} selected={event.id === selectedId} onSelect={onSelect} />)}
          </ul>}
        <div className="raw-inspector" aria-live="polite">
          {selected ? <>
            <div className="inspector-head">
              <h3>{selected.label}</h3>
              <button type="button" className="btn btn-quiet" onClick={() => onSelect(undefined)}>Close</button>
            </div>
            <dl className="kv">
              <div><dt>Type</dt><dd><code>{selected.type}</code></dd></div>
              <div><dt>Source</dt><dd>{sourceLabels[selected.source]}</dd></div>
              <div><dt>Category</dt><dd>{categoryLabels[selected.category]}</dd></div>
              <div><dt>Time</dt><dd>{Number.isFinite(timeOf(selected)) ? formatTime(selected.time) : "unknown"}</dd></div>
              {selected.delegationId && <div><dt>Delegation</dt><dd><code>{selected.delegationId}</code></dd></div>}
              {selected.durationMs !== undefined && <div><dt>Duration</dt><dd>{formatDuration(selected.durationMs)}</dd></div>}
              <div><dt>Severity</dt><dd>{{ info: "Info", warning: "Warning", error: "Error" }[severityOf(selected)]}</dd></div>
            </dl>
            <JsonView payload={selected.payload} query={query} label={`Payload for ${selected.type}`} />
          </> : <p className="empty-inline">Select an event to inspect its JSON.</p>}
        </div>
      </div>
    </div>}
  </details>;
}
