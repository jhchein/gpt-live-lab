import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  emptySessionMetrics, errorMessage, isObject, parseObject,
  type Category, type JsonObject, type Phase, type PublicConfig,
  type ServerMessage, type Source, type TraceEvent, type TranscriptFragment,
} from "../../shared/protocol.ts";
import { contextChunks, readTranscript } from "./protocol.ts";
import { scrub } from "../diagnostics/redaction.ts";
import { calculateCost } from "../../shared/pricing.ts";
import type { WebSearch } from "../search/web-search.ts";
import { DelegationExecutor } from "../reasoning/delegation.ts";
import { timeContext } from "../time-context.ts";

export interface SessionDependencies {
  config: PublicConfig;
  getToken: () => Promise<string>;
  emit: (message: ServerMessage) => void;
  request?: typeof fetch;
  connect?: (url: string, token: string) => WebSocket;
  closeTimeoutMs?: number;
  webSearch?: WebSearch;
  delegationTimeoutMs?: number;
  clock?: () => Date;
}

const instructions = [
  "You are a voice demo with a reasoning backend. Be friendly and brief.",
  "Speak English by default. Follow the user's language if they speak another language.",
  "Delegate complex questions, calculations and tasks that need careful thought to the client.",
  "Also delegate requests for up-to-date facts or web verification. Claim web research only when returned backend context supports it.",
  "Decide when to delegate. Do not take external actions.",
  "While waiting, keep listening and briefly explain that the question is being checked.",
  "Returned results may arrive in several fragments. Use them for a concise spoken answer.",
].join(" ");

export class LiveSession {
  private phase: Phase = "idle";
  private socket?: WebSocket;
  private sessionId?: string;
  private lifecycle = new AbortController();
  private transcripts: TranscriptFragment[] = [];
  private contextBytes = 0;
  private queue: string[] = [];
  private seen = new Set<string>();
  private pendingAppends = new Map<string, string>();
  private working = false;
  private reasoningAbort?: AbortController;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private settleStop?: () => void;
  private stopping?: Promise<void>;
  private metrics = emptySessionMetrics();
  private readonly request: typeof fetch;
  private tokenPromise?: Promise<string>;
  private costTimer?: ReturnType<typeof setInterval>;
  private searchEnabled: boolean;
  private readonly executor: DelegationExecutor;

  constructor(private readonly deps: SessionDependencies) {
    this.request = deps.request ?? fetch;
    this.searchEnabled = Boolean(deps.webSearch);
    this.executor = new DelegationExecutor({
      ...deps, transcript: () => this.transcripts,
      report: (metrics) => { Object.assign(this.metrics, metrics); this.emitMetrics(); },
      trace: (...args) => this.trace(...args),
      commentary: (id, text) => this.returnCommentary(id, text),
      context: (id, text) => this.returnContext(id, text),
      canDeliver: () => this.socket?.readyState === WebSocket.OPEN,
    });
    Object.assign(this.metrics, {
      webSearchEnabled: this.searchEnabled, searchRequests: 0, searchSucceeded: 0,
      searchFailed: 0, searchUncertain: 0, lunaPendingRequests: 0,
    });
  }

  get currentPhase() { return this.phase; }

  private state(phase: Phase) {
    this.phase = phase;
    this.deps.emit({ type: "state", phase, sessionId: this.sessionId });
  }

  private emitMetrics() {
    if (this.deps.config.pricing) this.metrics.cost = calculateCost(this.deps.config.pricing, this.metrics, Date.now());
    this.deps.emit({ type: "metrics", metrics: structuredClone(this.metrics) });
  }

  setWebSearch(enabled: boolean) {
    if (enabled && !this.deps.webSearch) throw new Error("Web search is not configured on this backend.");
    this.searchEnabled = enabled;
    this.metrics.webSearchEnabled = enabled;
    this.trace("backend", "session", "search.setting", enabled ? "Web search enabled for the next delegation" : "Web search disabled for the next delegation", { enabled });
    this.emitMetrics();
  }

  trace(source: Source, category: Category, type: string, label: string,
    payload: unknown, delegationId?: string, durationMs?: number,
    severity: TraceEvent["severity"] = category === "error" ? "error" : "info") {
    this.deps.emit({ type: "trace", event: {
      id: randomUUID(), time: new Date().toISOString(), source, category, type,
      label, payload: scrub(payload), delegationId, durationMs, severity,
    } });
  }

  private prepare() {
    if (!this.tokenPromise) {
      const started = performance.now();
      this.tokenPromise = this.deps.getToken().then((token) => {
        this.trace("backend", "session", "backend.auth.ready", "Azure authentication ready", {},
          undefined, Math.round(performance.now() - started));
        return token;
      }).catch((error: unknown) => {
        this.trace("backend", "error", "backend.auth.failed", "Azure authentication failed",
          { message: errorMessage(error) }, undefined, Math.round(performance.now() - started));
        this.tokenPromise = undefined;
        throw error;
      });
    }
    return this.tokenPromise;
  }

  private async jsonRequest(path: string, body: unknown, signal: AbortSignal, existingToken?: string) {
    const token = existingToken ?? await this.deps.getToken();
    signal.throwIfAborted();
    const response = await this.request(`${this.deps.config.endpoint}/openai/v1/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Azure HTTP ${response.status}: ${text.slice(0, 4000)}`);
    return parseObject(text);
  }

  async start(sdp: string) {
    if (this.phase !== "idle") throw new Error("This connection already owns a session. Reconnect before starting again.");
    this.state("starting");
    this.emitMetrics();
    try {
      const body = {
        session: {
          model: this.deps.config.liveDeployment,
          instructions: `${instructions} ${timeContext(this.deps.clock?.() ?? new Date())}`,
          audio: { output: { voice: "marin" } },
          delegation: { type: "client" },
        },
        transport: { type: "webrtc", sdp },
      };
      this.trace("backend", "session", "live.session.request", "Creating WebRTC session", body);
      const token = await this.prepare();
      const requestStarted = performance.now();
      const response = await this.jsonRequest("live/sessions", body, this.lifecycle.signal, token);
      this.trace("live", "session", "live.session.response", "Session response received", response,
        undefined, Math.round(performance.now() - requestStarted));
      if (!isObject(response.session) || typeof response.session.id !== "string" ||
          !isObject(response.transport) || typeof response.transport.sdp !== "string") {
        throw new Error("Azure session response is missing session.id or transport.sdp.");
      }
      this.sessionId = response.session.id;
      this.metrics.liveStartedAt = Date.now();
      this.emitMetrics();
      this.costTimer = setInterval(() => this.emitMetrics(), 1000);
      await this.attach(token);
      this.lifecycle.signal.throwIfAborted();
      this.state("live");
      this.deps.emit({ type: "answer", sdp: response.transport.sdp });
      this.expiryTimer = setTimeout(() => {
        this.trace("backend", "session", "demo.time_limit", "10-minute demo limit reached", {});
        void this.stop();
      }, 600_000);
    } catch (error) {
      if (this.lifecycle.signal.aborted) return;
      this.trace("backend", "error", "session.start.failed", "Session could not start", { message: errorMessage(error) });
      this.finish("error");
    }
  }

  async prepareForSession() {
    await this.prepare();
  }

  private async attach(token: string) {
    this.lifecycle.signal.throwIfAborted();
    const endpoint = new URL(this.deps.config.endpoint);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    endpoint.pathname = `/openai/v1/live/sessions/${encodeURIComponent(this.sessionId!)}/attach`;
    const socket = this.deps.connect
      ? this.deps.connect(endpoint.toString(), token)
      : new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 15_000, maxPayload: 2_000_000 });
    this.socket = socket;
    socket.on("message", (data) => {
      try { this.onLiveEvent(parseObject(data.toString())); }
      catch (error) {
        this.trace("backend", "error", "live.protocol.error", "Invalid Live event", { message: errorMessage(error) });
      }
    });
    socket.on("error", (error) => {
      this.trace("backend", "error", "live.transport.error", "Live control channel failed", { message: error.message });
    });
    socket.on("close", (code, reason) => {
      if (this.phase === "idle" || this.phase === "error") return;
      const requestedNormalClose = this.phase === "stopping" && code === 1000;
      this.trace("backend", requestedNormalClose ? "session" : "error", "live.transport.closed",
        "Control channel closed; final Azure usage unconfirmed", { code, reason: reason.toString() },
        undefined, undefined, requestedNormalClose ? "warning" : "error");
      this.finish(requestedNormalClose ? "idle" : "error");
    });
    const started = performance.now();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        socket.terminate();
        reject(new Error("Session startup cancelled."));
      };
      this.lifecycle.signal.addEventListener("abort", abort, { once: true });
      socket.once("open", () => {
        this.lifecycle.signal.removeEventListener("abort", abort);
        this.trace("backend", "session", "live.sideband.open", "Live control channel connected", {},
          undefined, Math.round(performance.now() - started));
        resolve();
      });
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("Live control channel closed before startup completed.")));
    });
  }

  private onLiveEvent(event: JsonObject) {
    if (this.lifecycle.signal.aborted) return;
    const fragment = readTranscript(event);
    const delegation = isObject(event.delegation) ? event.delegation : undefined;
    const clientEventId = typeof event.client_event_id === "string" ? event.client_event_id
      : isObject(event.error) && typeof event.error.client_event_id === "string" ? event.error.client_event_id : undefined;
    const delegationId = typeof delegation?.id === "string" ? delegation.id
      : typeof event.delegation_id === "string" ? event.delegation_id
      : clientEventId ? this.pendingAppends.get(clientEventId) : undefined;
    if (clientEventId) this.pendingAppends.delete(clientEventId);
    const category: Category = event.type === "error" ? "error" : fragment ? "transcript"
      : String(event.type).includes("delegation") || String(event.type).includes("append") ? "delegation" : "session";
    this.trace("live", category, String(event.type), String(event.type), event, delegationId);
    if (event.type === "session.usage.updated" || event.type === "session.closed") {
      const value = scrub(event.usage);
      const usage = isObject(value) ? value : undefined;
      const seconds = usage?.seconds;
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
        this.metrics.liveSeconds = seconds;
        this.metrics.liveUsage = usage;
        this.metrics.liveUsageFinal = event.type === "session.closed";
        this.emitMetrics();
      } else {
        this.trace("backend", "session", "live.usage.missing", "Azure did not report valid usage seconds",
          { eventType: event.type, usage: value }, undefined, undefined, "warning");
      }
    }
    if (fragment) {
      this.transcripts.push(fragment);
      this.contextBytes += Buffer.byteLength(fragment.text);
      while (this.contextBytes > 32_000 && this.transcripts.length > 1) {
        this.contextBytes -= Buffer.byteLength(this.transcripts.shift()!.text);
      }
      this.deps.emit({ type: "transcript", fragment });
    }
    if (event.type === "session.delegation.created" && delegation?.target === "client") {
      if (!delegationId) throw new Error("Delegation is missing its id.");
      if (this.phase === "stopping") return;
      if (this.seen.has(delegationId)) {
        this.trace("backend", "delegation", "delegation.duplicate", "Duplicate delegation ignored", {}, delegationId);
        return;
      }
      this.seen.add(delegationId);
      if (this.queue.length >= 4) {
        this.trace("backend", "error", "delegation.limit", "Delegation queue is full", {}, delegationId);
        this.returnContext(delegationId, "The reasoning backend is busy. Ask the user to try again in their language.");
        return;
      }
      this.queue.push(delegationId);
      this.trace("backend", "delegation", "delegation.queued", "Delegation queued for reasoning", { queueLength: this.queue.length }, delegationId);
      void this.runQueue();
    }
    if (event.type === "session.closed") {
      this.metrics.closeStatus = "confirmed";
      this.finish("idle");
    }
  }

  private async runQueue() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length && !this.lifecycle.signal.aborted && this.phase !== "stopping") {
        const id = this.queue.shift()!;
        const abort = new AbortController();
        this.reasoningAbort = abort;
        try {
          await this.executor.run(id, AbortSignal.any([abort.signal, this.lifecycle.signal]), this.searchEnabled);
        } finally { this.reasoningAbort = undefined; }
      }
    } finally { this.working = false; }
  }

  private returnContext(id: string, text: string) {
    for (const content of contextChunks(text)) {
      this.sendLive({
        type: "session.thinking.append", event_id: randomUUID(),
        delegation_id: id, content,
      }, "Context sent to GPT-Live", id);
    }
  }

  private returnCommentary(id: string, text: string) {
    const spoken = text.replace(/\[S\d+\]/g, "");
    if (!spoken.trim()) return false;
    for (const content of contextChunks(spoken)) {
      this.sendLive({
        type: "session.commentary.append", event_id: randomUUID(),
        delegation_id: id, content,
      }, "Reasoning sentence sent to GPT-Live for speech", id);
    }
    return true;
  }

  private sendLive(event: JsonObject, label: string, delegationId?: string) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Live control channel is not open.");
    if (delegationId && typeof event.event_id === "string") {
      this.pendingAppends.set(event.event_id, delegationId);
    }
    this.socket.send(JSON.stringify(event));
    this.trace("backend", event.type === "session.close" ? "session" : "delegation", String(event.type), label, event, delegationId);
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.phase === "idle" || this.phase === "error") return Promise.resolve();
    this.state("stopping");
    this.metrics.closeStatus = "requested";
    this.emitMetrics();
    this.reasoningAbort?.abort();
    this.queue = [];
    this.stopping = new Promise<void>((resolve) => { this.settleStop = resolve; });
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendLive({ type: "session.close", event_id: randomUUID() }, "Session closure requested");
      this.closeTimer = setTimeout(() => {
        this.trace("backend", "error", "session.close.timeout",
          "No session.closed confirmation; final Azure usage unknown", {});
        this.finish("error");
      }, this.deps.closeTimeoutMs ?? 5000);
    } else {
      this.trace("backend", "error", "session.start.cancelled",
        "Startup cancelled locally; Azure session closure unconfirmed", {});
      this.finish("error");
    }
    return this.stopping;
  }

  private finish(phase: "idle" | "error") {
    clearInterval(this.costTimer);
    if (this.metrics.liveStartedAt !== undefined) this.metrics.liveEndedAt = Date.now();
    clearTimeout(this.closeTimer);
    clearTimeout(this.expiryTimer);
    this.lifecycle.abort();
    this.reasoningAbort?.abort();
    this.queue = [];
    if (this.metrics.closeStatus !== "confirmed") this.metrics.closeStatus = "unconfirmed";
    this.emitMetrics();
    this.state(phase);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
    else if (this.socket?.readyState === WebSocket.CONNECTING) this.socket.terminate();
    this.settleStop?.();
  }
}
