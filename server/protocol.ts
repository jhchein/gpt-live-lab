import { isObject, type JsonObject, type TranscriptFragment } from "../shared/protocol.ts";

export function parseObject(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isObject(value)) throw new Error("Expected a JSON object.");
  return value;
}

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

export function outputText(response: JsonObject): string {
  if (response.status !== "completed") {
    throw new Error(`Reasoning response is ${String(response.status)}: ${JSON.stringify(response.incomplete_details ?? response.error ?? {})}`);
  }
  const parts: string[] = [];
  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      if (!isObject(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (isObject(content) && content.type === "output_text" && typeof content.text === "string") {
          parts.push(content.text);
        }
      }
    }
  }
  if (!parts.length) throw new Error("Reasoning model returned no output_text. Inspect the response JSON.");
  return parts.join("\n");
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

export function takeCompleteSentences(text: string): { complete: string[]; remainder: string } {
  const complete: string[] = [];
  const boundary = /[.!?…]["'”’)]*\s+|\n+/gu;
  let start = 0;
  for (const match of text.matchAll(boundary)) {
    const end = match.index! + match[0].length;
    complete.push(text.slice(start, end));
    start = end;
  }
  return { complete, remainder: text.slice(start) };
}

export function parseSseFrames(buffer: string, final = false): { events: JsonObject[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames = normalized.split("\n\n");
  const remainder = final ? "" : frames.pop()!;
  const completeFrames = final ? frames : frames;
  const events: JsonObject[] = [];
  for (const frame of completeFrames) {
    const data = frame.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") continue;
    events.push(parseObject(data));
  }
  return { events, remainder };
}

export function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (/^(authorization|x-api[-_]?key|api[-_]?key|web_iq_api_key|access_token|refresh_token|client_secret)$/i.test(key)) return [key, "[redacted]"];
    if (key.toLowerCase() === "sdp") return [key, "[redacted: WebRTC SDP]"];
    if (key.toLowerCase() === "encrypted_content") return [key, "[omitted: encrypted model state]"];
    return [key, scrub(entry)];
  }));
}
