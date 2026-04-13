import { describe, expect, it } from "vitest";
import QwenOauthPlugin from "../src/index.js";
import { getCounter, resetCounters } from "../src/telemetry.js";

describe("observability counters", () => {
  it("emits breaker and retry counters for retryable responses", async () => {
    resetCounters();
    process.env.QWEN_ALLOW_ENV_CREDENTIAL_BRIDGE = "1";
    process.env.QWEN_NATIVE_TOKEN_STORE_JSON = JSON.stringify({
      tokens: [
        {
          accessToken: "token",
          refreshToken: "refresh",
          expiresAt: Date.now() + 120_000,
          accountId: "acc"
        }
      ]
    });

    const hooks = await QwenOauthPlugin({
      client: { app: { log: async () => undefined } }
    });

    const input = {
      tool: "fetch",
      args: {
        url: "https://portal.qwen.ai/v1/chat/completions",
        method: "GET",
        headers: {}
      }
    };
    const output = {
      args: {
        status: 429,
        retryMeta: {
          retryClass: "A",
          maxAttempts: 2,
          serviceKey: "portal.qwen.ai"
        }
      }
    };

    await hooks["tool.execute.after"]?.(input, output);

    expect(getCounter("http.429")).toBeGreaterThan(0);
    expect(getCounter("breaker.failure")).toBeGreaterThan(0);
    expect(getCounter("retry.attempt.class.A")).toBeGreaterThan(0);
  });
});
