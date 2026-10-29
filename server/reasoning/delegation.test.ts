import { test } from "node:test";
import assert from "node:assert/strict";
import { DelegationExecutor, readReasoningStyle, type DelegationDependencies, type DelegationMetrics } from "./delegation.ts";
import { isObject, type JsonObject, type TranscriptFragment } from "../../shared/protocol.ts";

const transcript: TranscriptFragment[] = [{ speaker: "user", text: "Find current facts.", startMs: 0, endMs: 100 }];
function fixture(responses: JsonObject[], options: Partial<DelegationDependencies> = {}) {
  const requests: JsonObject[] = [];
  const spoken: string[] = [];
  const notices: string[] = [];
  const traces: { type: string; payload: unknown }[] = [];
  let metrics: DelegationMetrics | undefined;
  const executor = new DelegationExecutor({
    config: { endpoint: "https://example-resource.test", reasoningDeployment: "reasoning-test" },
    getToken: async () => "fixture-token", transcript: () => transcript,
    canDeliver: () => true,
    report: (value) => { metrics = value; },
    trace: (_source, _category, type, _label, payload) => traces.push({ type, payload }),
    commentary: (_id, text) => { spoken.push(text); return Boolean(text.trim()); },
    context: (_id, text) => { notices.push(text); },
    request: async (_url, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      assert.ok(isObject(body));
      requests.push(body);
      const response = responses.shift();
      assert.ok(response, "Unexpected extra model step");
      const output = Array.isArray(response.output) ? response.output : [];
      const text = output.filter(isObject).flatMap((item) => Array.isArray(item.content)
        ? item.content.filter(isObject).flatMap((part) => typeof part.text === "string" ? [part.text] : []) : []).join("");
      const frames = [
        ...(text ? [{ type: "response.output_text.delta", delta: text }] : []),
        { type: response.status === "completed" ? "response.completed" : "response.failed", response },
      ];
      return new Response(frames.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
    ...options,
  });
  return { executor, requests, spoken, notices, traces, get metrics() { return metrics; } };
}
const answer = {
  status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Verified answer [S1]. " }] }],
  usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 } },
};
const tool = {
  status: "completed", output: [
    { type: "reasoning", encrypted_content: "fixture-private-state" },
    { type: "function_call", call_id: "search-one", name: "web_search", arguments: '{"query":"current facts"}' },
  ],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 } },
};

test("delegation execution performs tool continuation and accounts usage without a Live connection", async () => {
  const f = fixture([tool, answer], {
    webSearch: async (_query, signal, sent) => {
      signal.throwIfAborted(); sent(1);
      return { sources: [{ title: "Evidence", url: "https://example.com", content: "A fact" }], instrumentationAvailable: false };
    },
  });
  await f.executor.run("d", new AbortController().signal, true);
  assert.equal(f.requests.length, 2);
  assert.ok(JSON.stringify(f.requests[1].input).includes("fixture-private-state"));
  assert.equal(f.metrics?.lunaUsage.totalTokens, 45);
  assert.equal(f.metrics?.searchRequests, 1);
  assert.equal(f.metrics?.lunaPendingRequests, 0);
  assert.equal(f.spoken.join(""), "Verified answer [S1]. ");
  assert.ok(f.traces.some((trace) => trace.type === "search.citations"));
});

test("board tools reach the model but never the trace, and web search stays off when disabled", async () => {
  const boardCall = {
    status: "completed", output: [
      { type: "function_call", call_id: "board-one", name: "list_tasks", arguments: '{"filter":"SECRET-QUERY"}' },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 } },
  };
  const calls: { name: string; args: string }[] = [];
  const f = fixture([boardCall, answer], {
    mcp: {
      tools: async () => [{ type: "function", name: "list_tasks", description: "List", parameters: { type: "object", properties: {} }, strict: false }],
      call: async (name, args) => { calls.push({ name, args }); return { text: "SECRET-TASK-TITLE", isError: false, truncated: false }; },
    },
  });
  await f.executor.run("d", new AbortController().signal, false);
  assert.deepEqual(calls, [{ name: "list_tasks", args: '{"filter":"SECRET-QUERY"}' }]);
  assert.deepEqual((f.requests[0].tools as { name: string }[]).map((entry) => entry.name), ["list_tasks"]);
  assert.ok(JSON.stringify(f.requests[1].input).includes("SECRET-TASK-TITLE"));
  const traced = JSON.stringify(f.traces);
  assert.ok(!traced.includes("SECRET-TASK-TITLE") && !traced.includes("SECRET-QUERY"));
  assert.ok(f.traces.some((trace) => trace.type === "mcp.response"));
  assert.equal(f.metrics?.searchRequests, 0);
});

test("a model that calls web_search while only board tools are enabled is rejected", async () => {
  const f = fixture([tool], {
    mcp: {
      tools: async () => [{ type: "function", name: "list_tasks", description: "List", parameters: { type: "object", properties: {} }, strict: false }],
      call: async () => { throw new Error("must not be called"); },
    },
  });
  await f.executor.run("d", new AbortController().signal, false);
  assert.equal(f.metrics?.lunaFailures, 1);
});

test("an unreachable board does not block an answer", async () => {
  const f = fixture([answer], { mcp: { tools: async () => { throw new Error("down"); }, call: async () => { throw new Error("unused"); } } });
  await f.executor.run("d", new AbortController().signal, false);
  assert.ok(f.traces.some((trace) => trace.type === "mcp.unavailable"));
  assert.equal(f.metrics?.lunaFailures, 0);
  assert.equal(f.requests[0].tools, undefined);
});

test("reasoning style is validated, and effort and word limit reach the request", async () => {
  assert.deepEqual(readReasoningStyle({}), { effort: undefined, maxWords: 120 });
  assert.deepEqual(readReasoningStyle({ REASONING_EFFORT: "High", REASONING_MAX_WORDS: "250" }), { effort: "high", maxWords: 250 });
  assert.throws(() => readReasoningStyle({ REASONING_EFFORT: "max" }), /REASONING_EFFORT/);
  assert.throws(() => readReasoningStyle({ REASONING_MAX_WORDS: "5" }), /REASONING_MAX_WORDS/);
  const f = fixture([answer], { reasoningStyle: { effort: "low", maxWords: 250 } });
  await f.executor.run("d", new AbortController().signal, false);
  assert.deepEqual(f.requests[0].reasoning, { effort: "low" });
  assert.ok(String(f.requests[0].instructions).includes("at most 250 words"));
});

test("partial response failure emits an incomplete notice, not a completed delegation", async () => {
  const f = fixture([{ ...answer, status: "failed" }]);
  await f.executor.run("d", new AbortController().signal, false);
  assert.ok(f.spoken.length > 0);
  assert.equal(f.metrics?.lunaFailures, 1);
  assert.ok(f.notices[0].includes("incomplete"));
  assert.ok(!f.traces.some((trace) => trace.type === "luna.response"));
});

test("cancellation and deadline prevent model calls while preserving their distinct outcomes", async () => {
  const abort = new AbortController();
  abort.abort();
  const cancelled = fixture([]);
  await cancelled.executor.run("d", abort.signal, false);
  assert.equal(cancelled.metrics?.lunaCancelled, 1);
  assert.equal(cancelled.requests.length, 0);
  const timedOut = fixture([], { delegationTimeoutMs: 1 });
  await timedOut.executor.run("d", new AbortController().signal, false);
  assert.equal(timedOut.metrics?.lunaFailures, 1);
  assert.equal(timedOut.requests.length, 0);
});
