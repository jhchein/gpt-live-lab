import { AzureCliCredential } from "@azure/identity";
import { createApp } from "./app.ts";
import { readConfig } from "./config/environment.ts";
import { createAccessTokenProvider } from "./token.ts";
import { createWebSearch } from "./search/web-search.ts";
import { readPricing } from "./config/pricing.ts";
import { readOperatorContext } from "./operator-context.ts";

const config = readConfig(process.env);
const webKey = process.env.WEB_IQ_API_KEY?.trim();
config.webSearchAvailable = Boolean(webKey);
config.pricing = readPricing(process.env);
const credential = new AzureCliCredential({
  tenantId: process.env.AZURE_TENANT_ID?.trim() || undefined,
});
const getToken = createAccessTokenProvider(async () => {
  const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
  if (!token?.token) throw new Error("Azure CLI returned no access token. Run az login for the configured tenant.");
  return token;
});
const app = createApp(config, {
  getToken,
  webSearch: webKey ? createWebSearch(webKey) : undefined,
  operatorContext: readOperatorContext(process.env),
});
app.server.on("error", (error) => {
  console.error("Backend failed:", error.message);
  process.exitCode = 1;
});
app.server.listen(3001, "127.0.0.1", () => {
  console.log("GPT-Live backend: http://127.0.0.1:3001");
  console.log("Using deployment names from local environment configuration.");
  console.log("Azure credentials are requested only when a session starts.");
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().catch((error: unknown) => {
      console.error("Shutdown failed:", error);
      process.exitCode = 1;
    });
  });
}
