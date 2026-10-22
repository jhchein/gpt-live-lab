import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { LANES, deriveFlow, laneOf, reachesBrowser, type LaneId, type LaneState, type NodeId } from "./flow";
import type { LiveSession } from "./useLiveSession";

interface Point { x: number; y: number }
interface Box { x: number; y: number; w: number; h: number }
interface Layout {
  wide: boolean;
  width: number;
  height: number;
  spread: number;
  nodes: Record<NodeId, Box>;
  zones: (Box & { title: string; note: string })[];
  links: { forward: LaneId; backward: LaneId; a: Point; b: Point }[];
  labels: { x: number; y: number; anchor: "start" | "middle" | "end"; text: string; strong?: boolean }[];
}

const WIDE: Layout = {
  wide: true, width: 1000, height: 650, spread: 9,
  nodes: {
    browser: { x: 65, y: 70, w: 220, h: 110 }, live: { x: 715, y: 70, w: 220, h: 110 },
    backend: { x: 65, y: 300, w: 220, h: 110 }, reasoning: { x: 715, y: 300, w: 220, h: 110 },
    web: { x: 715, y: 510, w: 220, h: 110 },
  },
  zones: [
    { x: 10, y: 10, w: 330, h: 420, title: "Your computer", note: "localhost only" },
    { x: 660, y: 10, w: 330, h: 420, title: "Azure", note: "your Foundry resource" },
    { x: 660, y: 460, w: 330, h: 180, title: "Microsoft Web IQ", note: "global endpoint" },
  ],
  links: [
    { forward: "mic", backward: "speech", a: { x: 289, y: 104 }, b: { x: 711, y: 104 } },
    { forward: "command", backward: "update", a: { x: 175, y: 184 }, b: { x: 175, y: 296 } },
    { forward: "append", backward: "sideband", a: { x: 289, y: 326 }, b: { x: 711, y: 150 } },
    { forward: "request", backward: "stream", a: { x: 289, y: 372 }, b: { x: 711, y: 372 } },
    { forward: "search", backward: "results", a: { x: 240, y: 414 }, b: { x: 711, y: 556 } },
  ],
  labels: [
    { x: 500, y: 64, anchor: "middle", text: "WebRTC audio, direct", strong: true },
    { x: 500, y: 86, anchor: "middle", text: "your voice" },
    { x: 500, y: 136, anchor: "middle", text: "GPT-Live's voice" },
    { x: 156, y: 236, anchor: "end", text: "Local WebSocket", strong: true },
    { x: 156, y: 254, anchor: "end", text: "events, transcripts" },
    { x: 194, y: 245, anchor: "start", text: "start, stop, audio offer" },
    { x: 480, y: 208, anchor: "end", text: "Sideband WebSocket", strong: true },
    { x: 480, y: 226, anchor: "end", text: "text to speak, close" },
    { x: 530, y: 258, anchor: "start", text: "transcripts," },
    { x: 530, y: 275, anchor: "start", text: "delegation requests" },
    { x: 500, y: 340, anchor: "middle", text: "HTTPS, streamed Responses API", strong: true },
    { x: 500, y: 357, anchor: "middle", text: "conversation context" },
    { x: 500, y: 404, anchor: "middle", text: "streamed answer" },
    { x: 430, y: 530, anchor: "middle", text: "HTTPS Web Search", strong: true },
    { x: 430, y: 550, anchor: "middle", text: "query / source passages" },
  ],
};

const NARROW: Layout = {
  wide: false, width: 400, height: 570, spread: 6,
  nodes: {
    browser: { x: 12, y: 60, w: 156, h: 96 }, live: { x: 232, y: 60, w: 156, h: 96 },
    backend: { x: 12, y: 260, w: 156, h: 96 }, reasoning: { x: 232, y: 260, w: 156, h: 96 },
    web: { x: 232, y: 454, w: 156, h: 96 },
  },
  zones: [
    { x: 4, y: 6, w: 176, h: 366, title: "Your computer", note: "localhost" },
    { x: 220, y: 6, w: 176, h: 366, title: "Azure", note: "Foundry" },
    { x: 220, y: 408, w: 176, h: 154, title: "Microsoft Web IQ", note: "global" },
  ],
  links: [
    { forward: "mic", backward: "speech", a: { x: 172, y: 96 }, b: { x: 228, y: 96 } },
    { forward: "command", backward: "update", a: { x: 90, y: 160 }, b: { x: 90, y: 256 } },
    { forward: "append", backward: "sideband", a: { x: 172, y: 290 }, b: { x: 228, y: 140 } },
    { forward: "request", backward: "stream", a: { x: 172, y: 326 }, b: { x: 228, y: 326 } },
    { forward: "search", backward: "results", a: { x: 110, y: 360 }, b: { x: 228, y: 495 } },
  ],
  labels: [],
};

const TITLES: Record<NodeId, string> = { browser: "Browser", backend: "Backend", live: "GPT-Live", reasoning: "Reasoning model", web: "Web search" };
const STATE_TEXT: Record<LaneState, string> = {
  off: "no connection", open: "connected, quiet", active: "data moving", waiting: "waiting for an answer",
  failed: "last search failed, no data flowing",
};

interface Segment { x1: number; y1: number; x2: number; y2: number; head: string }

function segment(from: Point, to: Point, side: number, spread: number): Segment {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  const ox = -uy * side * spread;
  const oy = ux * side * spread;
  const x1 = from.x + ox;
  const y1 = from.y + oy;
  const x2 = to.x + ox;
  const y2 = to.y + oy;
  const baseX = x2 - ux * 11;
  const baseY = y2 - uy * 11;
  const wing = 5.5;
  const round = (value: number) => value.toFixed(1);
  return {
    x1, y1, x2: x2 - ux * 9, y2: y2 - uy * 9,
    head: `${round(x2)},${round(y2)} ${round(baseX - uy * wing)},${round(baseY + ux * wing)} ${round(baseX + uy * wing)},${round(baseY - ux * wing)}`,
  };
}

function laneGeometry(layout: Layout) {
  const lanes = {} as Record<LaneId, Segment & { from: Point; to: Point }>;
  for (const link of layout.links) {
    // The forward lane runs a to b on one side. The backward lane runs b to a on the other side.
    const forward = segment(link.a, link.b, -1, layout.spread);
    const backward = segment(link.b, link.a, -1, layout.spread);
    lanes[link.forward] = { ...forward, from: { x: forward.x1, y: forward.y1 }, to: { x: forward.x2, y: forward.y2 } };
    lanes[link.backward] = { ...backward, from: { x: backward.x1, y: backward.y1 }, to: { x: backward.x2, y: backward.y2 } };
  }
  return lanes;
}

function useNarrow() {
  const query = "(max-width: 900px)";
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.(query).matches));
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

interface Packet { key: string; lane: LaneId; at: number }
const PACKET_MS = 1000;

function KeyLine({ state, label }: { state: LaneState; label: string }) {
  return <li>
    <svg width="40" height="10" viewBox="0 0 40 10" aria-hidden="true">
      <g className={`lane lane-${state}`}><line className="lane-line" x1="2" y1="5" x2="38" y2="5" /></g>
    </svg>
    {label}
  </li>;
}

export function FlowMap({ session, deployments }: {
  session: LiveSession;
  deployments?: { live: string; reasoning: string };
}) {
  const { phase, rtcState, backendOpen, events, totalEvents, fragments, runId } = session;
  const narrow = useNarrow();
  const layout = narrow ? NARROW : WIDE;
  const geometry = useMemo(() => laneGeometry(layout), [layout]);
  const [now, setNow] = useState(() => Date.now());
  const [packets, setPackets] = useState<Packet[]>([]);
  const processed = useRef({ run: -1, count: 0 });
  const lastSpawn = useRef<Partial<Record<LaneId, number>>>({});

  useEffect(() => {
    setNow(Date.now());
    if (phase === "idle" || phase === "error") return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [phase]);

  // Each newly observed event sends one packet along the connection it travelled on.
  useEffect(() => {
    const newRun = processed.current.run !== runId;
    if (newRun) {
      processed.current = { run: runId, count: 0 };
      lastSpawn.current = {};
      setPackets([]);
    }
    const fresh = Math.min(events.length, totalEvents - processed.current.count);
    processed.current.count = totalEvents;
    if (fresh <= 0) return;
    const freshEvents = events.slice(events.length - fresh);
    const stamp = performance.now();
    const added: Packet[] = [];
    for (const event of freshEvents) {
      const lanes = new Set<LaneId>();
      const lane = laneOf(event);
      if (lane) lanes.add(lane);
      if (reachesBrowser(event)) lanes.add("update");
      for (const id of lanes) {
        // Transcript deltas and relayed events are frequent, so they share a minimum spacing.
        const crowded = event.category === "transcript" || id === "update";
        if (crowded && stamp - (lastSpawn.current[id] ?? -Infinity) < 300) continue;
        lastSpawn.current[id] = stamp;
        added.push({ key: `${event.id}:${id}`, lane: id, at: stamp });
      }
    }
    if (added.length) setPackets((current) => [...current.filter((packet) => stamp - packet.at < PACKET_MS), ...added.slice(-8)]);
  }, [events, totalEvents, runId]);

  const lastSpeechAt = useMemo(() => {
    for (let index = fragments.length - 1; index >= 0; index -= 1) {
      if (fragments[index].speaker === "assistant") return fragments[index].at;
    }
    return undefined;
  }, [fragments]);

  const view = useMemo(() => deriveFlow({
    phase, rtcState, backendOpen, micSignal: session.audio.signal, lastSpeechAt, now,
    webSearchAvailable: session.config?.webSearchAvailable,
    observation: session.observation,
  }), [phase, rtcState, backendOpen, session.audio.signal, lastSpeechAt, now, session.config?.webSearchAvailable, session.observation]);

  const roles: Record<NodeId, string> = {
    browser: "Microphone and speaker", backend: "Local Node.js, delegation",
    live: deployments?.live ?? "Voice model", reasoning: deployments?.reasoning ?? "Reasoning model",
    web: "Public web passages",
  };
  const visiblePackets = packets.filter((packet) => performance.now() - packet.at < PACKET_MS);

  return <section className="panel flow" aria-labelledby="flow-title">
    <div className="panel-head">
      <h2 id="flow-title">Live connections</h2>
      <span className="panel-meta">Arrows show which parts are connected and where data moves right now</span>
    </div>
    <svg className={`flow-svg ${layout.wide ? "is-wide" : "is-narrow"}`} viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img" aria-label="Diagram. Browser and backend run locally. GPT-Live and reasoning run in Azure. The backend can call Microsoft Web IQ for web sources.">
      {layout.zones.map((zone) => <g className="flow-zone" key={zone.title}>
        <rect x={zone.x} y={zone.y} width={zone.w} height={zone.h} rx="18" />
        <text className="flow-zone-title" x={zone.x + 16} y={zone.y + 26}>{zone.title}</text>
        <text className="flow-zone-note" x={zone.x + zone.w - 16} y={zone.y + 26} textAnchor="end">{zone.note}</text>
      </g>)}

      {(Object.keys(LANES) as LaneId[]).map((id) => {
        const lane = geometry[id];
        const state = view.lanes[id];
        return <g className={`lane lane-${state}`} key={id} data-lane={id} data-state={state}>
          <title>{`${LANES[id].label}: ${STATE_TEXT[state]}`}</title>
          <line className="lane-line" x1={lane.x1} y1={lane.y1} x2={lane.x2} y2={lane.y2} />
          <polygon className="lane-head" points={lane.head} />
        </g>;
      })}

      {layout.labels.map((label) => <text className={`flow-label ${label.strong ? "is-strong" : ""}`} key={`${label.x}:${label.y}`}
        x={label.x} y={label.y} textAnchor={label.anchor}>{label.text}</text>)}

      {(Object.keys(layout.nodes) as NodeId[]).map((id) => {
        const box = layout.nodes[id];
        const status = view.nodes[id];
        return <g className={`flow-node tone-${status.tone}`} key={id} data-node={id}>
          <rect x={box.x} y={box.y} width={box.w} height={box.h} rx="14" />
          <text className="flow-node-title" x={box.x + 16} y={box.y + 34}>{TITLES[id]}</text>
          {layout.wide && <text className="flow-node-role" x={box.x + 16} y={box.y + 55}>{roles[id]}</text>}
          <circle className="flow-node-dot" cx={box.x + 22} cy={box.y + box.h - 26} r="5" />
          <text className="flow-node-status" x={box.x + 34} y={box.y + box.h - 21}>{status.text}</text>
        </g>;
      })}

      {visiblePackets.map((packet) => {
        if (packet.lane === "search" || packet.lane === "results") {
          if (view.lanes[packet.lane] === "failed" || view.lanes.search === "waiting") return null;
        }
        const lane = geometry[packet.lane];
        return <circle className="packet" key={packet.key} r={layout.wide ? 6 : 4.5} cx={lane.from.x} cy={lane.from.y}
          style={{ "--dx": `${lane.to.x - lane.from.x}px`, "--dy": `${lane.to.y - lane.from.y}px` } as CSSProperties} />;
      })}
    </svg>

    <p className="flow-caption" role="status">{view.caption}</p>

    <ul className="flow-key" aria-label="Arrow legend">
      <KeyLine state="off" label="No connection" />
      <KeyLine state="open" label="Connected, quiet" />
      <KeyLine state="active" label="Data moving" />
      <KeyLine state="waiting" label="Waiting for an answer" />
      <KeyLine state="failed" label="Last search failed" />
    </ul>

    <details className="disclosure">
      <summary>What each connection carries</summary>
      <dl className="flow-notes">
        <div><dt>WebRTC audio, browser and GPT-Live</dt>
          <dd>Your microphone goes up and GPT-Live's voice comes down at the same time. Audio never passes through the backend. These arrows follow your microphone level and GPT-Live's speech transcript, because the browser reports no single audio packets.</dd></div>
        <div><dt>Local WebSocket, browser and backend</dt>
          <dd>The browser sends start, stop and its audio offer. The backend returns the audio answer, trace events, transcripts and usage. Both run on this computer.</dd></div>
        <div><dt>Sideband WebSocket, backend and GPT-Live</dt>
          <dd>The backend creates the session over HTTPS, then listens on a WebSocket. GPT-Live sends transcripts and delegation requests. The backend sends text for GPT-Live to speak.</dd></div>
        <div><dt>HTTPS stream, backend and reasoning model</dt>
          <dd>A request carries the conversation. Searches add follow-up model requests with source passages. Answer text returns to the backend and then GPT-Live. A link is open only while that request is active.</dd></div>
        <div><dt>HTTPS, backend and Web IQ</dt>
          <dd>The reasoning model can request a search. The backend sends a targeted query to Web IQ, then passes source text back to the model in a follow-up reasoning request. No browser-held search credentials.</dd></div>
      </dl>
    </details>
  </section>;
}
