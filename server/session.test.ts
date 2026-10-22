import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { LiveSession } from "./session.ts";
import { createApp } from "./app.ts";
import { parseObject } from "./protocol.ts";
import { isObject, type JsonObject, type ServerMessage } from "../shared/protocol.ts";
import { createWebSearch, WebSearchError, type WebSearch } from "./web-search.ts";
import { readPricing } from "./pricing.ts";
import type { PricingConfig } from "../shared/pricing.ts";

async function until(check: () => boolean, message = "Condition was not reached") {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(t: TestContext, options: {
  status?: number; delayed?: boolean; delayedSession?: boolean; noCloseAck?: boolean; invalidSession?: boolean;
  response?: JsonObject; streamDeltas?: string[]; streamDelayMs?: number; streamFailure?: boolean;
  closeWithoutAck?: { code: number; reason: string };
  steps?: JsonObject[];
  webSearch?: WebSearch;
  delegationTimeoutMs?: number;
  pricing?: PricingConfig;
  clock?: () => Date;
} = {}) {
  const received: JsonObject[] = [];
  const requests: { path: string; body: JsonObject; authorization: string | undefined }[] = [];
  let sideband: WebSocket | undefined;
  let activeCalls = 0;
  let maxActiveCalls = 0;
  let stepIndex = 0;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    requests.push({ path: request.url!, body: parseObject(text), authorization: request.headers.authorization });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/openai/v1/live/sessions") {
      if (options.delayedSession) await new Promise((resolve) => setTimeout(resolve, 200));
      response.end(JSON.stringify(options.invalidSession ? { session: {} } : { session: { id: "sess_test" }, transport: { sdp: "v=0\r\nanswer" } }));
    } else {
      activeCalls++;
      maxActiveCalls = Math.max(activeCalls, maxActiveCalls);
      if (options.delayed) await new Promise((resolve) => setTimeout(resolve, 700));
      else await new Promise((resolve) => setTimeout(resolve, 30));
      activeCalls--;
      response.statusCode = options.status ?? 200;
      if (options.status) {
        response.end(JSON.stringify({ error: { message: "Forbidden test" } }));
        return;
      }
      const result = options.steps?.[stepIndex++] ?? options.response ?? {
        id: "resp_test", status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "The result is 42." }] }],
        usage: { total_tokens: 50 },
      };
      const deltas = options.streamDeltas ?? (Array.isArray(result.output)
        ? result.output.flatMap((item) => {
          if (!isObject(item) || !Array.isArray(item.content)) return [];
          return item.content.flatMap((content) =>
            isObject(content) && typeof content.text === "string" ? [content.text] : []);
        })
        : []);
      response.setHeader("Content-Type", "text/event-stream");
      const writeEvent = (event: JsonObject) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      for (let index = 0; index < deltas.length; index++) {
        writeEvent({ type: "response.output_text.delta", delta: deltas[index] });
        if (index === 0 && options.streamDelayMs) await new Promise((resolve) => setTimeout(resolve, options.streamDelayMs));
      }
      if (options.streamFailure) {
        writeEvent({ type: "response.failed", response: { ...result, status: "failed" } });
      } else {
        const terminalType = result.status === "incomplete" ? "response.incomplete" : "response.completed";
        writeEvent({ type: terminalType, response: result });
      }
      response.end("data: [DONE]\n\n");
    }
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket, request) => {
    assert.equal(request.url, "/openai/v1/live/sessions/sess_test/attach");
    assert.equal(request.headers.authorization, "Bearer test-token");
    sideband = socket;
    socket.on("message", (raw) => {
      const message = parseObject(raw.toString());
      received.push(message);
      if (message.type === "session.thinking.append" || message.type === "session.commentary.append") {
        socket.send(JSON.stringify({
          type: `${message.type}ed`, client_event_id: message.event_id, start_ms: 100, end_ms: 110,
        }));
      }
      if (message.type === "session.close" && options.closeWithoutAck) {
        socket.close(options.closeWithoutAck.code, options.closeWithoutAck.reason);
      } else if (message.type === "session.close" && !options.noCloseAck) {
        socket.send(JSON.stringify({ type: "session.closed", reason: "close_requested", usage: { seconds: 15 } }));
        socket.close();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = {
    endpoint: `http://127.0.0.1:${address.port}`, liveDeployment: "live-test", reasoningDeployment: "reasoning-test",
    ...(options.pricing ? { pricing: options.pricing } : {}),
  };
  const messages: ServerMessage[] = [];
  let tokenCalls = 0;
  const getToken = async () => { tokenCalls++; return "test-token"; };
  const session = new LiveSession({
    config, getToken, emit: (message) => messages.push(message), closeTimeoutMs: 100,
    webSearch: options.webSearch, delegationTimeoutMs: options.delegationTimeoutMs,
    clock: options.clock,
  });
  t.after(async () => {
    await session.stop();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    session, messages, requests, received, config, getToken,
    send: (message: JsonObject) => {
      assert.ok(sideband);
      sideband.send(JSON.stringify(message));
    },
    closeSideband: (code: number, reason: string) => {
      assert.ok(sideband);
      sideband.close(code, reason);
    },
    get tokenCalls() { return tokenCalls; },
    get maxActiveCalls() { return maxActiveCalls; },
  };
}

const input = { type: "session.input_transcript.delta", delta: "What is six times seven?", start_ms: 100, end_ms: 800 };
const delegation = (id = "delegation_1") => ({ type: "session.delegation.created", delegation: { id, type: "delegation", target: "client" } });
const hasTrace = (messages: ServerMessage[], type: string) => messages.some((message) => message.type === "trace" && message.event.type === type);
function lastMetrics(messages: ServerMessage[]) {
  const message = messages.filter((entry) => entry.type === "metrics").at(-1);
  assert.ok(message?.type === "metrics");
  return message.metrics;
}

test("clock is provided to GPT-Live and refreshed for every reasoning tool continuation", async (t) => {
  let current = new Date("2026-10-22T18:00:00Z");
  const f = await fixture(t, {
    steps: [toolResponse("clock-search"), answerResponse], clock: () => current,
    webSearch: async (...args) => {
      const result = await mockSearch(...args);
      current = new Date("2026-10-22T18:01:00Z");
      return result;
    },
  });

  await f.session.start("v=0\r\noffer");
  const live = f.requests[0].body.session;
  assert.ok(isObject(live));
  assert.match(String(live.instructions), /2026-10-22T18:00:00\.000Z/);
  f.send(input); f.send(delegation());
  await until(() => hasTrace(f.messages, "luna.response"));
  const requests = f.requests.filter((request) => request.path.endsWith("/responses"));
  assert.match(String(requests[0].body.instructions), /2026-10-22T18:00:00\.000Z/);
  assert.match(String(requests[1].body.instructions), /2026-10-22T18:01:00\.000Z/);
});

test("503 retry attempts are individually traced and priced without phantom pending charges", async (t) => {
  let requests = 0;
  const webSearch = createWebSearch("fixture-key", async () => ++requests === 1
    ? new Response(null, { status: 503, headers: { "Retry-After": "0" } })
    : Response.json({ webResults: [] }));
  const f = await fixture(t, {
    steps: [toolResponse("retry-search"), answerResponse], webSearch, pricing: readPricing({}),
  });
  await f.session.start("v=0\r\noffer"); f.send(input); f.send(delegation());
  await until(() => hasTrace(f.messages, "luna.response"));
  const metrics = lastMetrics(f.messages);
  assert.equal(requests, 2);
  assert.equal(metrics.searchRequests, 2);
  assert.equal(metrics.searchFailed, 1);
  assert.equal(metrics.searchSucceeded, 1);
  assert.equal(metrics.searchUncertain, 1);
  assert.equal(metrics.cost?.search.knownUsd, 0.014);
  assert.ok(!metrics.cost?.reasons.some((reason) => /Search requests are pending|counts are incomplete/.test(reason)));
  assert.equal(f.messages.filter((message) => message.type === "trace" && message.event.type === "search.attempt").length, 2);
  assert.ok(hasTrace(f.messages, "search.retry"));
  const response = f.messages.find((message) => message.type === "trace" && message.event.type === "search.response");
  assert.ok(response?.type === "trace" && isObject(response.event.payload));
  assert.equal(response.event.payload.attempt, 2);
});

test("Stop during Retry-After waiting counts only the request already sent", async (t) => {
  let requests = 0;
  const webSearch = createWebSearch("fixture-key", async () => {
    requests++;
    return new Response(null, { status: 503, headers: { "Retry-After": "10" } });
  });
  const f = await fixture(t, { steps: [toolResponse("retry-stop")], webSearch, pricing: readPricing({}) });
  await f.session.start("v=0\r\noffer"); f.send(input); f.send(delegation());
  await until(() => hasTrace(f.messages, "search.retry"));
  await f.session.stop();
  await until(() => hasTrace(f.messages, "luna.cancelled"));
  const metrics = lastMetrics(f.messages);
  assert.equal(requests, 1);
  assert.equal(metrics.searchRequests, 1);
  assert.equal(metrics.searchFailed, 1);
  assert.equal(metrics.searchUncertain, 1);
  assert.equal(metrics.cost?.search.knownUsd, 0.007);
  assert.ok(!metrics.cost?.reasons.some((reason) => /Search requests are pending|counts are incomplete/.test(reason)));
});

const toolResponse = (callId: string): JsonObject => ({
  status: "completed",
  output: [
    { type: "reasoning", id: `reasoning-${callId}`, encrypted_content: "fixture-private-reasoning-state" },
    { type: "function_call", call_id: callId, name: "web_search", arguments: '{"query":"current research"}' },
  ],
  usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 } },
});
const answerResponse = {
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "A sourced answer [S1]. " }] }],
  usage: { input_tokens: 40, output_tokens: 15, total_tokens: 55, input_tokens_details: { cached_tokens: 0 } },
};
const mockSearch: WebSearch = async (_query, signal, dispatched) => {
  signal.throwIfAborted();
  dispatched();
  return { sources: [{ title: "A source", url: "https://example.com/article", content: "Source evidence" }], instrumentationAvailable: false };
};

test("failed searches expose structured HTTP status to the diagram, without the response body", async (t) => {
  const webSearch = createWebSearch("fixture-only-key", async () =>
    new Response("fixture-private-provider-body", { status: 503, headers: { "Retry-After": "0" } }));
  const f = await fixture(t, { steps: [toolResponse("failed-status"), answerResponse], webSearch });
  await f.session.start("v=0\r\noffer"); f.send(input); f.send(delegation());
  await until(() => hasTrace(f.messages, "luna.response"));
  const failed = f.messages.find((message) => message.type === "trace" && message.event.type === "search.failed");
  assert.ok(failed?.type === "trace" && isObject(failed.event.payload));
  assert.equal(failed.event.payload.httpStatus, 503);
  assert.equal(failed.event.payload.attempt, 2);
  assert.ok(!JSON.stringify(f.messages).includes("fixture-private-provider-body"));
});

test("tool loop preserves encrypted state privately, accounts for all steps, and correlates sources", async (t) => {
  const f = await fixture(t, { steps: [toolResponse("one"), answerResponse], webSearch: mockSearch });
  await f.session.start("v=0\r\noffer");
  f.send(input); f.send(delegation());
  await until(() => hasTrace(f.messages, "luna.response"));
  const requests = f.requests.filter((request) => request.path.endsWith("/responses"));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body.include, ["reasoning.encrypted_content"]);
  assert.ok(JSON.stringify(requests[1].body.input).includes("fixture-private-reasoning-state"));
  assert.ok(JSON.stringify(requests[1].body.input).includes("function_call_output"));
  assert.ok(!JSON.stringify(f.messages).includes("fixture-private-reasoning-state"));
  const metrics = lastMetrics(f.messages);
  assert.equal(metrics.lunaRequests, 2);
  assert.equal(metrics.lunaResponses, 2);
  assert.equal(metrics.lunaUsage.totalTokens, 85);
  assert.equal(metrics.lunaPendingRequests, 0);
  assert.equal(metrics.searchRequests, 1);
  assert.equal(metrics.searchSucceeded, 1);
  assert.ok(hasTrace(f.messages, "search.response"));
  const cited = f.messages.find((message) => message.type === "trace" && message.event.type === "search.citations");
  assert.ok(cited?.type === "trace");
  assert.deepEqual((cited.event.payload as JsonObject).citedIds, ["S1"]);
  assert.ok(!f.received.map((message) => message.content).join("").includes("[S1]"), "Do not speak source markers");
});

test("missing cached usage in one step stays incomplete after later cached usage arrives", async (t) => {
  const first = toolResponse("one");
  first.usage = { input_tokens: 20, output_tokens: 10, total_tokens: 30 };
  const f = await fixture(t, { steps: [first, answerResponse], webSearch: mockSearch });
  await f.session.start("v=0\r\noffer"); f.send(input); f.send(delegation());
  await until(() => hasTrace(f.messages, "luna.response"));
  assert.equal(lastMetrics(f.messages).lunaCachedUsageIncomplete, true);
  assert.equal(lastMetrics(f.messages).lunaUsage.cachedInputTokens, 0);
});

test("free search supports more than two calls and rejects duplicate tool IDs without repeating a search", async (t) => {
  let searches = 0;
  const webSearch: WebSearch = async (...args) => { searches++; return mockSearch(...args); };
  const f = await fixture(t, {
    steps: [toolResponse("one"), toolResponse("two"), toolResponse("three"), toolResponse("three")], webSearch,
  });

  test("a sourced preamble followed by another tool call can continue researching", async (t) => {
    const next = toolResponse("two");
    assert.ok(Array.isArray(next.output));
    next.output.unshift({ type: "message", content: [{ type: "output_text", text: "I will check another source. " }] });
    const f = await fixture(t, { steps: [toolResponse("one"), next, answerResponse], webSearch: mockSearch });
    await f.session.start("v=0\r\noffer"); f.send(input); f.send(delegation());
    await until(() => hasTrace(f.messages, "luna.response"));
    assert.equal(lastMetrics(f.messages).searchRequests, 2);
    assert.equal(lastMetrics(f.messages).lunaRequests, 3);
    assert.ok(!hasTrace(f.messages, "luna.failed"));
  });
  await f.session.start("v=0\r\noffer"); f.send(input); f.send(delegation());
  await until(() => hasTrace(f.messages, "luna.failed"));
  assert.equal(searches, 3);
  assert.equal(lastMetrics(f.messages).lunaRequests, 4);
});

test("toggle is snapshotted per delegation; search-disabled requests have no tools", async (t) => {
  const f = await fixture(t, { webSearch: mockSearch });
  await f.session.start("v=0\r\noffer");
  f.session.setWebSearch(false);
  f.send(input); f.send(delegation());
  await until(() => hasTrace(f.messages, "luna.response"));
  assert.equal(f.requests.find((request) => request.path.endsWith("/responses"))?.body.tools, undefined);
  assert.equal(lastMetrics(f.messages).searchRequests, 0);
  assert.equal(lastMetrics(f.messages).webSearchEnabled, false);
});

test("a search error is returned to the model explicitly and its estimated charge stays uncertain", async (t) => {
  const f = await fixture(t, {
    steps: [toolResponse("one"), answerResponse],
    webSearch: async (_query, _signal, dispatched) => {
      dispatched();
      throw new WebSearchError("Web IQ HTTP 429. Search failed.", true);
    },
  });
  await f.session.start("v=0\r\noffer"); f.send(input); f.send(delegation());
  await until(() => hasTrace(f.messages, "luna.response"));
  assert.ok(hasTrace(f.messages, "search.failed"));
  const next = f.requests.filter((entry) => entry.path.endsWith("/responses"))[1];
  assert.match(JSON.stringify(next.body.input), /Do not claim fresh verification/);
  assert.equal(lastMetrics(f.messages).searchUncertain, 1);
  assert.equal(lastMetrics(f.messages).searchFailed, 1);
});

test("tool arguments and tool names are validated before executing any search", async (t) => {
  let searches = 0;
  for (const invalid of [
    { type: "function_call", call_id: "one", name: "browse", arguments: '{"query":"x"}' },
    { type: "function_call", call_id: "one", name: "web_search", arguments: '{"query":"x","url":"http://localhost"}' },
  ]) {
    const f = await fixture(t, {
      steps: [{ status: "completed", output: [invalid] }],
      webSearch: async (...args) => { searches++; return mockSearch(...args); },
    });
    await f.session.start("v=0\r\noffer"); f.send(input); f.send(delegation());
    await until(() => hasTrace(f.messages, "luna.failed"));
  }
  assert.equal(searches, 0);
});

test("deadline covers search work; Stop prevents a late result from continuing the model loop", async (t) => {
  for (const stop of [false, true]) {
    const f = await fixture(t, {
      steps: [toolResponse("one"), answerResponse], delegationTimeoutMs: stop ? 5000 : 500,
      webSearch: async (_query, _signal, dispatched) => {
        dispatched();
        await new Promise((resolve) => setTimeout(resolve, 700));
        return { sources: [], instrumentationAvailable: false };
      },
    });
    await f.session.start("v=0\r\noffer"); f.send(input); f.send(delegation());
    await until(() => hasTrace(f.messages, "search.request"));
    if (stop) await f.session.stop();
    await until(() => hasTrace(f.messages, stop ? "luna.cancelled" : "luna.failed"));
    assert.equal(f.requests.filter((request) => request.path.endsWith("/responses")).length, 1);
    assert.ok(!hasTrace(f.messages, "luna.response"));
  }
});

test("client delegation round trip exposes actual requests, response, correlated appends and close usage", async (t) => {
  const f = await fixture(t);
  assert.equal(f.tokenCalls, 0);
  await f.session.start("v=0\r\noffer");
  assert.equal(f.session.currentPhase, "live");
  assert.ok(f.messages.some((message) => message.type === "answer" && message.sdp.includes("answer")));
  const sessionBody = f.requests[0].body.session;
  assert.ok(isObject(sessionBody));
  assert.deepEqual(sessionBody.delegation, { type: "client" });
  assert.match(String(sessionBody.instructions), /Speak English by default/);
  assert.match(String(sessionBody.instructions), /user's language/);
  const sentTransport = f.requests[0].body.transport;
  assert.ok(sentTransport && typeof sentTransport === "object" && "sdp" in sentTransport);
  assert.equal(sentTransport.sdp, "v=0\r\noffer");
  const sessionTrace = f.messages.find((message) => message.type === "trace" && message.event.type === "live.session.request");
  assert.ok(sessionTrace?.type === "trace");
  assert.match(JSON.stringify(sessionTrace.event.payload), /redacted: WebRTC SDP/);
  f.send(input);
  f.send(delegation());
  await until(() => hasTrace(f.messages, "session.commentary.appended"));
  const request = f.requests.find((entry) => entry.path.endsWith("/responses"));
  assert.ok(request);
  assert.equal(request.authorization, "Bearer test-token");
  assert.equal(request.body.model, "reasoning-test");
  assert.match(String(request.body.instructions), /Default to English/);
  assert.match(String(request.body.instructions), /user's language/);
  assert.equal(request.body.store, false);
  assert.equal(request.body.stream, true);
  assert.match(String(request.body.input), /six times seven/);
  assert.equal(f.received[0].delegation_id, "delegation_1");
  assert.equal(f.received[0].type, "session.commentary.append");
  assert.equal(f.received.map((event) => event.content).join(""), "The result is 42.");
  const ack = f.messages.find((message) => message.type === "trace" && message.event.type === "session.commentary.appended");
  assert.ok(ack?.type === "trace");
  assert.equal(ack.event.delegationId, "delegation_1");
  const requestTrace = f.messages.find((message) => message.type === "trace" && message.event.type === "luna.request");
  const responseTrace = f.messages.find((message) => message.type === "trace" && message.event.type === "luna.response");
  assert.ok(requestTrace?.type === "trace" && responseTrace?.type === "trace");
  assert.ok(typeof responseTrace.event.durationMs === "number");
  const elapsedRequest = Date.parse(responseTrace.event.time) - Date.parse(requestTrace.event.time);
  assert.ok(Math.abs(responseTrace.event.durationMs - elapsedRequest) < 100, "API latency must not include the 300ms transcript wait");
  assert.ok(hasTrace(f.messages, "luna.context.ready"));
  assert.ok(!JSON.stringify(f.messages).includes("test-token"));
  await f.session.stop();
  assert.equal(f.session.currentPhase, "idle");
  assert.ok(hasTrace(f.messages, "session.closed"));
  assert.ok(!hasTrace(f.messages, "live.transport.closed"));
});

test("session preparation acquires one token and reuses it for session creation and sideband", async (t) => {
  const f = await fixture(t);
  await f.session.prepareForSession();
  assert.equal(f.tokenCalls, 1);
  assert.ok(hasTrace(f.messages, "backend.auth.ready"));
  await f.session.start("v=0\r\noffer");
  assert.equal(f.tokenCalls, 1);
  assert.equal(f.requests.filter((request) => request.path.endsWith("/live/sessions")).length, 1);
  assert.ok(hasTrace(f.messages, "live.sideband.open"));
});

test("backend ticks configured cost and reconciles the same estimate to final Azure usage", async (t) => {
  const f = await fixture(t, { pricing: readPricing({ LIVE_USD_PER_MINUTE: "6", LIVE_MINIMUM_SECONDS: "0", LIVE_ROUNDING_SECONDS: "0.1" }) });
  await f.session.start("v=0\r\noffer");
  const initial = lastMetrics(f.messages).cost;
  assert.ok(initial);
  await until(() => (lastMetrics(f.messages).cost?.totalKnownUsd ?? 0) > initial.totalKnownUsd);
  assert.equal(lastMetrics(f.messages).cost?.provisional, true);
  await f.session.stop();
  assert.equal(lastMetrics(f.messages).cost?.live.knownUsd, 1.5);
  assert.equal(lastMetrics(f.messages).cost?.live.provisional, false);
});

test("Responses streaming sends a complete sentence before Luna finishes", async (t) => {
  const text = "The first sentence is here. The second sentence comes later.";
  const f = await fixture(t, {
    response: {
      id: "response_stream", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 12, output_tokens: 10, total_tokens: 22 },
    },
    streamDeltas: ["The first sentence is here. ", "The second sentence comes later."],
    streamDelayMs: 250,
  });
  await f.session.start("v=0\r\noffer");
  f.send(input);
  f.send(delegation());
  await until(() => f.received.some((event) =>
    event.type === "session.commentary.append" && event.content === "The first sentence is here. "));
  assert.ok(!hasTrace(f.messages, "luna.response"), "The final response must still be pending after the first sentence is delivered.");
  await until(() => hasTrace(f.messages, "luna.response"));
  await until(() => f.received.filter((event) => event.type === "session.commentary.append").length >= 2,
    "Both streamed sentences must reach the sideband peer.");
  const appends = f.received.filter((event) => event.type === "session.commentary.append");
  assert.equal(appends.map((event) => event.content).join(""), text);
  assert.ok(hasTrace(f.messages, "luna.first_text"));
  assert.ok(hasTrace(f.messages, "luna.first_append"));
  const firstText = f.messages.find((message) => message.type === "trace" && message.event.type === "luna.first_text");
  assert.ok(firstText?.type === "trace" && typeof firstText.event.durationMs === "number");
  assert.equal(lastMetrics(f.messages).lunaUsage.totalTokens, 22);
});

test("a failed stream marks already delivered commentary as partial, not complete", async (t) => {
  const f = await fixture(t, {
    response: {
      id: "response_failed_stream", status: "failed",
      output: [{ type: "message", content: [{ type: "output_text", text: "An incomplete sentence." }] }],
      usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
    },
    streamDeltas: ["An incomplete sentence. "],
    streamFailure: true,
  });
  await f.session.start("v=0\r\noffer");
  f.send(input);
  f.send(delegation());
  await until(() => hasTrace(f.messages, "luna.failed"));
  assert.ok(hasTrace(f.messages, "luna.first_append"));
  assert.ok(!hasTrace(f.messages, "luna.response"));
  assert.equal(lastMetrics(f.messages).lunaUsage.totalTokens, 17);
  assert.ok(lastMetrics(f.messages).lunaFailures === 1);
  await until(() => f.received.some((message) => String(message.content).includes("answer is incomplete")));
  assert.match(String(f.received.at(-1)?.content), /answer is incomplete/);
  const failure = f.messages.find((message) => message.type === "trace" && message.event.type === "luna.failed");
  assert.ok(failure?.type === "trace");
  assert.equal((failure.event.payload as JsonObject).partialTextSent, true);
});

test("requested normal observer close ends locally with a warning, not fabricated final usage", async (t) => {
  const f = await fixture(t, { closeWithoutAck: { code: 1000, reason: "observer_output_closed" } });
  await f.session.start("v=0\r\noffer");
  await f.session.stop();
  assert.equal(f.session.currentPhase, "idle");
  const warning = f.messages.find((message) => message.type === "trace" && message.event.type === "live.transport.closed");
  assert.ok(warning?.type === "trace");
  assert.equal(warning.event.severity, "warning");
  assert.equal(warning.event.category, "session");
  const metrics = f.messages.filter((message) => message.type === "metrics").at(-1);
  assert.ok(metrics?.type === "metrics");
  assert.equal(metrics.metrics.closeStatus, "unconfirmed");
  assert.equal(metrics.metrics.liveSeconds, undefined);
  assert.equal(metrics.metrics.liveUsageFinal, false);
});

test("Live usage snapshots replace each other and only reported closing usage is final", async (t) => {
  const f = await fixture(t);
  await f.session.start("v=0\r\noffer");
  f.send({ type: "session.usage.updated", usage: { seconds: 7 } });
  await until(() => lastMetrics(f.messages).liveSeconds === 7);
  const first = lastMetrics(f.messages);
  assert.equal(first.liveUsageFinal, false);
  f.send({ type: "session.usage.updated", usage: { seconds: 12 } });
  await until(() => lastMetrics(f.messages).liveSeconds === 12);
  assert.equal(first.liveSeconds, 7);
  await f.session.stop();
  assert.equal(lastMetrics(f.messages).liveSeconds, 15);
  assert.equal(lastMetrics(f.messages).liveUsageFinal, true);
  assert.equal(lastMetrics(f.messages).closeStatus, "confirmed");
});

test("unexpected normal observer closure remains an error while the session is active", async (t) => {
  const f = await fixture(t);
  await f.session.start("v=0\r\noffer");
  f.closeSideband(1000, "observer_output_closed");
  await until(() => f.session.currentPhase === "error");
  const event = f.messages.find((message) => message.type === "trace" && message.event.type === "live.transport.closed");
  assert.ok(event?.type === "trace");
  assert.equal(event.event.severity, "error");
  assert.equal(lastMetrics(f.messages).closeStatus, "unconfirmed");
});

test("confirmed closure without final seconds preserves provisional usage and a warning", async (t) => {
  const f = await fixture(t);
  await f.session.start("v=0\r\noffer");
  f.send({ type: "session.usage.updated", usage: { seconds: 12 } });
  await until(() => lastMetrics(f.messages).liveSeconds === 12);
  f.send({ type: "session.closed", reason: "close_requested" });
  await until(() => f.session.currentPhase === "idle");
  assert.equal(lastMetrics(f.messages).closeStatus, "confirmed");
  assert.equal(lastMetrics(f.messages).liveSeconds, 12);
  assert.equal(lastMetrics(f.messages).liveUsageFinal, false);
  assert.ok(hasTrace(f.messages, "live.usage.missing"));
});

test("Luna tokens accumulate per response without double counting cached or reasoning subsets", async (t) => {
  const f = await fixture(t, { response: {
    id: "response_with_usage", status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "42" }] }],
    usage: {
      input_tokens: 12, output_tokens: 7, total_tokens: 19,
      input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 4 },
    },
  } });
  await f.session.start("v=0\r\noffer");
  f.send(input);
  f.send(delegation("first"));
  await until(() => hasTrace(f.messages, "session.commentary.appended"));
  const first = lastMetrics(f.messages);
  assert.equal(first.lunaRequests, 1);
  assert.equal(first.lunaUsage.totalTokens, 19);
  f.send(delegation("second"));
  await until(() => f.received.filter((event) => event.type === "session.commentary.append").length === 2);
  const totals = lastMetrics(f.messages);
  assert.deepEqual(totals.lunaUsage, {
    inputTokens: 24, outputTokens: 14, totalTokens: 38, cachedInputTokens: 6, reasoningOutputTokens: 8,
  });
  assert.equal(totals.lunaRequests, 2);
  assert.equal(totals.lunaResponses, 2);
  assert.equal(totals.lunaUsageReports, 2);
  assert.equal(totals.lunaUsageIncomplete, false);
  assert.equal(first.lunaUsage.totalTokens, 19);
});

test("missing and invalid token fields stay unknown instead of becoming zero", async (t) => {
  const f = await fixture(t, { response: {
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "42" }] }],
    usage: { input_tokens: -1, output_tokens: "7", total_tokens: 19, output_tokens_details: { reasoning_tokens: -4 } },
  } });
  await f.session.start("v=0\r\noffer");
  f.send(input);
  f.send(delegation());
  await until(() => hasTrace(f.messages, "session.commentary.appended"));
  assert.deepEqual(lastMetrics(f.messages).lunaUsage, { totalTokens: 19 });
  assert.equal(lastMetrics(f.messages).lunaUsageReports, 1);
  assert.equal(lastMetrics(f.messages).lunaUsageIncomplete, true);
  assert.equal(lastMetrics(f.messages).lunaFailures, 0);
  assert.ok(hasTrace(f.messages, "luna.usage.incomplete"));
});

test("a response without usage does not erase known totals or imply complete accounting", async (t) => {
  const response: JsonObject = {
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "42" }] }],
    usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
  };
  const f = await fixture(t, { response });
  await f.session.start("v=0\r\noffer");
  f.send(input);
  f.send(delegation("known"));
  await until(() => hasTrace(f.messages, "session.commentary.appended"));
  const first = lastMetrics(f.messages);
  delete response.usage;
  f.send(delegation("unknown"));
  await until(() => f.received.filter((event) => event.type === "session.commentary.append").length === 2);
  const totals = lastMetrics(f.messages);
  assert.equal(totals.lunaResponses, 2);
  assert.equal(totals.lunaUsageReports, 1);
  assert.equal(totals.lunaUsageIncomplete, true);
  assert.deepEqual(totals.lunaUsage, { inputTokens: 12, outputTokens: 7, totalTokens: 19 });
  assert.equal(first.lunaUsageIncomplete, false);
});

test("duplicate delegations run once and separate delegations are serialized", async (t) => {
  const f = await fixture(t, { delayed: true });
  await f.session.start("v=0\r\noffer");
  f.send(input);
  f.send(delegation("first"));
  f.send(delegation("first"));
  f.send(delegation("second"));
  await until(() => f.received.filter((event) => event.type === "session.commentary.append").length === 2);
  assert.equal(f.requests.filter((request) => request.path.endsWith("/responses")).length, 2);
  assert.equal(f.maxActiveCalls, 1);
  assert.ok(hasTrace(f.messages, "delegation.duplicate"));
});

test("Azure HTTP failures are visible and never become a fabricated successful answer", async (t) => {
  const f = await fixture(t, { status: 403 });
  await f.session.start("v=0\r\noffer");
  f.send(input);
  f.send(delegation());
  await until(() => hasTrace(f.messages, "luna.failed"));
  assert.ok(!hasTrace(f.messages, "luna.response"));
  assert.equal(lastMetrics(f.messages).lunaRequests, 1);
  assert.equal(lastMetrics(f.messages).lunaResponses, 0);
  assert.equal(lastMetrics(f.messages).lunaFailures, 1);
  assert.deepEqual(lastMetrics(f.messages).lunaUsage, {});
  await until(() => f.received.length > 0);
  assert.match(String(f.received[0].content), /request failed/);
});

test("incomplete Responses output retains reported usage but is not injected as a successful result", async (t) => {
  const f = await fixture(t, { response: {
    status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [],
    usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
  } });
  await f.session.start("v=0\r\noffer");
  f.send(input);
  f.send(delegation());
  await until(() => hasTrace(f.messages, "luna.failed"));
  await until(() => f.received.length > 0);
  assert.match(String(f.received[0].content), /request failed/);
  assert.equal(lastMetrics(f.messages).lunaResponses, 1);
  assert.equal(lastMetrics(f.messages).lunaFailures, 1);
  assert.deepEqual(lastMetrics(f.messages).lunaUsage, { inputTokens: 20, outputTokens: 4, totalTokens: 24 });
  assert.equal(lastMetrics(f.messages).lunaUsageIncomplete, false);
});

test("stop aborts pending Luna work and never injects its late result", async (t) => {
  const f = await fixture(t, { delayed: true });
  await f.session.start("v=0\r\noffer");
  f.send(input);
  f.send(delegation());
  await until(() => f.requests.some((request) => request.path.endsWith("/responses")));
  await f.session.stop();
  await until(() => hasTrace(f.messages, "luna.cancelled"));
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(f.received.filter((event) => event.type === "session.commentary.append").length, 0);
  assert.equal(f.received.filter((event) => event.type === "session.thinking.append").length, 0);
  assert.equal(lastMetrics(f.messages).lunaRequests, 1);
  assert.equal(lastMetrics(f.messages).lunaResponses, 0);
  assert.equal(lastMetrics(f.messages).lunaCancelled, 1);
  assert.equal(lastMetrics(f.messages).lunaFailures, 0);
});

test("missing transcript does not trigger a guessed Luna request", async (t) => {
  const f = await fixture(t);
  await f.session.start("v=0\r\noffer");
  f.send(delegation());
  await until(() => hasTrace(f.messages, "luna.failed"));
  assert.equal(f.requests.length, 1);
  assert.equal(lastMetrics(f.messages).lunaRequests, 0);
  assert.equal(lastMetrics(f.messages).lunaFailures, 1);
});

test("missing close acknowledgment reports unconfirmed final usage", async (t) => {
  const f = await fixture(t, { noCloseAck: true });
  await f.session.start("v=0\r\noffer");
  await f.session.stop();
  assert.equal(f.session.currentPhase, "error");
  assert.ok(hasTrace(f.messages, "session.close.timeout"));
});

test("stop during session creation cancels startup and reports uncertain remote closure", async (t) => {
  const f = await fixture(t, { delayedSession: true });
  const starting = f.session.start("v=0\r\noffer");
  await until(() => f.requests.length === 1);
  await f.session.stop();
  await starting;
  assert.equal(f.session.currentPhase, "error");
  assert.ok(hasTrace(f.messages, "session.start.cancelled"));
  assert.ok(!f.messages.some((message) => message.type === "answer"));
});

test("long Unicode Luna output is returned as bounded, correlated context chunks", async (t) => {
  const text = "Result with Unicode: \u00e4\u00f6\u00fc \ud83d\ude00. ".repeat(100);
  const f = await fixture(t, { response: {
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  } });
  await f.session.start("v=0\r\noffer");
  f.send(input);
  f.send(delegation());
  await until(() => f.received.filter((event) => event.type === "session.commentary.append")
    .map((event) => event.content).join("") === text);
  const appends = f.received.filter((event) => event.type === "session.commentary.append");
  assert.ok(appends.length > 1);
  assert.ok(appends.every((event) => event.delegation_id === "delegation_1" && Buffer.byteLength(String(event.content)) <= 480));
});

test("malformed Azure session response surfaces an error without sending a browser answer", async (t) => {
  const f = await fixture(t, { invalidSession: true });
  await f.session.start("v=0\r\noffer");
  assert.equal(f.session.currentPhase, "error");
  assert.ok(hasTrace(f.messages, "session.start.failed"));
  assert.ok(!f.messages.some((message) => message.type === "answer"));
});

test("local backend supplies config, restricts origins, validates commands and shuts down sessions", async (t) => {
  const f = await fixture(t);
  const app = createApp(f.config, { getToken: f.getToken });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  t.after(() => app.close());
  const response = await fetch(`${url}/api/config`);
  assert.deepEqual(await response.json(), f.config);
  assert.equal(f.tokenCalls, 0);
  const forbidden = new WebSocket(url.replace("http", "ws") + "/api/events", { origin: "https://untrusted.example" });
  const [error] = await once(forbidden, "error");
  assert.match(String(error), /403/);
  const browser = new WebSocket(url.replace("http", "ws") + "/api/events", { origin: "http://127.0.0.1:5173" });
  const messages: ServerMessage[] = [];
  browser.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as ServerMessage));
  await once(browser, "open");
  browser.send('{"type":"start","sdp":"invalid"}');
  await until(() => hasTrace(messages, "browser.command.error"));
  assert.equal(f.tokenCalls, 0);
  browser.send('{"type":"prepare"}');
  await until(() => hasTrace(messages, "backend.auth.ready"));
  assert.equal(f.tokenCalls, 1);
  browser.send(JSON.stringify({ type: "start", sdp: "v=0\r\noffer" }));
  await until(() => messages.some((message) => message.type === "answer"));
  assert.equal(f.tokenCalls, 1, "Session creation and sideband should reuse the prepared token.");
  f.send(input);
  f.send(delegation("via_backend"));
  await until(() => hasTrace(messages, "luna.response"));
  browser.send('{"type":"stop"}');
  await until(() => messages.some((message) => message.type === "state" && message.phase === "idle"));
  browser.close();
});
