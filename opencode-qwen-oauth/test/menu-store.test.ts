import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { getMenuAccountStorePath, loadMenuAccountRecords, saveMenuAccountRecords } from "../src/index.js";

const ENV_KEYS = [
  "QWEN_NATIVE_TOKEN_STORE_JSON",
  "QWEN_ALLOW_ENV_CREDENTIAL_BRIDGE",
  "QWEN_ENABLE_ENCRYPTED_FALLBACK",
  "QWEN_TOKEN_ENCRYPTION_KEY",
  "OPENCODE_CONFIG_DIR"
] as const;

afterEach(async () => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

describe("menu account store fallback", () => {
  it("persists and reloads accounts when native storage is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qwen-menu-store-"));
    process.env.OPENCODE_CONFIG_DIR = dir;

    // Keep native/encrypted backend unavailable so fallback file path is exercised.
    delete process.env.QWEN_ALLOW_ENV_CREDENTIAL_BRIDGE;
    delete process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK;

    const now = Date.now();
    const records = [
      {
        accountId: "acc-test-1",
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: now + 60_000,
        resourceUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        enabled: true,
        createdAt: now,
        lastUsedAt: now,
        label: "acc-test-1"
      }
    ];

    await saveMenuAccountRecords(records);

    const path = getMenuAccountStorePath();
    expect(path).toContain("qwen-code-oauth.accounts.json");

    const loaded = await loadMenuAccountRecords();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.accountId).toBe("acc-test-1");

    await rm(dir, { recursive: true, force: true });
  });
});
