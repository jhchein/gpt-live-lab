import { useEffect, useRef, useState } from "react";
import { emptySessionMetrics, errorMessage, isObject, type Category, type Phase, type PublicConfig, type ServerMessage, type SessionMetrics, type TraceEvent } from "../../shared/protocol";
import { SessionObservation } from "../inspection/observation";
import { BrowserAudio, type RtcState } from "./browser-audio";
import type { CostEstimate } from "../../shared/pricing";
export const SESSION_LIMIT_SECONDS = 600;
const phases: readonly string[] = ["idle", "starting", "live", "stopping", "error"];
const sources: readonly string[] = ["browser", "backend", "live", "luna", "web"];
const categories: readonly string[] = ["session", "transcript", "delegation", "reasoning", "search", "error"];
const severities: readonly string[] = ["info", "warning", "error"];
const closeStatuses: readonly string[] = ["open", "requested", "confirmed", "unconfirmed"];
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isOptionalCount = (value: unknown) => value === undefined || isCount(value);
function isTokenUsage(value: unknown) {
  return isObject(value) && isOptionalCount(value.inputTokens) && isOptionalCount(value.outputTokens) &&
    isOptionalCount(value.totalTokens) && isOptionalCount(value.cachedInputTokens) &&
    isOptionalCount(value.reasoningOutputTokens);
}
function isCostEstimate(value: unknown): value is CostEstimate {
  if (!isObject(value) || value.currency !== "USD" || !isCount(value.totalKnownUsd) ||
    typeof value.complete !== "boolean" || typeof value.provisional !== "boolean" ||
    !Array.isArray(value.reasons) || !value.reasons.every((reason) => typeof reason === "string"))
    return false;
  for (const name of ["live", "reasoning", "search"]) {
    const subtotal = value[name];
    if (!isObject(subtotal) || !isCount(subtotal.knownUsd) || typeof subtotal.complete !== "boolean")
      return false;
  }
  return isObject(value.live) && typeof value.live.provisional === "boolean" &&
    isObject(value.reasoning) && typeof value.reasoning.inputIncludesCached === "boolean" &&
    isObject(value.search) && isCount(value.search.requests) && isCount(value.search.succeeded) &&
    isCount(value.search.failed) && isCount(value.search.uncertain);
}
function isSessionMetrics(value: unknown): value is SessionMetrics {
  return isObject(value) &&
    isCount(value.lunaRequests) && isCount(value.lunaResponses) && isCount(value.lunaFailures) &&
    isCount(value.lunaCancelled) && isCount(value.lunaUsageReports) &&
    isTokenUsage(value.lunaUsage) && typeof value.lunaUsageIncomplete === "boolean" &&
    (value.lunaCachedUsageIncomplete === undefined || typeof value.lunaCachedUsageIncomplete === "boolean") &&
    isOptionalCount(value.liveSeconds) && (value.liveUsage === undefined || isObject(value.liveUsage)) &&
    isOptionalCount(value.liveStartedAt) && isOptionalCount(value.liveEndedAt) &&
    isOptionalCount(value.lunaPendingRequests) && isOptionalCount(value.searchRequests) &&
    isOptionalCount(value.searchSucceeded) && isOptionalCount(value.searchFailed) && isOptionalCount(value.searchUncertain) &&
    (value.webSearchEnabled === undefined || typeof value.webSearchEnabled === "boolean") &&
    (value.cost === undefined || isCostEstimate(value.cost)) &&
    typeof value.liveUsageFinal === "boolean" &&
    typeof value.closeStatus === "string" && closeStatuses.includes(value.closeStatus);
}
function isServerMessage(value: unknown): value is ServerMessage {
  if (!isObject(value))
    return false;
  if (value.type === "state")
    return typeof value.phase === "string" && phases.includes(value.phase) &&
      (value.sessionId === undefined || typeof value.sessionId === "string");
  if (value.type === "answer")
    return typeof value.sdp === "string";
  if (value.type === "metrics")
    return isSessionMetrics(value.metrics);
  if (value.type === "transcript") {
    const fragment = value.fragment;
    return isObject(fragment) && (fragment.speaker === "user" || fragment.speaker === "assistant") &&
      typeof fragment.text === "string" && typeof fragment.startMs === "number" && typeof fragment.endMs === "number";
  }
  if (value.type === "trace") {
    const event = value.event;
    return isObject(event) && typeof event.id === "string" && typeof event.time === "string" &&
      typeof event.source === "string" && sources.includes(event.source) &&
      typeof event.category === "string" && categories.includes(event.category) &&
      typeof event.type === "string" && typeof event.label === "string" &&
      (event.durationMs === undefined || typeof event.durationMs === "number") &&
      (event.delegationId === undefined || typeof event.delegationId === "string") &&
      (event.severity === undefined || (typeof event.severity === "string" && severities.includes(event.severity)));
  }
  return false;
}
export function useLiveSession() {
  const [config, setConfig] = useState<PublicConfig>();
  const [configError, setConfigError] = useState("");
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [observer] = useState(() => new SessionObservation());
  const [observation, setObservation] = useState(observer.snapshot);
  const { events, totalEvents, fragments, totalFragments } = observation;
  const [metrics, setMetrics] = useState<SessionMetrics>(emptySessionMetrics);
  const [metricsReceived, setMetricsReceived] = useState(false);
  const [error, setError] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [backendOpen, setBackendOpen] = useState(false);
  const [rtcState, setRtcState] = useState<RtcState>("none");
  const [startedAt, setStartedAt] = useState<number>();
  const [liveAt, setLiveAt] = useState<number>();
  const [endedAt, setEndedAt] = useState<number>();
  const [stopRequestedAt, setStopRequestedAt] = useState<number>();
  const [runId, setRunId] = useState(0);
  const [now, setNow] = useState(Date.now());
  const wsRef = useRef<WebSocket | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const generation = useRef(0);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const connectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lingerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lingering = useRef(false);
  const stopping = useRef(false);
  const startSent = useRef(false);
  const startupAt = useRef<number | undefined>(undefined);
  const [audioController] = useState(() => new BrowserAudio({
    player: () => audioRef.current,
    changed: (snapshot) => setAudioSnapshot(snapshot),
    error: (message) => setError(message),
    trace: browserTrace,
    connection: (state) => {
      setRtcState(state);
      if (state === "connected" && !stopping.current)
        clearTimeout(connectTimer.current);
      if (state === "failed") {
        if (stopping.current)
          browserTrace("browser.webrtc.failed.draining", "WebRTC failed during shutdown; waiting for backend confirmation", {}, "session", "warning");
        else
          fail("WebRTC connection failed. Check your network and Azure endpoint.");
      }
    },
  }));
  const [audioSnapshot, setAudioSnapshot] = useState(audioController.snapshot);
  const { inputDevices, selectedInputId, activeMicLabel, inputLevel, micSignal, micTestActive, outputStatus, remoteAudio, audioBlocked, audioStats, audioStatsError } = audioSnapshot;
  function addTrace(event: TraceEvent) {
    setObservation(observer.trace(event));
  }
  function browserTrace(type: string, label: string, payload: unknown, category: Category = "session", severity?: TraceEvent["severity"], durationMs?: number) {
    addTrace({
      id: crypto.randomUUID(), time: new Date().toISOString(), source: "browser",
      category, type, label, payload, severity, durationMs,
    });
  }
  // Stops capture, the level meter, stats polling and local playback. The peer connection stays up,
  // because Azure's graceful close needs it until session.closed arrives.
  function disconnect() {
    clearTimeout(stopTimer.current);
    clearTimeout(connectTimer.current);
    clearTimeout(lingerTimer.current);
    lingering.current = false;
    stopping.current = false;
    setStopRequestedAt(undefined);
    generation.current++;
    audioController.close();
    const ws = wsRef.current;
    wsRef.current = null;
    setBackendOpen(false);
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }
  // The backend reported idle or error. Keep the control socket open briefly so metrics sent right
  // after the final state still arrive. Media closes immediately.
  function settle() {
    clearTimeout(stopTimer.current);
    clearTimeout(connectTimer.current);
    audioController.close();
    lingering.current = true;
    clearTimeout(lingerTimer.current);
    lingerTimer.current = setTimeout(disconnect, 600);
  }
  function fail(message: string) {
    setError(message);
    browserTrace("browser.error", message, { message }, "error");
    setPhase("error");
    disconnect();
  }
  function loadConfig(signal?: AbortSignal) {
    setConfigError("");
    void fetch("/api/config", { signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Backend HTTP ${response.status}`);
        const value: unknown = await response.json();
        if (!isObject(value) || typeof value.endpoint !== "string" ||
          typeof value.liveDeployment !== "string" || typeof value.reasoningDeployment !== "string") {
          throw new Error("Invalid backend configuration.");
        }
        setConfig({
          endpoint: value.endpoint, liveDeployment: value.liveDeployment, reasoningDeployment: value.reasoningDeployment,
          webSearchAvailable: value.webSearchAvailable === true,
        });
      })
      .catch((error: unknown) => {
        if (!signal?.aborted)
          setConfigError(`Cannot reach the backend: ${errorMessage(error)}. Check .env and the npm run dev terminal.`);
      });
  }
  useEffect(() => {
    const abort = new AbortController();
    const onDeviceChange = () => { void audioController.refreshDevices().catch(() => undefined); };
    void audioController.refreshDevices().catch(() => undefined);
    navigator.mediaDevices?.addEventListener("devicechange", onDeviceChange);
    loadConfig(abort.signal);
    return () => {
      abort.abort();
      navigator.mediaDevices?.removeEventListener("devicechange", onDeviceChange);
      disconnect();
    };
  }, []);
  useEffect(() => {
    if (phase === "live")
      setLiveAt((value) => value ?? Date.now());
    if ((phase === "idle" || phase === "error") && startedAt !== undefined)
      setEndedAt((value) => value ?? Date.now());
  }, [phase, startedAt]);
  useEffect(() => {
    if (phase !== "live" && phase !== "starting" && phase !== "stopping")
      return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);
  async function start() {
    disconnect();
    const run = generation.current;
    startupAt.current = performance.now();
    startSent.current = false;
    setPhase("starting");
    setError("");
    setObservation(observer.reset());
    setMetrics(emptySessionMetrics());
    setMetricsReceived(false);
    setSessionId("");
    setRtcState("none");
    setStartedAt(undefined);
    setLiveAt(undefined);
    setEndedAt(undefined);
    setStartedAt(Date.now());
    setRunId((value) => value + 1);
    setNow(Date.now());
    browserTrace("browser.start", "Requesting microphone access", {});
    try {
      const { ready: iceReady } = await audioController.prepareSession(startupAt.current);
      if (run !== generation.current)
        return;
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/events`);
      wsRef.current = ws;
      const backendReady = new Promise<void>((resolve, reject) => {
        let settled = false;
        ws.onopen = () => {
          if (run !== generation.current) {
            reject(new Error("Session startup was cancelled."));
            return;
          }
          setBackendOpen(true);
          setNow(Date.now());
          browserTrace("browser.backend.open", "Backend connected; Azure authentication overlaps ICE gathering", {}, "session", undefined, Math.round(performance.now() - (startupAt.current ?? performance.now())));
          connectTimer.current = setTimeout(() => {
            if (run === generation.current)
              fail("Audio was not ready within 45 seconds. Session ended locally.");
          }, 45000);
          ws.send(JSON.stringify({ type: "prepare" }));
          if (config?.webSearchAvailable)
            ws.send(JSON.stringify({ type: "search", enabled: webSearchEnabled }));
          settled = true;
          resolve();
        };
        ws.onmessage = ({ data }) => {
          if (run !== generation.current)
            return;
          try {
            const message: unknown = JSON.parse(String(data));
            if (!isServerMessage(message))
              throw new Error("Invalid message from backend.");
            void handleMessage(message, run).catch((error: unknown) => {
              if (run === generation.current)
                fail(errorMessage(error));
            });
          }
          catch (error) {
            fail(errorMessage(error));
          }
        };
        ws.onerror = () => {
          if (!settled)
            reject(new Error("Could not open backend connection."));
          if (run === generation.current && !lingering.current) {
            fail("Backend connection failed. Check that the backend is running and no other demo tab is connected.");
          }
        };
        ws.onclose = () => {
          if (!settled)
            reject(new Error("Backend WebSocket closed before connecting."));
          if (run === generation.current && !lingering.current)
            fail("Backend connection lost. Session ended locally.");
        };
      });
      const [sdp] = await Promise.all([iceReady, backendReady]);
      if (run !== generation.current || stopping.current)
        return;
      browserTrace("browser.offer.ready", "WebRTC offer ready; authentication requested", {}, "session", undefined, Math.round(performance.now() - (startupAt.current ?? performance.now())));
      browserTrace("browser.azure.create.started", "Creating Azure Live session", {});
      startSent.current = true;
      ws.send(JSON.stringify({ type: "start", sdp }));
    }
    catch (error) {
      if (run === generation.current)
        fail(errorMessage(error));
    }
  }
  async function handleMessage(message: ServerMessage, run: number) {
    if (message.type === "trace") {
      addTrace(message.event);
    }
    else if (message.type === "state") {
      // After Stop, only the backend's stopping, idle and error states count. A late live state must not revive the UI.
      if (!stopping.current || message.phase === "stopping" || message.phase === "idle" || message.phase === "error") {
        setPhase(message.phase);
      }
      if (message.sessionId)
        setSessionId(message.sessionId);
      if (message.phase === "idle" || message.phase === "error")
        settle();
    }
    else if (message.type === "metrics") {
      setMetrics(message.metrics);
      setMetricsReceived(true);
    }
    else if (message.type === "answer") {
      await audioController.answer(message.sdp);
      if (run === generation.current)
        browserTrace("browser.sdp.applied", "Azure SDP answer applied", { type: "answer" });
    }
    else if (message.type === "transcript") {
      setObservation(observer.transcript(message.fragment, Date.now()));
    }
  }
  // Release the microphone and local playback at once, but keep the peer connection open. Azure's
  // graceful close is session.close, then reading until session.closed, then closing the transport.
  // The peer closes when the backend reports idle or error, or after 7 seconds without an answer.
  function stop() {
    clearTimeout(connectTimer.current);
    if (!startSent.current) {
      browserTrace("browser.start.cancelled", "Startup cancelled before Azure session creation", {});
      disconnect();
      audioController.stopCapture();
      setPhase("idle");
      return;
    }
    stopping.current = true;
    audioController.stopCapture();
    setPhase("stopping");
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      setStopRequestedAt(Date.now());
      browserTrace("browser.stop", "Microphone and playback stopped; waiting for backend close confirmation", {});
      stopTimer.current = setTimeout(() => fail("Backend did not confirm closure. Final Azure usage is unknown."), 7000);
      socket.send(JSON.stringify({ type: "stop" }));
    }
    else {
      browserTrace("browser.stop", "Microphone and playback stopped locally", {});
      disconnect();
      setPhase("idle");
    }
  }
  function changeWebSearch(enabled: boolean) {
    setWebSearchEnabled(enabled);
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: "search", enabled }));
  }
  const audioProps = { ref: audioRef, ...audioController.playerEvents };
  return {
    config, configError, retryConfig: () => loadConfig(),
    webSearchEnabled, changeWebSearch,
    phase, events, totalEvents, fragments, totalFragments, observation, metrics, metricsReceived,
    error, dismissError: () => setError(""), sessionId, backendOpen, rtcState,
    startedAt, liveAt, endedAt, stopRequestedAt, now, runId,
    audio: {
      devices: inputDevices, selectedInputId, setSelectedInputId: (value: string) => audioController.selectInputId(value), activeMicLabel, level: inputLevel,
      signal: micSignal, testActive: micTestActive, outputStatus, remoteAudio, blocked: audioBlocked,
      stats: audioStats, statsError: audioStatsError, props: audioProps, unlock: () => audioController.unlock(),
    },
    start, stop, testMicrophone: () => audioController.testMicrophone(),
  };
}
export type LiveSession = ReturnType<typeof useLiveSession>;
