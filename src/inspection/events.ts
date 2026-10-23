import type { TraceEvent } from "../../shared/protocol";

export type Severity = "info" | "warning" | "error";

export function severityOf(event: TraceEvent): Severity {
  return event.severity ?? (event.category === "error" ? "error" : "info");
}

export function timeOf(event: TraceEvent) {
  return Date.parse(event.time);
}

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
