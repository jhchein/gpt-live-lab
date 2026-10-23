import { isObject, parseObject, type JsonObject } from "../../shared/protocol.ts";

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
