import { isObject } from "../../shared/protocol.ts";

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
