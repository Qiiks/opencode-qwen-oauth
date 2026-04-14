import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { getMenuAccountStorePath, loadMenuAccountRecords, saveMenuAccountRecords } from "../src/index.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

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

  it("deduplicates legacy primary and canonical account ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qwen-menu-store-dedupe-"));
    process.env.OPENCODE_CONFIG_DIR = dir;

    delete process.env.QWEN_ALLOW_ENV_CREDENTIAL_BRIDGE;
    delete process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK;

    const now = Date.now();
    const jwt = createJwt({ sub: "qwencode" });

    await saveMenuAccountRecords([
      {
        accountId: "primary",
        accessToken: jwt,
        refreshToken: "refresh-primary",
        expiresAt: now + 120_000,
        enabled: true,
        createdAt: now,
        lastUsedAt: now,
        label: "primary"
      },
      {
        accountId: "qwencode",
        accessToken: jwt,
        refreshToken: "refresh-canonical",
        expiresAt: now + 180_000,
        enabled: true,
        createdAt: now,
        lastUsedAt: now + 1,
        label: "qwencode"
      }
    ]);

    const loaded = await loadMenuAccountRecords();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.accountId).toBe("qwencode");
    expect(loaded[0]?.label).toBe("qwencode");

    await rm(dir, { recursive: true, force: true });
  });

  it("merges native and local records instead of dropping local entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qwen-menu-store-merge-"));
    process.env.OPENCODE_CONFIG_DIR = dir;

    process.env.QWEN_ALLOW_ENV_CREDENTIAL_BRIDGE = "1";
    process.env.QWEN_NATIVE_TOKEN_STORE_JSON = JSON.stringify({
      tokens: [
        {
          accountId: "native-a",
          accessToken: "native-access",
          refreshToken: "native-refresh",
          expiresAt: Date.now() + 60_000,
          enabled: true,
          label: "native-a"
        }
      ]
    });

    delete process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK;

    const now = Date.now();
    await saveMenuAccountRecords([
      {
        accountId: "local-b",
        accessToken: "local-access",
        refreshToken: "local-refresh",
        expiresAt: now + 120_000,
        enabled: true,
        createdAt: now,
        lastUsedAt: now,
        label: "local-b"
      }
    ]);

    const loaded = await loadMenuAccountRecords();
    const ids = loaded.map((entry) => entry.accountId).sort();
    expect(ids).toEqual(["local-b", "native-a"]);

    await rm(dir, { recursive: true, force: true });
  });
});
