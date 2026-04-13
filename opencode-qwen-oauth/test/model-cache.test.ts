import { describe, expect, it } from "vitest";
import { ModelCache } from "../src/model-cache.js";

describe("model cache", () => {
  it("returns fresh entries inside ttl", () => {
    let now = 1_000;
    const cache = new ModelCache({ now: () => now, ttlMs: 10_000, staleMs: 60_000 });
    cache.set("k", {
      "coder-model": {
        id: "coder-model",
        name: "coder-model",
        api: { id: "coder-model", url: "https://portal.qwen.ai/v1", npm: "@ai-sdk/openai-compatible" },
        limit: { context: 1, output: 1 },
        capabilities: {
          toolcall: true,
          temperature: true,
          reasoning: true,
          attachment: true,
          input: { text: true, image: false, audio: false, video: false, pdf: false },
          output: { text: true, image: false, audio: false, video: false, pdf: false },
          interleaved: false
        },
        status: "active",
        headers: {},
        options: {},
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        release_date: ""
      }
    });

    expect(cache.getFresh("k")).toBeDefined();
    now += 20_000;
    expect(cache.getFresh("k")).toBeUndefined();
    expect(cache.getStale("k")).toBeDefined();
  });
});
