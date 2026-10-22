import { useMemo, useState } from "react";
import { formatBytes, byteLength } from "./format";
import { displayJson, highlightParts, queryTerms } from "./trace";

// Pretty-printed payload with optional search highlighting and a copy button.
export function JsonView({ payload, query = "", label = "JSON payload" }: { payload: unknown; query?: string; label?: string }) {
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState("");
  const { text, hidden } = useMemo(() => displayJson(payload, reveal), [payload, reveal]);
  const parts = useMemo(() => highlightParts(text, queryTerms(query)), [text, query]);
  const matches = parts.filter((part) => part.match).length;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("Copied");
    } catch {
      setCopied("Copy failed");
    }
    setTimeout(() => setCopied(""), 2000);
  }

  return <div className="json">
    <div className="json-bar">
      <span>{formatBytes(byteLength(text))}</span>
      {query.trim() && <span>{matches} payload matches</span>}
      {hidden > 0 && <span>{hidden} encrypted {hidden === 1 ? "value" : "values"} hidden</span>}
      <span className="json-actions">
        {(hidden > 0 || reveal) && <button type="button" className="btn btn-quiet" onClick={() => setReveal(!reveal)}>
          {reveal ? "Hide raw values" : "Show raw values"}
        </button>}
        <button type="button" className="btn btn-quiet" onClick={() => void copy()}>{copied || "Copy JSON"}</button>
      </span>
    </div>
    <pre tabIndex={0} aria-label={label}>{parts.map((part, index) =>
      part.match ? <mark key={index}>{part.text}</mark> : part.text)}</pre>
  </div>;
}
