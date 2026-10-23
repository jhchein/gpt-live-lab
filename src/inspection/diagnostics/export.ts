import { isObject, type SessionMetrics, type TraceEvent } from "../../../shared/protocol";
import type { Fragment } from "../conversation/model";

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
