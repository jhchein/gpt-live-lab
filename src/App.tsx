import { useCallback, useEffect, useMemo, useState } from "react";
import { isObject, type TraceEvent } from "../shared/protocol";
import { AudioPanel } from "./AudioPanel";
import { Conversation } from "./Conversation";
import { Delegations } from "./Delegations";
import { FlowMap } from "./FlowMap";
import { formatTime } from "./format";
import { RawEvents } from "./RawEvents";
import { SessionBar } from "./SessionBar";
import { buildConversation, collectIssues, severityOf, type Issue } from "./trace";
import { SeverityTag, SourceTag, severityTone } from "./ui";
import { Usage } from "./Usage";
import { useLiveSession } from "./useLiveSession";

function issueHint(event: TraceEvent): string | undefined {
  const payload = isObject(event.payload) ? event.payload : {};
  switch (event.type) {
    case "live.transport.closed": {
      const detail = [payload.code !== undefined && `Code ${String(payload.code)}`, typeof payload.reason === "string" && payload.reason]
        .filter(Boolean).join(", ");
      return severityOf(event) === "warning"
        ? `Azure closed the observer connection${detail ? `: ${detail}` : ""} after Stop, without session.closed. The session ended locally, but final usage is unknown.`
        : `The Azure connection closed during the session${detail ? `: ${detail}` : "."}`;
    }
    case "session.close.timeout":
      return "Azure did not send session.closed before the timeout. Final usage is unknown.";
    case "demo.time_limit":
      return "The session reached the 10-minute demo limit and stopped.";
    case "delegation.limit":
      return "The delegation queue is full. Additional requests were rejected.";
    case "luna.failed":
      return "A reasoning request failed. Open the delegation for details and any partial output.";
    default:
      return undefined;
  }
}

function IssueRow({ issue, onOpen }: { issue: Issue; onOpen: (event: TraceEvent) => void }) {
  const { event, count } = issue;
  const severity = severityOf(event);
  const hint = issueHint(event);
  return <li className={`notice tone-${severityTone(severity)}`}>
    <div className="notice-head">
      <SeverityTag severity={severity} />
      <strong>{event.label}</strong>
      <SourceTag source={event.source} />
      <code>{event.type}</code>
      <span className="notice-meta">{formatTime(event.time)}{count > 1 ? `, ${count} occurrences` : ""}</span>
    </div>
    {hint && <p>{hint}</p>}
    <button type="button" className="btn btn-quiet" onClick={() => onOpen(event)}>View JSON</button>
  </li>;
}

export function App() {
  const session = useLiveSession();
  const { events, fragments, phase, config, runId } = session;
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  const [rawOpen, setRawOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();

  // A new session starts with a clean view state.
  useEffect(() => {
    setOpenIds({});
    setSelectedId(undefined);
  }, [runId]);

  const delegations = session.observation.delegations;
  const conversation = useMemo(() => buildConversation(fragments, delegations), [fragments, delegations]);
  const issues = useMemo(() => collectIssues(events), [events]);

  const openRaw = useCallback((event: TraceEvent) => {
    setSelectedId(event.id);
    setRawOpen(true);
    requestAnimationFrame(() => document.getElementById("raw-events")?.scrollIntoView({ block: "start" }));
  }, []);

  const openDelegation = useCallback((id: string) => {
    setOpenIds((current) => ({ ...current, [id]: true }));
    requestAnimationFrame(() => {
      const card = document.getElementById(`delegation-${encodeURIComponent(id)}`);
      card?.scrollIntoView({ block: "start" });
      card?.querySelector("button")?.focus({ preventScroll: true });
    });
  }, []);

  const { configError, error, audio } = session;
  const notices = Boolean(configError || error || audio.statsError || issues.length);

  return <div className="app">
    <header className="app-header">
      <h1>GPT-Live Lab</h1>
      <p>Talk to GPT-Live. Watch it delegate to a reasoning model.</p>
    </header>
    <SessionBar session={session} />
    <main>
      {notices && <section className="notices" aria-labelledby="notices-title" aria-live="polite">
        <h2 id="notices-title">Notices</h2>
        <ul>
          {configError && <li className="notice tone-bad">
            <div className="notice-head"><strong>Backend unavailable</strong></div>
            <p>{configError}</p>
            <button type="button" className="btn" onClick={session.retryConfig}>Try again</button>
          </li>}
          {error && <li className="notice tone-bad">
            <div className="notice-head"><strong>Error</strong></div>
            <p>{error}</p>
            <button type="button" className="btn btn-quiet" onClick={session.dismissError}>Dismiss</button>
          </li>}
          {audio.statsError && <li className="notice tone-warn">
            <div className="notice-head"><strong>Audio diagnostics unavailable</strong></div>
            <p>{audio.statsError}</p>
          </li>}
          {issues.map((issue) => <IssueRow key={issue.event.type} issue={issue} onOpen={openRaw} />)}
        </ul>
      </section>}

      <FlowMap session={session}
        deployments={config ? { live: config.liveDeployment, reasoning: config.reasoningDeployment } : undefined} />
      <div className="search-control">
        <label className="check"><input type="checkbox" checked={Boolean(config?.webSearchAvailable && session.webSearchEnabled)}
          disabled={!config?.webSearchAvailable || phase === "stopping"}
          onChange={(event) => session.changeWebSearch(event.target.checked)} />Web search</label>
        <span>{!config?.webSearchAvailable ? "Not configured. Add WEB_IQ_API_KEY locally and restart the backend."
          : "Microsoft Web IQ. Changes apply to the next delegation. Search queries are sent outside your local app."}</span>
      </div>

      <div className="layout">
        <div className="col col-voice">
          <AudioPanel session={session} />
          <Conversation items={conversation} phase={phase} fragmentsSeen={session.totalFragments} onMarker={openDelegation} />
        </div>
        <div className="col col-trace">
          <Delegations delegations={delegations} openIds={openIds} now={session.now}
            eventsDropped={session.totalEvents > events.length}
            onToggle={(id, open) => setOpenIds((current) => ({ ...current, [id]: open }))} />
          <Usage session={session} deployments={config ? { live: config.liveDeployment, reasoning: config.reasoningDeployment } : undefined} />
        </div>
      </div>

      <RawEvents events={events} totalEvents={session.totalEvents} open={rawOpen} onOpenChange={setRawOpen}
        selectedId={selectedId} onSelect={setSelectedId} />
    </main>
    <footer className="app-footer">
      <span>Runs locally. Audio and transcript context are sent to Azure.</span>
      <span>Azure CLI sign-in · No saved history · 10-minute limit</span>
    </footer>
  </div>;
}
