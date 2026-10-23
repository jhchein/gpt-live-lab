import type { JsonObject, TranscriptFragment } from "../../shared/protocol.ts";

export function readTranscript(event: JsonObject): TranscriptFragment | undefined {
  if (event.type !== "session.input_transcript.delta" &&
      event.type !== "session.output_transcript.delta") return;
  if (typeof event.delta !== "string" || typeof event.start_ms !== "number" ||
      typeof event.end_ms !== "number") {
    throw new Error("GPT-Live sent an invalid transcript fragment.");
  }
  return {
    speaker: event.type === "session.input_transcript.delta" ? "user" : "assistant",
    text: event.delta,
    startMs: event.start_ms,
    endMs: event.end_ms,
  };
}

// A byte-level tokenizer cannot exceed one token per UTF-8 byte.
export function contextChunks(text: string, maxBytes = 480): string[] {
  if (maxBytes < 4) throw new Error("Chunk size must fit a UTF-8 character.");
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
