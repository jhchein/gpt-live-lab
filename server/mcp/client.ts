import { isObject, type JsonObject } from "../../shared/protocol.ts";
import { parseSseFrames } from "../reasoning/protocol.ts";

const PROTOCOL_VERSION = "2025-06-18";
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_RESPONSE_CHARS = 4_000_000;
const MAX_RESULT_CHARS = 16_000;
const CALL_TIMEOUT_MS = 20_000;

export interface McpFunctionTool {
  type: "function"; name: string; description: string; parameters: JsonObject; strict: false;
}
export interface McpCallResult { text: string; isError: boolean; truncated: boolean }
export interface McpToolbox {
  tools: (signal: AbortSignal) => Promise<McpFunctionTool[]>;
  call: (name: string, argumentsText: string, signal: AbortSignal) => Promise<McpCallResult>;
}
export interface McpOptions {
  url: string;
  token: string;
  // Without an allowlist, only tools that declare readOnlyHint are exposed.
  allowedTools?: string[];
  request?: typeof fetch;
}

class McpHttpError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

// Only protocol-level messages are safe to show. Parsing errors can quote board data.
export function mcpMessage(error: unknown): string {
  return error instanceof McpHttpError ? error.message : "MCP request failed.";
}

export function readMcpToolbox(env: NodeJS.ProcessEnv, request?: typeof fetch): McpToolbox | undefined {
  const url = env.MCP_SERVER_URL?.trim();
  const token = env.MCP_SERVER_TOKEN?.trim();
  if (!url || !token) return undefined;
  const allowedTools = env.MCP_SERVER_TOOLS?.split(",").map((name) => name.trim()).filter(Boolean);
  return createMcpToolbox({ url, token, allowedTools, request });
}

export function createMcpToolbox(options: McpOptions): McpToolbox {
  const url = new URL(options.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("MCP_SERVER_URL must use http or https.");
  if (!options.token.trim()) throw new Error("MCP_SERVER_TOKEN must not be empty.");
  const request = options.request ?? fetch;
  let sessionId: string | undefined;
  let initialized: Promise<void> | undefined;
  let nextId = 1;
  let exposed: McpFunctionTool[] | undefined;

  async function post(body: JsonObject, signal: AbortSignal): Promise<{ response: Response; text: string }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    const response = await request(url, {
      method: "POST", headers, body: JSON.stringify(body), redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
    });
    // Never echo a server error body: it may reflect credentials or board data.
    if (!response.ok) {
      await response.body?.cancel();
      throw new McpHttpError(`MCP server HTTP ${response.status}.`, response.status);
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) throw new McpHttpError("MCP response exceeded the 4 MB limit.");
    return { response, text };
  }

  function replyMessages(response: Response, text: string): JsonObject[] {
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) return parseSseFrames(text, true).events;
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter(isObject) : isObject(parsed) ? [parsed] : [];
  }

  function resultOf(messages: JsonObject[], id: number): JsonObject {
    const reply = messages.find((message) => message.id === id);
    if (!reply) throw new McpHttpError("MCP server returned no reply for the request.");
    if (isObject(reply.error)) throw new McpHttpError(`MCP error ${String(reply.error.code ?? "")}.`);
    if (!isObject(reply.result)) throw new McpHttpError("MCP server returned an invalid result.");
    return reply.result;
  }

  async function rpc(method: string, params: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    const id = nextId++;
    const { response, text } = await post({ jsonrpc: "2.0", id, method, params }, signal);
    return resultOf(replyMessages(response, text), id);
  }

  function initialize(signal: AbortSignal): Promise<void> {
    initialized ??= (async () => {
      const id = nextId++;
      const { response, text } = await post({
        jsonrpc: "2.0", id, method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "gpt-live-lab", version: "0.1.0" } },
      }, signal);
      resultOf(replyMessages(response, text), id);
      sessionId = response.headers.get("mcp-session-id") ?? undefined;
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);
    })().catch((error: unknown) => { initialized = undefined; throw error; });
    return initialized;
  }

  // A stateful server may drop the session. Re-initialize once, then give up.
  async function withSession<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    await initialize(signal);
    try { return await run(); }
    catch (error) {
      if (!(error instanceof McpHttpError) || error.status !== 404) throw error;
      sessionId = undefined; initialized = undefined;
      await initialize(signal);
      return run();
    }
  }

  return {
    async tools(signal) {
      if (exposed) return exposed;
      const result = await withSession(signal, () => rpc("tools/list", {}, signal));
      const list = Array.isArray(result.tools) ? result.tools.filter(isObject) : [];
      const allowed = options.allowedTools?.length ? new Set(options.allowedTools) : undefined;
      exposed = list.flatMap((tool): McpFunctionTool[] => {
        const name = typeof tool.name === "string" ? tool.name : "";
        const readOnly = isObject(tool.annotations) && tool.annotations.readOnlyHint === true;
        if (!TOOL_NAME.test(name) || name === "web_search" || !(allowed ? allowed.has(name) : readOnly)) return [];
        return [{
          type: "function", name, strict: false,
          description: typeof tool.description === "string" ? tool.description.slice(0, 1000) : name,
          parameters: isObject(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} },
        }];
      });
      return exposed;
    },
    async call(name, argumentsText, signal) {
      if (!exposed?.some((tool) => tool.name === name)) throw new Error("Tool is not exposed by the MCP allowlist.");
      const parsed: unknown = argumentsText.trim() ? JSON.parse(argumentsText) : {};
      if (!isObject(parsed)) throw new Error("MCP tool arguments must be a JSON object.");
      const result = await withSession(signal, () => rpc("tools/call", { name, arguments: parsed }, signal));
      const parts = Array.isArray(result.content) ? result.content.filter(isObject) : [];
      const joined = parts.map((part) => part.type === "text" && typeof part.text === "string" ? part.text : `[${String(part.type)} content omitted]`).join("\n");
      return { text: joined.slice(0, MAX_RESULT_CHARS), isError: result.isError === true, truncated: joined.length > MAX_RESULT_CHARS };
    },
  };
}
