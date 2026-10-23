import { isObject, type TokenUsage, type TraceEvent } from "../../../shared/protocol";
import { sourceUrl, type SearchSource } from "../../../shared/search";
import { byteLength, formatDuration } from "../../ui/format";
import { severityOf, timeOf } from "../events";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

const field = (payload: unknown, key: string): unknown => (isObject(payload) ? payload[key] : undefined);

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
