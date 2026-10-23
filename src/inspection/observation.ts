import { isObject, type TraceEvent, type TranscriptFragment } from "../../shared/protocol";
import { buildDelegations, type Delegation } from "./delegations/model";
import { type Fragment } from "./conversation/model";

export const MAX_EVENTS = 600;
export const MAX_FRAGMENTS = 800;

export interface SearchFlowState {
  event: TraceEvent;
  attempt: number;
  httpStatus?: number;
  retryAt?: number;
}

export function reduceSearchFlow(events: TraceEvent[], previous?: SearchFlowState): SearchFlowState | undefined {
  let state = previous;
  for (const event of events) {
    if (!["search.request", "search.attempt", "search.retry", "search.response", "search.failed"].includes(event.type)) continue;
    const payload = isObject(event.payload) ? event.payload : {};
    const attempt = payload.attempt === 1 || payload.attempt === 2 ? payload.attempt : undefined;
    const httpStatus = typeof payload.httpStatus === "number" && Number.isInteger(payload.httpStatus) &&
      payload.httpStatus >= 400 && payload.httpStatus < 600 ? payload.httpStatus : undefined;
    const retryAt = typeof payload.retryAt === "string" ? Date.parse(payload.retryAt) : NaN;
    state = {
      event,
      attempt: event.type === "search.request" ? 1 : attempt ?? (event.type === "search.retry" ? 2 : state?.attempt ?? 1),
      httpStatus: event.type === "search.retry" ? 503 : httpStatus,
      retryAt: Number.isFinite(retryAt) ? retryAt : undefined,
    };
  }
  return state;
}

export interface Observation {
  events: TraceEvent[];
  totalEvents: number;
  fragments: Fragment[];
  totalFragments: number;
  delegations: Delegation[];
  activeDelegation?: Delegation;
  queuedDelegations: Delegation[];
  searchState?: SearchFlowState;
}

const empty = (): Observation => ({
  events: [], totalEvents: 0, fragments: [], totalFragments: 0,
  delegations: [], queuedDelegations: [],
});

const terminal = new Set(["luna.response", "luna.failed", "luna.cancelled", "delegation.limit"]);

export class SessionObservation {
  private current = empty();
  private pending = new Map<string, Delegation>();

  get snapshot(): Observation { return this.current; }

  reset(): Observation {
    this.pending.clear();
    return this.current = empty();
  }

  transcript(fragment: TranscriptFragment, at: number): Observation {
    return this.current = {
      ...this.current,
      fragments: [...this.current.fragments.slice(-(MAX_FRAGMENTS - 1)), { ...fragment, at }],
      totalFragments: this.current.totalFragments + 1,
    };
  }

  trace(event: TraceEvent): Observation {
    const events = [...this.current.events.slice(-(MAX_EVENTS - 1)), event];
    const id = event.delegationId;
    if (id) {
      if (terminal.has(event.type)) {
        this.pending.delete(id);
      } else if (this.pending.has(id) || ["delegation.queued", "luna.context.ready", "luna.request"].includes(event.type)) {
        const previous = this.pending.get(id);
        const [next] = buildDelegations([...(previous?.events ?? []).slice(-(MAX_EVENTS - 1)), event]);
        // Keep the small execution summary even when its first events leave the detail buffer.
        this.pending.set(id, {
          ...next,
          created: previous?.created ?? next.created,
          queued: previous?.queued ?? next.queued,
          ready: previous?.ready ?? next.ready,
          request: previous?.request ?? next.request,
          firstText: previous?.firstText ?? next.firstText,
          start: previous?.start ?? next.start,
          status: previous?.request || next.request ? "running" : "waiting",
        });
      }
    }
    const work = [...this.pending.values()];
    const active = work.find((item) => item.request || item.ready) ?? work[0];
    const queued = work.filter((item) => item.id !== active?.id);
    const buffered = buildDelegations(events);
    const delegations = buffered.map((item) => {
      const pending = this.pending.get(item.id);
      return pending ? { ...item, status: pending.status } : item;
    });
    for (const pending of work) {
      if (!delegations.some((item) => item.id === pending.id)) delegations.push({ ...pending, events: [] });
    }
    return this.current = {
      ...this.current, events, totalEvents: this.current.totalEvents + 1,
      delegations, activeDelegation: active, queuedDelegations: queued,
      searchState: reduceSearchFlow([event], this.current.searchState),
    };
  }
}
