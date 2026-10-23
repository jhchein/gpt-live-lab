import { test } from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "./environment.ts";

const configured = {
  AZURE_ENDPOINT: "https://example-resource.services.ai.azure.com",
  AZURE_LIVE_DEPLOYMENT: "live-test",
  AZURE_REASONING_DEPLOYMENT: "reasoning-test",
};

test("public demo requires explicit local Azure configuration with no personal defaults", () => {
  for (const name of Object.keys(configured)) {
    const env = { ...configured, [name]: " " };
    assert.throws(() => readConfig(env), new RegExp(`${name} is required`));
  }
  assert.throws(() => readConfig({}), /Copy .env.example to .env/);
});

test("configuration normalizes the resource origin and preserves explicit deployment names", () => {
  assert.deepEqual(readConfig({ ...configured, AZURE_ENDPOINT: ` ${configured.AZURE_ENDPOINT}/ ` }), {
    endpoint: configured.AZURE_ENDPOINT, liveDeployment: "live-test", reasoningDeployment: "reasoning-test",
  });
});

test("configuration rejects invalid endpoints without echoing credentials", () => {
  for (const endpoint of [
    "not-a-url", "http://example-resource.test", "https://example-resource.test/openai",
    "https://example-resource.test/?query=value", "https://example-resource.test/#fragment",
    "https://fixture-user:fixture-password@example-resource.test",
  ]) {
    assert.throws(() => readConfig({ ...configured, AZURE_ENDPOINT: endpoint }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /AZURE_ENDPOINT must be/);
      assert.ok(!error.message.includes("fixture-password"));
      return true;
    });
  }
});
