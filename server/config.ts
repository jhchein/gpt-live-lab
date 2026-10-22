import type { PublicConfig } from "../shared/protocol.ts";

export function readConfig(env: NodeJS.ProcessEnv): PublicConfig {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required. Copy .env.example to .env and set your Azure resource and deployment names.`);
    return value;
  };
  const value = required("AZURE_ENDPOINT");
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("AZURE_ENDPOINT must be an HTTPS resource origin without a path, query, fragment or credentials.");
  }
  if (endpoint.protocol !== "https:" || endpoint.pathname !== "/" || endpoint.search ||
      endpoint.hash || endpoint.username || endpoint.password) {
    throw new Error("AZURE_ENDPOINT must be an HTTPS resource origin without a path, query, fragment or credentials.");
  }
  return {
    endpoint: endpoint.origin,
    liveDeployment: required("AZURE_LIVE_DEPLOYMENT"),
    reasoningDeployment: required("AZURE_REASONING_DEPLOYMENT"),
  };
}
