import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebSearch, searchQuery, WebSearchError } from "./web-search.ts";
import { citedSourceIds, sourceUrl } from "../shared/search.ts";
import { scrub } from "./protocol.ts";

test("search arguments reject extra fields, empty text, and oversized queries", () => {
  assert.equal(searchQuery('{"query":" current news "}'), "current news");
  for (const value of ['{}', 'null', '{"query":""}', '{"query":"x","url":"https://example.com"}',
    JSON.stringify({ query: "x".repeat(1001) })]) assert.throws(() => searchQuery(value));
});

test("Web IQ requests use fixed HTTPS, a server-only header and light passages", async () => {
  let dispatches = 0;
  const search = createWebSearch("fixture-private-webkey", async (url, options) => {
    assert.equal(url, "https://api.microsoft.ai/v3/search/web");
    assert.equal(new Headers(options?.headers).get("x-apikey"), "fixture-private-webkey");
    assert.equal(options?.redirect, "error");
    assert.deepEqual(JSON.parse(String(options?.body)), {
      query: "current facts", maxResults: 5, maxLength: 1500, contentFormat: "passage", safeSearch: "strict",
    });
    return Response.json({ webResults: [
      { title: "A source", url: "https://example.com/article", content: "x".repeat(2000) },
      { title: "Unsafe link", url: "javascript:alert(1)", content: "bad" },
    ] });
  });
  const result = await search("current facts", new AbortController().signal, () => dispatches++);
  assert.equal(dispatches, 1);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].content.length, 1500);
});

test("Web IQ errors never reflect response bodies or keys; billing stays uncertain", async () => {
  const search = createWebSearch("fixture-private-webkey", async () =>
    new Response("x-apikey: fixture-private-webkey", { status: 429 }));
  await assert.rejects(search("query", new AbortController().signal, () => {}), (error: unknown) => {
    assert.ok(error instanceof WebSearchError);
    assert.equal(error.dispatched, true);
    assert.equal(error.httpStatus, 429);
    assert.match(error.message, /HTTP 429/);
    assert.ok(!error.message.includes("fixture-private-webkey"));
    return true;
  });
  assert.ok(!JSON.stringify(scrub({ headers: { "x-apikey": "fixture-private-webkey" } })).includes("fixture-private-webkey"));
});

test("100 queries per rolling minute are shared across search calls; extra calls are not sent", async () => {
  let count = 0;
  const search = createWebSearch("fixture-key", async () => { count++; return Response.json({}); });
  const signal = new AbortController().signal;
  for (let i = 0; i < 100; i++) await search("query", signal, () => {});
  await assert.rejects(search("query", signal, () => {}), (error: unknown) =>
    error instanceof WebSearchError && !error.dispatched);
  assert.equal(count, 100);
});

test("cancel before dispatch does not send a request; oversized/malformed responses fail visibly", async () => {
  let sent = 0;
  const abort = new AbortController();
  abort.abort();
  const search = createWebSearch("fixture-key", async () => { sent++; return Response.json({}); });
  await assert.rejects(search("query", abort.signal, () => {}));
  assert.equal(sent, 0);
  for (const body of ['{"webResults":{}}', "not JSON", "x".repeat(128001)]) {
    const invalid = createWebSearch("fixture-key", async () => new Response(body));
    await assert.rejects(invalid("query", new AbortController().signal, () => {}), WebSearchError);
  }
});

test("only returned source IDs and http links without credentials are recognized", () => {
  assert.equal(sourceUrl("javascript:alert(1)"), undefined);
  assert.equal(sourceUrl("https://user:password@example.com"), undefined);
  assert.deepEqual(citedSourceIds("Answer [S1] [S999] [S1]", [
    { id: "S1", url: "https://example.com", title: "A", content: "text" },
  ]), ["S1"]);
});

test("network errors redact arbitrary credential echoes and instrumentation is explicit", async () => {
  const failed = createWebSearch("fixture-private-webkey", async () => { throw new Error("fixture-private-webkey"); });
  await assert.rejects(failed("query", new AbortController().signal, () => {}), (error: unknown) => {
    assert.ok(error instanceof WebSearchError);
    assert.ok(!error.message.includes("fixture-private-webkey"));
    return true;
  });
  const instrumented = createWebSearch("fixture-key", async () =>
    Response.json({ instrumentationCitationBase: "https://api.microsoft.ai/api/ping/llmLog", webResults: [] }));
  assert.equal((await instrumented("query", new AbortController().signal, () => {})).instrumentationAvailable, true);
});

test("503 retries exactly once after Retry-After and counts both dispatched attempts", async () => {
  let requests = 0;
  const waits: number[] = [];
  const attempts: (number | undefined)[] = [];
  const retries: unknown[] = [];
  const search = createWebSearch("fixture-key", async () => ++requests === 1
    ? new Response("unavailable", { status: 503, headers: { "Retry-After": "2" } })
    : Response.json({ webResults: [] }), {
    wait: async (ms) => { waits.push(ms); }, random: () => 0,
  });
  await search("query", new AbortController().signal, (attempt) => attempts.push(attempt), {
    onRetry: (info) => retries.push(info),
  });
  assert.equal(requests, 2);
  assert.deepEqual(waits, [2000]);
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(retries.length, 1);
});

test("HTTP-date Retry-After is respected, including dates already in the past", async () => {
  const now = Date.parse("2026-10-22T18:00:00Z");
  for (const [header, expected] of [["Thu, 22 Oct 2026 18:00:03 GMT", 3000], ["Thu, 22 Oct 2026 17:59:59 GMT", 0]] as const) {
    let requests = 0;
    const waits: number[] = [];
    const search = createWebSearch("fixture-key", async () => ++requests === 1
      ? new Response(null, { status: 503, headers: { "Retry-After": header } }) : Response.json({}), {
      now: () => now, wait: async (ms) => { waits.push(ms); },
    });
    await search("query", new AbortController().signal, () => {});
    assert.equal(requests, 2);
    assert.deepEqual(waits, [expected]);
  }
});

test("absent or invalid Retry-After uses short jittered fallback, never an unbounded retry loop", async () => {
  for (const header of [undefined, "garbage", "-1", "1.5"]) {
    let requests = 0;
    const waits: number[] = [];
    const search = createWebSearch("fixture-key", async () => {
      requests++;
      return new Response("fixture-secret-echo", { status: 503, headers: header === undefined ? {} : { "Retry-After": header } });
    }, { wait: async (ms) => { waits.push(ms); }, random: () => 0.5 });
    await assert.rejects(search("query", new AbortController().signal, () => {}), (error: unknown) => {
      assert.ok(error instanceof WebSearchError);
      assert.match(error.message, /503/);
      assert.ok(!error.message.includes("fixture-secret-echo"));
      return true;
    });
    assert.equal(requests, 2);
    assert.deepEqual(waits, [1250]);
  }
});

test("a Retry-After beyond the delegation deadline sends no second attempt", async () => {
  let requests = 0;
  let waits = 0;
  const search = createWebSearch("fixture-key", async () => {
    requests++;
    return new Response(null, { status: 503, headers: { "Retry-After": "60" } });
  }, { now: () => 1000, wait: async () => { waits++; } });
  await assert.rejects(search("query", new AbortController().signal, () => {}, { deadlineAt: 5000 }), WebSearchError);
  assert.equal(requests, 1);
  assert.equal(waits, 0);
});

test("Stop during retry waiting sends no second attempt; non-503 errors do not retry", async () => {
  const abort = new AbortController();
  let requests = 0;
  const search = createWebSearch("fixture-key", async () => {
    requests++; return new Response(null, { status: 503 });
  }, { wait: async (_ms, signal) => { abort.abort(); signal.throwIfAborted(); } });
  await assert.rejects(search("query", abort.signal, () => {}), WebSearchError);
  assert.equal(requests, 1);
  for (const status of [400, 401, 403, 429, 500, 502, 504]) {
    requests = 0;
    const once = createWebSearch("fixture-key", async () => { requests++; return new Response(null, { status }); });
    await assert.rejects(once("query", new AbortController().signal, () => {}), WebSearchError);
    assert.equal(requests, 1);
  }
});

test("retry uses a second rate-limit slot and an oversized valid Retry-After is never shortened", async () => {
  let calls = 0;
  const limited = createWebSearch("fixture-key", async () => {
    calls++;
    return calls === 100 ? new Response(null, { status: 503, headers: { "Retry-After": "0" } }) : Response.json({});
  }, { wait: async () => {} });
  for (let i = 0; i < 99; i++) await limited("query", new AbortController().signal, () => {});
  await assert.rejects(limited("query", new AbortController().signal, () => {}), /100 queries per minute/);
  assert.equal(calls, 100);
  let waits = 0;
  const hugeDelay = createWebSearch("fixture-key", async () =>
    new Response(null, { status: 503, headers: { "Retry-After": "9".repeat(400) } }),
  { wait: async () => { waits++; } });
  await assert.rejects(hugeDelay("query", new AbortController().signal, () => {}), /remaining delegation budget/);
  assert.equal(waits, 0);
});
