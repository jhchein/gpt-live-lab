import { useEffect, useRef, useState } from "react";
import type { Phase } from "../shared/protocol";
import { formatClock } from "./format";
import { MAX_FRAGMENTS } from "./useLiveSession";
import type { ConversationItem } from "./trace";
import { Dot } from "./ui";

interface Props {
  items: ConversationItem[];
  phase: Phase;
  fragmentsSeen: number;
  onMarker: (delegationId: string) => void;
}

export function Conversation({ items, phase, fragmentsSeen, onMarker }: Props) {
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const last = items.at(-1);
  const signature = `${items.length}:${last?.kind === "utterance" ? last.text.length : last?.key ?? ""}`;
  const dropped = Math.max(0, fragmentsSeen - MAX_FRAGMENTS);

  useEffect(() => {
    const element = log.current;
    if (!element) return;
    if (stick.current) element.scrollTop = element.scrollHeight;
    else setUnseen(true);
  }, [signature]);

  function onScroll() {
    const element = log.current;
    if (!element) return;
    stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    if (stick.current) setUnseen(false);
  }

  function jumpToEnd() {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
    stick.current = true;
    setUnseen(false);
  }

  const running = phase === "starting" || phase === "live";

  return <section className="panel conversation" aria-labelledby="conversation-title">
    <div className="panel-head">
      <h2 id="conversation-title">Conversation</h2>
      {dropped > 0 && <span className="panel-meta">Latest {MAX_FRAGMENTS} transcript fragments</span>}
    </div>
    <div className="convo-wrap">
      <div className="convo-log" ref={log} onScroll={onScroll} role="log" tabIndex={0} aria-label="Conversation transcript">
        {items.length === 0 && <div className="empty">
          <h3>{running ? "Listening" : "Start a conversation"}</h3>
          <p>{running
            ? "Speak now. Transcripts appear as GPT-Live sends them."
            : "Start a session and allow microphone access. Your conversation will appear here."}</p>
          {!running && <p className="example">Try: &quot;Compare two ways to solve a problem. Think it through before answering.&quot;</p>}
        </div>}
        {items.map((item) => item.kind === "utterance"
          ? <div className={`utterance ${item.speaker}`} key={item.key}>
            <div className="utterance-meta">
              <span>{item.speaker === "user" ? "You" : "GPT-Live"}</span>
              <span title="Position in the session audio stream">{formatClock(item.startMs / 1000)}</span>
            </div>
            <p>{item.text}</p>
          </div>
          : <div className="marker-row" key={item.key}>
            <button type="button" className={`marker tone-${item.tone}`} onClick={() => onMarker(item.delegationId)}>
              <Dot tone={item.tone} />{item.label}
            </button>
          </div>)}
      </div>
      {unseen && <button type="button" className="btn btn-primary jump" onClick={jumpToEnd}>New messages</button>}
    </div>
    <p className="panel-foot">Transcripts may contain errors. Select a delegation marker to inspect its trace.</p>
  </section>;
}
