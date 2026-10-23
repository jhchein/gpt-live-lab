import type { CostEstimate, PricingConfig } from "./pricing.ts";

export type JsonObject = Record<string, unknown>;
const phases = ["idle", "starting", "live", "stopping", "error"] as const;
const sources = ["browser", "backend", "live", "luna", "web"] as const;
const categories = ["session", "transcript", "delegation", "reasoning", "error", "search"] as const;
const severities = ["info", "warning", "error"] as const;
const closeStatuses = ["open", "requested", "confirmed", "unconfirmed"] as const;
export type Phase = typeof phases[number];
export type Source = typeof sources[number];
export type Category = typeof categories[number];

export interface TraceEvent {
  id: string;
  time: string;
  source: Source;
  category: Category;
  type: string;
  label: string;
  payload: unknown;
  delegationId?: string;
  durationMs?: number;
  severity?: typeof severities[number];
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface SessionMetrics {
  lunaRequests: number;
  lunaResponses: number;
  lunaFailures: number;
  lunaCancelled: number;
  lunaUsage: TokenUsage;
  lunaUsageReports: number;
  lunaUsageIncomplete: boolean;
  lunaCachedUsageIncomplete?: boolean;
  lunaPendingRequests?: number;
  liveSeconds?: number;
  liveStartedAt?: number;
  liveEndedAt?: number;
  liveUsage?: JsonObject;
  liveUsageFinal: boolean;
  closeStatus: typeof closeStatuses[number];
  searchRequests?: number;
  searchSucceeded?: number;
  searchFailed?: number;
  searchUncertain?: number;
  webSearchEnabled?: boolean;
  cost?: CostEstimate;
}

export function emptySessionMetrics(): SessionMetrics {
  return {
    lunaRequests: 0, lunaResponses: 0, lunaFailures: 0, lunaCancelled: 0,
    lunaUsage: {}, lunaUsageReports: 0, lunaUsageIncomplete: false, liveUsageFinal: false, closeStatus: "open",
  };
}

export interface TranscriptFragment {
  speaker: "user" | "assistant";
  text: string;
  startMs: number;
  endMs: number;
}

export interface PublicConfig {
  endpoint: string;
  liveDeployment: string;
  reasoningDeployment: string;
  pricing?: PricingConfig;
  webSearchAvailable?: boolean;
}

export type ClientCommand =
  | { type: "prepare" }
  | { type: "start"; sdp: string }
  | { type: "stop" }
  | { type: "search"; enabled: boolean };

export type ServerMessage =
  | { type: "trace"; event: TraceEvent }
  | { type: "state"; phase: Phase; sessionId?: string }
  | { type: "answer"; sdp: string }
  | { type: "metrics"; metrics: SessionMetrics }
  | { type: "transcript"; fragment: TranscriptFragment };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseObject(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isObject(value)) throw new Error("Expected a JSON object.");
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parsePublicConfig(value: unknown): PublicConfig {
  if (!isObject(value) || typeof value.endpoint !== "string" ||
      typeof value.liveDeployment !== "string" || typeof value.reasoningDeployment !== "string") {
    throw new Error("Invalid backend configuration.");
  }
  return {
    endpoint: value.endpoint, liveDeployment: value.liveDeployment, reasoningDeployment: value.reasoningDeployment,
    webSearchAvailable: value.webSearchAvailable === true,
  };
}

export function parseClientCommand(text: string): ClientCommand {
  const command = parseObject(text);
  switch (command.type) {
    case "prepare": return { type: "prepare" };
    case "stop": return { type: "stop" };
    case "start":
      if (typeof command.sdp !== "string" || !command.sdp.startsWith("v=0") || command.sdp.length > 100_000) {
        throw new Error("A valid WebRTC SDP offer is required.");
      }
      return { type: "start", sdp: command.sdp };
    case "search":
      if (typeof command.enabled !== "boolean") throw new Error("Web search enabled must be a boolean.");
      return { type: "search", enabled: command.enabled };
    default:
      throw new Error(`Unknown browser command: ${String(command.type)}`);
  }
}

export function parseServerMessage(text: string): ServerMessage {
  const message: unknown = JSON.parse(text);
  if (!isServerMessage(message)) throw new Error("Invalid message from backend.");
  return message;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isCount = (value: unknown): value is number => isFiniteNumber(value) && value >= 0;
const isOptionalCount = (value: unknown) => value === undefined || isCount(value);

function isTokenUsage(value: unknown): value is TokenUsage {
  return isObject(value) && isOptionalCount(value.inputTokens) && isOptionalCount(value.outputTokens) &&
    isOptionalCount(value.totalTokens) && isOptionalCount(value.cachedInputTokens) &&
    isOptionalCount(value.reasoningOutputTokens);
}

function isCostEstimate(value: unknown): value is CostEstimate {
  if (!isObject(value) || value.currency !== "USD" || !isCount(value.totalKnownUsd) ||
      typeof value.complete !== "boolean" || typeof value.provisional !== "boolean" ||
      !Array.isArray(value.reasons) || !value.reasons.every((reason) => typeof reason === "string")) {
    return false;
  }
  const { live, reasoning, search } = value;
  if (!isObject(live) || !isObject(reasoning) || !isObject(search)) return false;
  if (![live, reasoning, search].every((subtotal) => isCount(subtotal.knownUsd) && typeof subtotal.complete === "boolean")) {
    return false;
  }
  return typeof live.provisional === "boolean" &&
    ["seconds", "billableSeconds", "usdPerMinute"].every((key) => isOptionalCount(live[key])) &&
    typeof reasoning.inputIncludesCached === "boolean" &&
    ["inputUsd", "cachedInputUsd", "outputUsd", "inputUsdPerMillion", "cachedInputUsdPerMillion", "outputUsdPerMillion"]
      .every((key) => isOptionalCount(reasoning[key])) &&
    isCount(search.requests) && isCount(search.succeeded) && isCount(search.failed) && isCount(search.uncertain) &&
    isOptionalCount(search.usdPerThousand);
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
    closeStatuses.some((status) => status === value.closeStatus);
}

function isServerMessage(value: unknown): value is ServerMessage {
  if (!isObject(value)) return false;
  if (value.type === "state")
    return phases.some((phase) => phase === value.phase) &&
      (value.sessionId === undefined || typeof value.sessionId === "string");
  if (value.type === "answer")
    return typeof value.sdp === "string";
  if (value.type === "metrics")
    return isSessionMetrics(value.metrics);
  if (value.type === "transcript") {
    const fragment = value.fragment;
    return isObject(fragment) && (fragment.speaker === "user" || fragment.speaker === "assistant") &&
      typeof fragment.text === "string" && isFiniteNumber(fragment.startMs) && isFiniteNumber(fragment.endMs);
  }
  if (value.type === "trace") {
    const event = value.event;
    return isObject(event) && typeof event.id === "string" && typeof event.time === "string" &&
      sources.some((source) => source === event.source) && categories.some((category) => category === event.category) &&
      typeof event.type === "string" && typeof event.label === "string" &&
      isOptionalCount(event.durationMs) &&
      (event.delegationId === undefined || typeof event.delegationId === "string") &&
      (event.severity === undefined || severities.some((severity) => severity === event.severity));
  }
  return false;
}
