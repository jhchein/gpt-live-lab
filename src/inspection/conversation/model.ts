import type { TraceEvent, TranscriptFragment } from "../../../shared/protocol";
import { formatDuration } from "../../ui/format";
import type { Tone } from "../../ui/indicators";
import type { Delegation } from "../delegations/model";
import { timeOf } from "../events";

export interface Fragment extends TranscriptFragment {
  at: number;
}

export type ConversationItem =
  | { kind: "utterance"; key: string; speaker: TranscriptFragment["speaker"]; text: string; startMs: number }
  | { kind: "marker"; key: string; delegationId: string; tone: Tone; label: string };

// Fragments carry their arrival time. Markers come from delegation events. Both clocks run on this machine.
export function buildConversation(fragments: Fragment[], delegations: Delegation[]): ConversationItem[] {
  type Entry = { at: number; fragment?: Fragment; marker?: ConversationItem };
  const entries: Entry[] = fragments.map((fragment) => ({ at: fragment.at, fragment }));
  for (const d of delegations) {
    const short = d.id.slice(-6);
    const finish = d.failure ?? d.cancelled ?? d.response;
    const lastAck = d.acks.at(-1);
    const marker = (event: TraceEvent, tone: Tone, label: string): Entry => ({
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
