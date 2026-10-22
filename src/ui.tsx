import type { ReactNode } from "react";
import type { Source } from "../shared/protocol";
import type { Severity } from "./trace";

export type Tone = "idle" | "accent" | "info" | "ok" | "warn" | "bad";

export const sourceLabels: Record<Source, string> = {
  browser: "Browser", backend: "Backend", live: "GPT-Live", luna: "Reasoning", web: "Web IQ",
};

export const severityTone = (severity: Severity): Tone =>
  severity === "error" ? "bad" : severity === "warning" ? "warn" : "idle";

export function Dot({ tone }: { tone: Tone }) {
  return <i className={`dot tone-${tone}`} aria-hidden="true" />;
}

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge tone-${tone}`}><Dot tone={tone} />{children}</span>;
}

export function SourceTag({ source }: { source: Source }) {
  return <span className={`source source-${source}`}>{sourceLabels[source]}</span>;
}

export function SeverityTag({ severity }: { severity: Severity }) {
  if (severity === "info") return null;
  return <Badge tone={severityTone(severity)}>{severity === "error" ? "Error" : "Warning"}</Badge>;
}
