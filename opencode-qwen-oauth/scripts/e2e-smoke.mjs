import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const modulePath = resolve(process.cwd(), "dist", "src", "index.js");
const matrixPath = resolve(process.cwd(), "..", ".omc", "contracts", "compatibility-matrix.json");

await stat(modulePath);
await stat(matrixPath);

const plugin = await import(pathToFileURL(modulePath).href);
if (!plugin.QwenOauthPlugin) {
  throw new Error("Missing QwenOauthPlugin export");
}

const hooks = await plugin.QwenOauthPlugin({ client: { app: { log: async () => undefined } } });
if (typeof hooks.event !== "function" || typeof hooks["tool.execute.before"] !== "function") {
  throw new Error("Missing expected OpenCode hook functions");
}

console.log("e2e-smoke-ok");
