import type { Phase, TraceEvent } from "../shared/protocol";
import { formatDuration } from "./format";
import { timeOf, type Delegation } from "./trace";
import type { RtcState } from "./useLiveSession";
import type { Observation } from "./observation";

export type NodeId = "browser" | "backend" | "live" | "reasoning" | "web";
export type LaneId = "mic" | "speech" | "command" | "update" | "append" | "sideband" | "request" | "stream" | "search" | "results";
// off: no connection. open: connected and quiet. active: data moving now. waiting: request sent, no answer yet.
export type LaneState = "off" | "open" | "active" | "waiting" | "failed";
export type NodeTone = "idle" | "ok" | "warn" | "bad" | "accent";

export const LANES: Record<LaneId, { from: NodeId; to: NodeId; label: string }> = {
  mic: { from: "browser", to: "live", label: "Your voice, sent directly to GPT-Live" },
  speech: { from: "live", to: "browser", label: "GPT-Live's voice, played in your browser" },
  command: { from: "browser", to: "backend", label: "Browser to backend: prepare, start with audio offer, stop" },
  update: { from: "backend", to: "browser", label: "Backend to browser: audio answer, events, transcripts, usage" },
  append: { from: "backend", to: "live", label: "Backend to GPT-Live: create session, sentences to speak, close" },
  sideband: { from: "live", to: "backend", label: "GPT-Live to backend: transcripts, delegation requests, acknowledgments" },
  request: { from: "backend", to: "reasoning", label: "Backend to reasoning model: conversation context" },
  stream: { from: "reasoning", to: "backend", label: "Reasoning model to backend: streamed answer" },
  search: { from: "backend", to: "web", label: "Backend to Web IQ: targeted search query" },
  results: { from: "web", to: "backend", label: "Web IQ to backend: source passages" },
};

const COMMAND_EVENTS = new Set(["browser.backend.open", "browser.azure.create.started", "browser.stop"]);
const APPEND_EVENTS = new Set(["live.session.request", "session.commentary.append", "session.thinking.append", "session.close"]);

// Maps one observed event to the connection it travelled over. Browser-local events never cross a connection.
export function laneOf(event: TraceEvent): LaneId | undefined {
  if (event.source === "live") return "sideband";
  if (event.source === "luna") return "stream";
  if (event.source === "web") return "results";
  if (event.source === "browser") {
    if (COMMAND_EVENTS.has(event.type)) return "command";
    return event.type === "browser.sdp.applied" ? "update" : undefined;
  }
  if (APPEND_EVENTS.has(event.type)) return "append";
  if (event.type === "search.request" || event.type === "search.attempt") return "search";
  return event.type === "luna.request" || event.type === "luna.step.request" ? "request" : undefined;
}

// Events from the backend, including relayed Azure events, reach the browser over the local WebSocket.
export const reachesBrowser = (event: TraceEvent) => event.source !== "browser";

export interface FlowInput {
  phase: Phase;
  rtcState: RtcState;
  backendOpen: boolean;
  micSignal: boolean;
  lastSpeechAt?: number;
  observation: Observation;
  now: number;
  webSearchAvailable?: boolean;
}

export interface FlowView {
  lanes: Record<LaneId, LaneState>;
  nodes: Record<NodeId, { text: string; tone: NodeTone }>;
  caption: string;
}

const SCAN = 60;
const finished = (d: Delegation) => Boolean(d.failure ?? d.cancelled ?? d.response);

function recently(events: TraceEvent[], now: number, ms: number, match: (event: TraceEvent) => boolean) {
  for (let index = events.length - 1; index >= Math.max(0, events.length - SCAN); index -= 1) {
    const at = timeOf(events[index]);
    if (match(events[index]) && Number.isFinite(at) && now - at <= ms) return true;
  }
  return false;
}

const has = (events: TraceEvent[], type: string) => events.some((event) => event.type === type);

function delegationCaption(d: Delegation, now: number): string | undefined {
  if (d.failure) {
    return d.chunks.length
      ? "The reasoning call failed after some text was sent. GPT-Live was told the answer is incomplete."
      : "The reasoning call failed. GPT-Live was told to say so instead of guessing.";
  }
  if (d.cancelled) return "The reasoning call was cancelled locally.";
  if (d.response) {
    const end = timeOf(d.response);
    if (Number.isFinite(end) && now - end > 6000) return undefined;
    return `Reasoning finished. ${d.chunks.length} ${d.chunks.length === 1 ? "sentence was" : "sentences were"} sent to GPT-Live; Azure accepted ${d.acks.length}.`;
  }
  if (d.firstText) {
    if (!d.chunks.length) return "Text is arriving. The backend is waiting for a complete answer sentence or web evidence before speaking.";
    return `The reasoning model is streaming. The backend forwards each finished sentence to GPT-Live to speak (${d.chunks.length} sent).`;
  }
  if (d.request) return "The backend sent the conversation to the reasoning model and waits for its first words.";
  if (d.ready) return "Context is ready. The backend is building the reasoning request.";
  return "GPT-Live asked the backend for help. The backend is collecting the conversation context.";
}

export function deriveFlow(input: FlowInput): FlowView {
  const { phase, rtcState, backendOpen, micSignal, lastSpeechAt, observation, now } = input;
  const { events, delegations, activeDelegation, searchState } = observation;
  const sessionUp = phase === "live" || phase === "stopping";
  const starting = phase === "starting";
  const audioUp = sessionUp && rtcState === "connected";
  const speaking = lastSpeechAt !== undefined && now - lastSpeechAt < 1500;
  const sidebandUp = sessionUp || (starting && has(events, "live.sideband.open"));
  const creating = starting && has(events, "live.session.request") && !has(events, "live.session.response");

  const current = activeDelegation ?? delegations.at(-1);
  const inFlight = sessionUp && activeDelegation?.request ? activeDelegation : undefined;
  const preparing = sessionUp && current && !current.request && !finished(current) ? current : undefined;
  const searchEvent = searchState?.event;
  const retryWaiting = phase === "live" && searchEvent?.type === "search.retry";
  const searching = phase === "live" && (searchEvent?.type === "search.request" || searchEvent?.type === "search.attempt");
  const searchFailed = searchEvent?.type === "search.failed";
  const recovered = phase === "live" && searchEvent?.type === "search.response" && searchState?.attempt === 2 &&
    now - timeOf(searchEvent) >= 0 && now - timeOf(searchEvent) < 6000;
  const retrySeconds = searchState?.retryAt === undefined ? undefined : Math.max(0, Math.ceil((searchState.retryAt - now) / 1000));
  const searchCode = searchState?.httpStatus === undefined ? "" : ` · ${searchState.httpStatus}`;
  const stepEvent = inFlight?.events.filter((event) =>
    ["luna.request", "luna.step.request", "luna.step.first_text", "luna.step.response"].includes(event.type)).at(-1);
  const modelOpen = inFlight && !searching && !retryWaiting && stepEvent?.type !== "luna.step.response";
  const textStreaming = stepEvent?.type === "luna.step.first_text" ||
    (stepEvent?.type === "luna.request" && Boolean(inFlight?.firstText));

  const lanes: Record<LaneId, LaneState> = {
    mic: audioUp ? (phase === "live" && micSignal ? "active" : "open") : "off",
    speech: audioUp ? (speaking ? "active" : "open") : "off",
    command: backendOpen
      ? (recently(events, now, 600, (event) => laneOf(event) === "command") ? "active" : "open") : "off",
    update: backendOpen
      ? (recently(events, now, 500, reachesBrowser) ? "active" : "open") : "off",
    append: creating ? "waiting" : sidebandUp
      ? (recently(events, now, 800, (event) => laneOf(event) === "append") ? "active" : "open") : "off",
    sideband: sidebandUp
      ? (recently(events, now, 600, (event) => event.source === "live") ? "active" : "open") : "off",
    request: modelOpen ? (recently(events, now, 700, (event) => laneOf(event) === "request") ? "active" : "open") : "off",
    stream: modelOpen ? (textStreaming ? "active" : "waiting") : "off",
    search: searchFailed ? "failed" : retryWaiting ? "waiting" : searching ? "active" : "off",
    results: searchFailed ? "failed" : searching ? "waiting" : "off",
  };

  const sentences = inFlight?.chunks.length ?? 0;
  const nodes: FlowView["nodes"] = {
    browser: phase === "error" ? { text: "Error", tone: "bad" }
      : starting ? { text: "Connecting", tone: "warn" }
        : phase === "stopping" ? { text: "Closing", tone: "warn" }
          : phase === "live" ? { text: micSignal ? "Hearing you" : "Microphone on", tone: micSignal ? "accent" : "ok" }
            : { text: "Ready", tone: "idle" },
    live: sessionUp
      ? (speaking ? { text: "Speaking", tone: "accent" }
        : inFlight || preparing ? { text: "Result pending", tone: "accent" } : { text: "Listening", tone: "ok" })
      : starting ? { text: "Creating session", tone: "warn" } : { text: "No session", tone: "idle" },
    backend: retryWaiting ? { text: "Waiting to retry", tone: "warn" } : searching ? { text: "Searching the web", tone: "accent" } : inFlight
      ? (textStreaming ? { text: sentences ? `Relaying text (${sentences})` : "Receiving text", tone: "accent" } : { text: "Awaiting reasoning", tone: "accent" })
      : preparing ? { text: "Preparing context", tone: "accent" }
        : sessionUp ? { text: "Observing", tone: "ok" }
          : starting ? { text: "Setting up", tone: "warn" }
            : backendOpen ? { text: "Connected", tone: "ok" } : { text: "No browser yet", tone: "idle" },
    reasoning: searching || retryWaiting ? { text: "Waiting for sources", tone: "warn" } : inFlight
      ? (textStreaming ? { text: "Streaming answer", tone: "accent" }
        : { text: `Thinking ${formatDuration(Math.max(0, now - timeOf(inFlight.request!)))}`, tone: "warn" })
      : current?.failure ? { text: "Last call failed", tone: "bad" } : { text: "Idle", tone: "idle" },
    web: searchFailed ? { text: `Search failed${searchCode}`, tone: "bad" }
      : retryWaiting ? { text: retrySeconds === undefined || retrySeconds === 0 ? "503 · retry pending" : `503 · retry in ${retrySeconds} s`, tone: "warn" }
      : searching ? { text: searchState?.attempt === 2 ? "Retrying · 2/2" : "Searching", tone: "accent" }
      : recovered ? { text: "Recovered after retry", tone: "ok" }
      : !input.webSearchAvailable ? { text: "Not configured", tone: "idle" }
        : { text: "Ready", tone: "ok" },
  };

  let caption: string;
  if (phase === "error") caption = "The session ended with an error. Details are in the notices above.";
  else if (starting) {
    caption = creating ? "The backend is creating the Azure session over HTTPS, using your browser's audio offer."
      : has(events, "live.session.response") ? "Azure accepted the session. Connecting audio."
        : "Preparing the microphone, the audio route and Azure sign-in at the same time.";
  } else if (phase === "stopping") caption = "Stopping. The backend asks Azure to close the session and waits for final usage.";
  else if (phase === "live") {
    const status = current ? delegationCaption(current, now) : undefined;
    caption = retryWaiting ? "Web IQ returned 503. The backend is waiting before one retry; no request is being sent during this wait."
      : searching ? "The reasoning model requested fresh information. The local backend is searching Web IQ for source passages."
      : searchFailed ? `The last web search failed${searchCode}. ${audioUp
        ? "The voice conversation is still connected." : "The Azure session is open, but audio is not connected."}`
      : recovered ? "Web search succeeded after one retry. The returned sources are available to the reasoning model."
      : status ?? (speaking ? "GPT-Live is speaking. Its voice goes straight to your browser."
      : micSignal ? "Your voice streams straight to GPT-Live. The backend only listens along on the side."
        : "Connected. Audio flows directly between browser and GPT-Live. Ask something that needs thought to trigger a delegation.");
  } else {
    caption = events.length
      ? "Session ended. All connections are closed."
      : "Start a session to watch audio, delegation and reasoning traffic move between these four parts.";
  }
  return { lanes, nodes, caption };
}
