import type { TraceEvent } from "../../../shared/protocol";

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

export function matchesQuery(event: TraceEvent, terms: string[]) {
  if (!terms.length) return true;
  const haystack = searchText(event);
  return terms.every((term) => haystack.includes(term));
}
