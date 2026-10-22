import type { CostEstimate, PricingConfig } from "./pricing.ts";

export type JsonObject = Record<string, unknown>;
export type Phase = "idle" | "starting" | "live" | "stopping" | "error";
export type Source = "browser" | "backend" | "live" | "luna" | "web";
export type Category = "session" | "transcript" | "delegation" | "reasoning" | "error" | "search";

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
  severity?: "info" | "warning" | "error";
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
  closeStatus: "open" | "requested" | "confirmed" | "unconfirmed";
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

export type ServerMessage =
  | { type: "trace"; event: TraceEvent }
  | { type: "state"; phase: Phase; sessionId?: string }
  | { type: "answer"; sdp: string }
  | { type: "metrics"; metrics: SessionMetrics }
  | { type: "transcript"; fragment: TranscriptFragment };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
