import type { Phase } from "../../shared/protocol";
import { CostTicker } from "../inspection/usage/CostTicker";
import { formatClock } from "../ui/format";
import { SESSION_LIMIT_SECONDS, type LiveSession } from "./useLiveSession";
import { type RtcState } from "./browser-audio";
import { Dot, type Tone } from "../ui/indicators";

const STOP_WAIT_SECONDS = 7;

const azureState: Record<Phase, [string, Tone]> = {
  idle: ["no session", "idle"], starting: ["creating", "warn"], live: ["active", "ok"],
  stopping: ["closing", "warn"], error: ["error", "bad"],
};
const peerState: Record<RtcState, [string, Tone]> = {
  none: ["not connected", "idle"], new: ["ready", "warn"], connecting: ["connecting", "warn"],
  connected: ["connected", "ok"], disconnected: ["disconnected", "warn"], failed: ["failed", "bad"],
  closed: ["closed", "idle"],
};

function playbackTone(status: string): Tone {
  if (status === "Playing") return "ok";
  if (status.includes("blocked") || status.includes("failed")) return "bad";
  if (status === "Paused" || status === "Audio track ended") return "warn";
  return "idle";
}

export function SessionBar({ session }: { session: LiveSession }) {
  const { phase, rtcState, backendOpen, startedAt, liveAt, endedAt, stopRequestedAt, now, config } = session;
  const active = phase === "starting" || phase === "live" || phase === "stopping";
  const ended = (phase === "idle" || phase === "error") && startedAt !== undefined;
  const end = endedAt ?? now;
  const elapsed = startedAt === undefined ? 0 : Math.max(0, Math.floor((end - startedAt) / 1000));
  const used = liveAt === undefined ? 0 : Math.min(SESSION_LIMIT_SECONDS, Math.max(0, Math.floor((end - liveAt) / 1000)));
  const remaining = SESSION_LIMIT_SECONDS - used;
  const waited = stopRequestedAt === undefined ? 0 : Math.min(STOP_WAIT_SECONDS, Math.max(0, Math.floor((now - stopRequestedAt) / 1000)));

  let headline: string;
  let tone: Tone;
  let detail: string;
  if (phase === "starting") {
    headline = "Connecting"; tone = "warn";
    detail = "Setting up your microphone and Azure connection.";
  } else if (phase === "live") {
    const peerUp = rtcState === "connected";
    headline = peerUp ? "Live" : rtcState === "disconnected" ? "Audio disconnected" : "Connecting audio";
    tone = peerUp ? "ok" : "warn";
    detail = peerUp ? "Microphone is on. Stop turns it off immediately." : "Azure is ready. Waiting for audio.";
  } else if (phase === "stopping") {
    headline = "Stopping"; tone = "warn";
    detail = stopRequestedAt === undefined
      ? "Microphone is off."
      : `Microphone is off. Waiting for Azure to confirm closure, ${waited} of ${STOP_WAIT_SECONDS} s.`;
  } else if (phase === "error") {
    headline = "Error"; tone = "bad";
    detail = "Session ended. See the notice below.";
  } else {
    headline = ended ? "Ended" : "Ready"; tone = "idle";
    detail = ended
      ? "Microphone and connection are closed."
      : "Azure is contacted only when you start.";
  }

  const chips: { label: string; value: string; tone: Tone }[] = [
    { label: "Backend", value: backendOpen ? "connected" : "disconnected", tone: backendOpen ? "ok" : "idle" },
    { label: "Azure session", value: azureState[phase][0], tone: azureState[phase][1] },
    { label: "WebRTC", value: peerState[rtcState][0], tone: peerState[rtcState][1] },
    { label: "Playback", value: session.audio.outputStatus, tone: playbackTone(session.audio.outputStatus) },
  ];

  return <section className="session-bar" aria-label="Session controls">
    <div className="bar-row">
      <button type="button" className={`btn btn-primary btn-session ${active ? "is-active" : ""}`}
        onClick={active ? session.stop : () => void session.start()}
        disabled={!config || phase === "stopping"}
        title={config ? undefined : "Waiting for backend configuration."}>
        {active
          ? <span className="stop-icon" aria-hidden="true" />
          : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg>}
        <span>{phase === "stopping" ? "Stopping" : active ? "Stop session" : "Start session"}</span>
      </button>
      <div className="bar-status" role="status">
        <strong><Dot tone={tone} />{headline}</strong>
        <span>{detail}</span>
      </div>
      <div className="bar-clock">
        <div className="clock-line">
          <output aria-label="Local elapsed time">{formatClock(elapsed)}</output>
          <span>elapsed</span>
        </div>
        <div className={`limit ${active && liveAt !== undefined && remaining <= 60 ? "is-near" : ""}`}>
          <span>{active && liveAt !== undefined ? `${formatClock(remaining)} until limit` : `${formatClock(SESSION_LIMIT_SECONDS)} limit`}</span>
        </div>
      </div>
    </div>
    <CostTicker cost={session.metrics.cost} />
    <details className="connection-details disclosure">
      <summary>Connection details</summary>
      <ul className="chips" aria-label="Connection status">
      {chips.map((chip) => <li className="chip" key={chip.label}>
        <Dot tone={chip.tone} /><span className="chip-label">{chip.label}</span><span className="chip-value">{chip.value}</span>
      </li>)}
      </ul>
    </details>
  </section>;
}
