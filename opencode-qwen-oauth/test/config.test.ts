import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDefaultConfig } from "../src/config.js";

const ENV_KEYS = [
  "OPENCODE_CONFIG_DIR",
  "QWEN_SCHEDULING_MODE",
  "QWEN_MAX_CACHE_FIRST_WAIT_SECONDS",
  "QWEN_TOKEN_BUDGET_PER_ACCOUNT",
  "QWEN_TOKEN_REGEN_PER_MINUTE",
  "QWEN_DEBUG"
] as const;

describe("config file loading", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  it("loads plugin settings from qwen-code-oauth.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qwen-config-"));
    process.env.OPENCODE_CONFIG_DIR = dir;
    await writeFile(
      join(dir, "qwen-code-oauth.json"),
      JSON.stringify(
        {
          schedulingMode: "balance",
          maxCacheFirstWaitSeconds: 12,
          tokenBudgetPerAccount: 3,
          tokenRegenPerMinute: 0.5
        },
        null,
        2
      ),
      "utf8"
    );

    const config = createDefaultConfig();
    expect(config.schedulingMode).toBe("balance");
    expect(config.maxCacheFirstWaitSeconds).toBe(12);
    expect(config.tokenBudgetPerAccount).toBe(3);
    expect(config.tokenRegenPerMinute).toBe(0.5);
  });

  it("keeps env vars as override over json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qwen-config-"));
    process.env.OPENCODE_CONFIG_DIR = dir;
    await writeFile(
      join(dir, "qwen-code-oauth.json"),
      JSON.stringify({ schedulingMode: "cache-first", tokenBudgetPerAccount: 2 }, null, 2),
      "utf8"
    );

    process.env.QWEN_SCHEDULING_MODE = "balance";
    process.env.QWEN_TOKEN_BUDGET_PER_ACCOUNT = "9";

    const config = createDefaultConfig();
    expect(config.schedulingMode).toBe("balance");
    expect(config.tokenBudgetPerAccount).toBe(9);
  });
});
