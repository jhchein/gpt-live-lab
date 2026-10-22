import {
  isObject,
  type SessionMetrics, type TokenUsage, type TraceEvent, type TranscriptFragment,
} from "../shared/protocol";
import { byteLength, formatDuration } from "./format";
import { sourceUrl, type SearchSource } from "../shared/search";

export type Severity = "info" | "warning" | "error";

export function severityOf(event: TraceEvent): Severity {
  return event.severity ?? (event.category === "error" ? "error" : "info");
}

export function timeOf(event: TraceEvent) {
  return Date.parse(event.time);
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const field = (payload: unknown, key: string): unknown => (isObject(payload) ? payload[key] : undefined);

/* ---------- Delegations ---------- */

export type DelegationStatus = "waiting" | "running" | "answered" | "failed" | "cancelled" | "rejected";

export interface Chunk {
  append: TraceEvent;
  ack?: TraceEvent;
  bytes?: number;
  content?: string;
}

export interface Delegation {
  id: string;
  events: TraceEvent[];
  start: number;
  end: number;
  created?: TraceEvent;
  queued?: TraceEvent;
  ready?: TraceEvent;
  request?: TraceEvent;
  firstText?: TraceEvent;
  response?: TraceEvent;
  failure?: TraceEvent;
  cancelled?: TraceEvent;
  limit?: TraceEvent;
  duplicates: TraceEvent[];
  chunks: Chunk[];
  acks: TraceEvent[];
  problems: TraceEvent[];
  searches: TraceEvent[];
  sources: SearchSource[];
  citedIds: string[];
  status: DelegationStatus;
}

function buildDelegation(id: string, events: TraceEvent[]): Delegation {
  const d: Delegation = {
    id, events, start: 0, end: 0, duplicates: [], chunks: [], acks: [], problems: [], searches: [], sources: [], citedIds: [], status: "waiting",
  };
  const appends: TraceEvent[] = [];
  for (const event of events) {
    if (severityOf(event) !== "info") d.problems.push(event);
    switch (event.type) {
      case "search.request":
      case "search.failed": d.searches.push(event); break;
      case "search.response": {
        const results = field(event.payload, "sources");
        if (Array.isArray(results)) for (const source of results) {
          if (!isObject(source) || typeof source.id !== "string" || !/^S\d+$/.test(source.id) ||
              typeof source.url !== "string" || typeof source.title !== "string") continue;
          const url = sourceUrl(source.url);
          if (url && !d.sources.some((existing) => existing.id === source.id)) {
            d.sources.push({ id: source.id, title: source.title, url, content: text(source.content) ?? "" });
          }
        }
        break;
      }
      case "search.citations": {
        const ids = field(event.payload, "citedIds");
        if (Array.isArray(ids)) d.citedIds = ids.filter((value): value is string => typeof value === "string");
        break;
      }
      case "session.delegation.created": d.created ??= event; break;
      case "delegation.queued": d.queued ??= event; break;
      case "luna.context.ready": d.ready ??= event; break;
      case "luna.request": d.request ??= event; break;
      case "luna.step.request": d.request ??= event; break;
      case "luna.first_text": d.firstText ??= event; break;
      case "luna.response": d.response ??= event; break;
      case "luna.failed": d.failure ??= event; break;
      case "luna.cancelled": d.cancelled ??= event; break;
      case "delegation.limit": d.limit ??= event; break;
      case "delegation.duplicate": d.duplicates.push(event); break;
      case "session.thinking.append":
      case "session.commentary.append": appends.push(event); break;
      case "session.thinking.appended":
      case "session.commentary.appended": d.acks.push(event); break;
    }
  }
  const times = events.map(timeOf).filter(Number.isFinite);
  d.start = times.length ? Math.min(...times) : 0;
  d.end = times.length ? Math.max(...times) : 0;

  // Match each acknowledgment to the append it answers (client_event_id === event_id).
  const byClientId = new Map<string, TraceEvent>();
  const loose: TraceEvent[] = [];
  for (const ack of d.acks) {
    const clientId = text(field(ack.payload, "client_event_id"));
    if (clientId) byClientId.set(clientId, ack);
    else loose.push(ack);
  }
  d.chunks = appends.map((append) => {
    const eventId = text(field(append.payload, "event_id"));
    const content = text(field(append.payload, "content"));
    return {
      append, content, bytes: content === undefined ? undefined : byteLength(content),
      ack: (eventId ? byClientId.get(eventId) : undefined) ?? loose.shift(),
    };
  });

  if (d.failure) d.status = "failed";
  else if (d.cancelled) d.status = "cancelled";
  else if (d.limit && !d.request) d.status = "rejected";
  else if (d.response) d.status = "answered";
  else if (d.request) d.status = "running";
  return d;
}

export function buildDelegations(events: TraceEvent[]): Delegation[] {
  const groups = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (!event.delegationId) continue;
    const list = groups.get(event.delegationId);
    if (list) list.push(event);
    else groups.set(event.delegationId, [event]);
  }
  return [...groups].map(([id, list]) => buildDelegation(id, list)).sort((a, b) => a.start - b.start);
}

/* ---------- Waterfall ---------- */

export interface Lane {
  key: string;
  label: string;
  tone: "idle" | "accent" | "info" | "ok" | "bad" | "warn";
  from?: number;
  to?: number;
  open?: boolean;
  ticks: number[];
  value: string;
  empty?: boolean;
}

export interface Waterfall {
  span: number;
  lanes: Lane[];
}

export function buildWaterfall(d: Delegation, now: number): Waterfall {
  const rel = (event: TraceEvent | undefined) => (event ? timeOf(event) - d.start : NaN);
  const live = d.status === "waiting" || d.status === "running";
  const horizon = Math.max(d.end, live ? now : 0) - d.start;
  const requestAt = rel(d.request);
  const readyAt = rel(d.ready);
  const snapshotMs = d.ready?.durationMs;
  const lanes: Lane[] = [];

  // Queue and context wait. luna.context.ready.durationMs is the snapshot wait itself.
  if (d.status === "rejected") {
    lanes.push({ key: "queue", label: "Queue", tone: "warn", ticks: [], value: "full, rejected" });
  } else if (Number.isFinite(readyAt)) {
    const waitStart = finite(snapshotMs) ? Math.max(0, readyAt - snapshotMs) : readyAt;
    lanes.push({
      key: "queue", label: "Queue", tone: "idle", from: 0, to: waitStart,
      ticks: Number.isFinite(rel(d.queued)) ? [rel(d.queued)] : [], value: formatDuration(waitStart),
    });
    lanes.push({
      key: "snapshot", label: "Context snapshot", tone: "idle", from: waitStart, to: readyAt, ticks: [],
      value: finite(snapshotMs) ? formatDuration(snapshotMs) : formatDuration(readyAt - waitStart),
    });
  } else {
    const to = Number.isFinite(requestAt) ? requestAt : live ? horizon : (d.end - d.start);
    lanes.push({
      key: "queue", label: "Queue and context", tone: "idle", from: 0, to,
      open: !Number.isFinite(requestAt) && live,
      ticks: Number.isFinite(rel(d.queued)) ? [rel(d.queued)] : [],
      value: Number.isFinite(requestAt) ? formatDuration(requestAt) : live ? "running" : formatDuration(to),
    });
  }

  // The Luna call itself.
  const finish = d.failure ?? d.cancelled ?? d.response;
  if (d.request) {
    const finishAt = rel(finish);
    const callMs = finish?.durationMs ?? (Number.isFinite(finishAt) ? finishAt - requestAt : undefined);
    lanes.push({
      key: "luna", label: "Reasoning call",
      tone: d.failure ? "bad" : d.cancelled ? "warn" : "accent",
      from: requestAt, to: Number.isFinite(finishAt) ? finishAt : horizon, open: !finish,
      ticks: [],
      value: `${finish ? formatDuration(callMs) : "running"}${finite(d.firstText?.durationMs) ? ` · first text ${formatDuration(d.firstText.durationMs)}` : ""}`,
    });
  } else {
    lanes.push({
      key: "luna", label: "Reasoning call", tone: "accent", ticks: [], empty: true,
      value: d.status === "rejected" ? "not started" : d.failure ? "not sent" : "not sent yet",
    });
  }

  // Return to GPT-Live, then Azure's acknowledgments.
  const appendTimes = d.chunks.map((chunk) => rel(chunk.append)).filter(Number.isFinite);
  const ackTimes = d.acks.map(rel).filter(Number.isFinite);
  lanes.push(appendTimes.length ? {
    key: "return", label: "Sent to GPT-Live", tone: "info", ticks: appendTimes,
    from: Math.min(...appendTimes), to: Math.max(...appendTimes),
    value: `${d.chunks.length} ${d.chunks.length === 1 ? "chunk" : "chunks"}`,
  } : {
    key: "return", label: "Sent to GPT-Live", tone: "info", ticks: [], empty: true, value: "nothing sent yet",
  });
  lanes.push(ackTimes.length ? {
    key: "ack", label: "Azure acceptance", tone: "ok", ticks: ackTimes,
    from: Math.min(...ackTimes), to: Math.max(...ackTimes),
    value: `${d.acks.length} of ${d.chunks.length} accepted`,
  } : {
    key: "ack", label: "Azure acceptance", tone: "ok", ticks: [], empty: true,
    value: d.chunks.length ? "pending" : "none",
  });

  const points = lanes.flatMap((lane) => [lane.from ?? 0, lane.to ?? 0, ...lane.ticks]).filter(Number.isFinite);
  return { span: Math.max(1, horizon, ...points), lanes };
}

/* ---------- Luna request and response views ---------- */

export interface LunaRequestView {
  model?: string;
  store?: boolean;
  maxOutputTokens?: number;
  instructions?: string;
  input?: string;
}

export function readLunaRequest(payload: unknown): LunaRequestView {
  return {
    model: text(field(payload, "model")),
    store: typeof field(payload, "store") === "boolean" ? (field(payload, "store") as boolean) : undefined,
    maxOutputTokens: finite(field(payload, "max_output_tokens")) ? (field(payload, "max_output_tokens") as number) : undefined,
    instructions: text(field(payload, "instructions")),
    input: text(field(payload, "input")) ??
      (Array.isArray(field(payload, "input")) ? JSON.stringify(field(payload, "input"), null, 2) : undefined),
  };
}

export interface LunaResponseView {
  status?: string;
  output?: string;
  reasoningItems: number;
  detail?: unknown;
  usage: TokenUsage;
}

const count = (value: unknown) => (finite(value) && value >= 0 ? value : undefined);

export function readUsage(payload: unknown): TokenUsage {
  const usage = field(payload, "usage");
  const input = field(usage, "input_tokens_details");
  const output = field(usage, "output_tokens_details");
  const result: TokenUsage = {
    inputTokens: count(field(usage, "input_tokens")),
    outputTokens: count(field(usage, "output_tokens")),
    totalTokens: count(field(usage, "total_tokens")),
    cachedInputTokens: count(field(input, "cached_tokens")),
    reasoningOutputTokens: count(field(output, "reasoning_tokens")),
  };
  return result;
}

// Mirrors the backend's output_text extraction. Reasoning items are only counted, never read.
export function readLunaResponse(payload: unknown): LunaResponseView {
  const parts: string[] = [];
  let reasoningItems = 0;
  const output = field(payload, "output");
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!isObject(item)) continue;
      if (item.type === "reasoning") reasoningItems++;
      if (item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (isObject(part) && part.type === "output_text" && typeof part.text === "string") parts.push(part.text);
      }
    }
  }
  return {
    status: text(field(payload, "status")),
    output: parts.length ? parts.join("\n") : undefined,
    reasoningItems,
    detail: field(payload, "incomplete_details") ?? field(payload, "error"),
    usage: readUsage(payload),
  };
}

export const hasUsage = (usage: TokenUsage) => Object.values(usage).some((value) => value !== undefined);

// Flat key/value view for small backend payloads such as luna.context.ready.
export function simpleEntries(payload: unknown): [string, string][] {
  if (!isObject(payload)) return [];
  return Object.entries(payload)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value) && String(value).length < 120)
    .map(([key, value]) => [key, String(value)]);
}

/* ---------- Step descriptions ---------- */

export function describeStep(event: TraceEvent, chunkNumber?: number): string {
  switch (event.type) {
    case "session.delegation.created": return "GPT-Live created a delegation";
    case "delegation.queued": return "Backend queued the delegation";
    case "luna.context.ready": return "Transcript context ready";
    case "luna.request": return "Reasoning request started";
    case "luna.first_text": return "First reasoning text";
    case "luna.first_append": return "First sentence sent to GPT-Live";
    case "luna.response": return "Reasoning response completed";
    case "luna.step.request": return "Reasoning continued with tool results";
    case "luna.step.response": return "Reasoning step finished";
    case "search.request": return "Backend called Web IQ";
    case "search.attempt": return "Web IQ attempt dispatched";
    case "search.attempt.failed": return "Web IQ attempt returned 503";
    case "search.retry": return "Waiting before the single Web IQ retry";
    case "search.response": return "Web IQ returned source passages";
    case "search.failed": return "Web search failed";
    case "search.citations": return "Answer citations checked against returned sources";
    case "luna.failed": return "Delegation failed";
    case "luna.cancelled": return "Delegation cancelled locally";
    case "session.thinking.append": return `Chunk ${chunkNumber ?? "?"} sent to GPT-Live`;
    case "session.thinking.appended": return `Azure accepted chunk ${chunkNumber ?? "?"}`;
    case "session.commentary.append": return `Sentence ${chunkNumber ?? "?"} sent to GPT-Live for speech`;
    case "session.commentary.appended": return `Azure accepted sentence ${chunkNumber ?? "?"}`;
    case "delegation.duplicate": return "Duplicate delegation ignored";
    case "delegation.limit": return "Queue full, delegation rejected";
    default: return event.label;
  }
}

/* ---------- Issues ---------- */

export interface Issue {
  event: TraceEvent;
  count: number;
}

// Backend and Azure problems, one row per event type with the latest occurrence.
export function collectIssues(events: TraceEvent[]): Issue[] {
  const byType = new Map<string, Issue>();
  for (const event of events) {
    if (event.source === "browser" || severityOf(event) === "info") continue;
    const known = byType.get(event.type);
    byType.set(event.type, { event, count: (known?.count ?? 0) + 1 });
  }
  return [...byType.values()].sort((a, b) => timeOf(b.event) - timeOf(a.event));
}

/* ---------- Conversation ---------- */

export interface Fragment extends TranscriptFragment {
  at: number;
}

export type ConversationItem =
  | { kind: "utterance"; key: string; speaker: TranscriptFragment["speaker"]; text: string; startMs: number }
  | { kind: "marker"; key: string; delegationId: string; tone: Lane["tone"]; label: string };

// Fragments carry their arrival time. Markers come from delegation events. Both clocks run on this machine.
export function buildConversation(fragments: Fragment[], delegations: Delegation[]): ConversationItem[] {
  type Entry = { at: number; fragment?: Fragment; marker?: ConversationItem };
  const entries: Entry[] = fragments.map((fragment) => ({ at: fragment.at, fragment }));
  for (const d of delegations) {
    const short = d.id.slice(-6);
    const finish = d.failure ?? d.cancelled ?? d.response;
    const lastAck = d.acks.at(-1);
    const marker = (event: TraceEvent, tone: Lane["tone"], label: string): Entry => ({
      at: timeOf(event), marker: { kind: "marker", key: `${d.id}:${event.id}`, delegationId: d.id, tone, label },
    });
    if (d.created) entries.push(marker(d.created, "idle", `Delegation ${short} created`));
    if (finish) {
      entries.push(marker(
        finish, d.failure ? "bad" : d.cancelled ? "warn" : "accent",
        d.failure ? `Delegation ${short} failed` : d.cancelled ? `Delegation ${short} cancelled`
          : `Reasoning response ${short}, ${formatDuration(finish.durationMs, "duration unknown")}`));
    }
    if (lastAck) entries.push(marker(lastAck, "ok", `Azure accepted context for ${short}, ${d.acks.length}/${d.chunks.length}`));
  }
  entries.sort((a, b) => (Number.isFinite(a.at) ? a.at : 0) - (Number.isFinite(b.at) ? b.at : 0));

  const items: ConversationItem[] = [];
  for (const entry of entries) {
    if (entry.marker) {
      items.push(entry.marker);
      continue;
    }
    const fragment = entry.fragment!;
    const last = items.at(-1);
    if (last?.kind === "utterance" && last.speaker === fragment.speaker) last.text += fragment.text;
    else items.push({ kind: "utterance", key: `u${items.length}`, speaker: fragment.speaker, text: fragment.text, startMs: fragment.startMs });
  }
  return items;
}

/* ---------- Search and display ---------- */

const searchable = new WeakMap<TraceEvent, string>();

function searchText(event: TraceEvent) {
  let value = searchable.get(event);
  if (value === undefined) {
    let payload = "";
    try { payload = JSON.stringify(event.payload) ?? ""; } catch { payload = ""; }
    value = `${event.type} ${event.label} ${event.source} ${event.category} ${event.delegationId ?? ""} ${payload}`.toLowerCase();
    searchable.set(event, value);
  }
  return value;
}

export function queryTerms(query: string) {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesQuery(event: TraceEvent, terms: string[]) {
  if (!terms.length) return true;
  const haystack = searchText(event);
  return terms.every((term) => haystack.includes(term));
}

const OPAQUE_MIN = 200;

// Long encrypted_content style values are opaque. They hide behind a placeholder until revealed.
export function displayJson(payload: unknown, reveal: boolean): { text: string; hidden: number } {
  let hidden = 0;
  let json: string | undefined;
  try {
    json = JSON.stringify(payload, (key, value: unknown) => {
      if (!reveal && typeof value === "string" && value.length >= OPAQUE_MIN && /encrypted/i.test(key)) {
        hidden++;
        return `[encrypted, ${value.length} characters, hidden]`;
      }
      return value;
    }, 2);
  } catch {
    json = undefined;
  }
  return { text: json ?? "(no content)", hidden };
}

export function highlightParts(source: string, terms: string[]): { text: string; match: boolean }[] {
  if (!terms.length || source.length > 400_000) return [{ text: source, match: false }];
  const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return source.split(pattern).filter((part) => part !== "").map((part, index) => ({ text: part, match: index % 2 === 1 }));
}

/* ---------- Export ---------- */

const SECRET_KEY = /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret|password|passwd|cookie|credential|ephemeral|^token$|^bearer$)/i;
const DEVICE_ID_KEY = /^(device|group)[-_]?id$/i;
// Keys whose subtree describes a capture device. Anything named "label" below them is a device name.
const DEVICE_CONTEXT_KEY = /microphone|track|device|^mic$/i;
const TRACK_SHAPE_KEYS = ["readyState", "enabled", "muted", "deviceId", "groupId"];

function scrubText(value: string): string {
  if (/^[A-Za-z0-9+/_=-]{300,}$/.test(value)) return `[opaque value removed, ${value.length} characters]`;
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [entfernt]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, "[JWT removed]")
    .replace(/((?:api[-_ ]?key|secret|token|password)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1[removed]");
}

// Removes credentials, SDP, encrypted blobs, device IDs and microphone names from a trace payload.
// Only payloads are scrubbed, so the TraceEvent label and conversation text stay as they are. Free text can still hold private content.
export function sanitizeForExport(value: unknown, inDevice = false): unknown {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeForExport(entry, inDevice));
  if (!isObject(value)) return value;
  const device = inDevice || ("label" in value && TRACK_SHAPE_KEYS.some((key) => key in value));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (SECRET_KEY.test(key)) return [key, "[removed]"];
    if (/^sdp$/i.test(key)) return [key, "[SDP removed]"];
    if (/encrypted/i.test(key)) return [key, "[encrypted, removed]"];
    if (DEVICE_ID_KEY.test(key)) return [key, "[device ID removed]"];
    if (device && key === "label") return [key, "[device name removed]"];
    return [key, sanitizeForExport(entry, device || DEVICE_CONTEXT_KEY.test(key))];
  }));
}

export interface ExportInput {
  sessionId: string;
  phase: string;
  startedAt?: number;
  endedAt?: number;
  deployments?: { live: string; reasoning: string };
  metrics: SessionMetrics;
  events: TraceEvent[];
  fragments: Fragment[];
  totalEvents: number;
  totalFragments: number;
  maxEvents: number;
  maxFragments: number;
}

export function buildExport(input: ExportInput) {
  const iso = (value: number | undefined) => (value === undefined ? null : new Date(value).toISOString());
  const kept = input.events.filter((event) => event.category !== "transcript");
  return {
    format: "gpt-live-lab-session",
    version: 1,
    exportedAt: new Date().toISOString(),
    privacy: {
      containsConversation: true,
      note: "Contains conversation text and model requests and responses. Automatic redaction is incomplete. Review before sharing.",
      removed: ["Authorization and tokens", "SDP", "encrypted state", "microphone names", "device IDs"],
    },
    session: {
      id: input.sessionId || null, phase: input.phase, startedAt: iso(input.startedAt), endedAt: iso(input.endedAt),
      localSeconds: input.startedAt === undefined ? null : Math.max(0, Math.round(((input.endedAt ?? Date.now()) - input.startedAt) / 1000)),
      deployments: input.deployments ?? null,
    },
    metrics: input.metrics,
    cost: input.metrics.cost ?? "unavailable: no rates configured",
    buffer: {
      maxEvents: input.maxEvents, eventsSeen: input.totalEvents, eventsInBuffer: input.events.length,
      eventsDropped: Math.max(0, input.totalEvents - input.events.length),
      transcriptEventsExcluded: input.events.length - kept.length,
      maxTranscriptFragments: input.maxFragments, fragmentsSeen: input.totalFragments,
      fragmentsInBuffer: input.fragments.length,
      fragmentsDropped: Math.max(0, input.totalFragments - input.fragments.length),
      note: "Metrics cover the entire session. Events and transcript contain only the latest buffered entries.",
    },
    transcript: input.fragments.map(({ speaker, text, startMs, endMs }) => ({ speaker, text: scrubText(text), startMs, endMs })),
    events: kept.map((event) => ({ ...event, payload: sanitizeForExport(event.payload) })),
  };
}
