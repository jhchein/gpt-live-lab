import assert from "node:assert/strict";
import { test } from "node:test";
import { createAccessTokenProvider } from "./token.ts";

test("access-token provider shares concurrent acquisition and reuses a valid token", async () => {
  let calls = 0;
  const provider = createAccessTokenProvider(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { token: "fixture-token", expiresOnTimestamp: Date.now() + 120_000 };
  });
  assert.deepEqual(await Promise.all([provider(), provider(), provider()]), [
    "fixture-token", "fixture-token", "fixture-token",
  ]);
  assert.equal(await provider(), "fixture-token");
  assert.equal(calls, 1);
});

test("access-token provider refreshes near expiry and retries a failed acquisition", async () => {
  let calls = 0;
  const provider = createAccessTokenProvider(async () => {
    calls++;
    if (calls === 1) return { token: "near-expiry", expiresOnTimestamp: Date.now() + 10 };
    if (calls === 2) throw new Error("fixture auth failure");
    return { token: "renewed", expiresOnTimestamp: Date.now() + 120_000 };
  });
  assert.equal(await provider(), "near-expiry");
  await assert.rejects(provider(), /fixture auth failure/);
  assert.equal(await provider(), "renewed");
  assert.equal(await provider(), "renewed");
  assert.equal(calls, 3);
});
