import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTokens, saveTokens } from "../src/storage.js";

describe("storage backend policy", () => {
  it("rejects env credential source when env bridge is not explicitly enabled", async () => {
    const prevJson = process.env.QWEN_NATIVE_TOKEN_STORE_JSON;
    const prevAllow = process.env.QWEN_ALLOW_ENV_CREDENTIAL_BRIDGE;
    const prevFallback = process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK;
    process.env.QWEN_NATIVE_TOKEN_STORE_JSON = JSON.stringify({
      tokens: [
        { accessToken: "x", refreshToken: "y", expiresAt: Date.now() + 10_000, accountId: "a" }
      ]
    });
    delete process.env.QWEN_ALLOW_ENV_CREDENTIAL_BRIDGE;
    process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK = "1";

    try {
      await expect(loadTokens()).rejects.toMatchObject({
        code: "E_STORAGE_BACKEND_UNAVAILABLE"
      });
      await expect(loadTokens()).rejects.toThrow("Env credential bridge is disabled");
    } finally {
      if (prevJson !== undefined) {
        process.env.QWEN_NATIVE_TOKEN_STORE_JSON = prevJson;
      } else {
        delete process.env.QWEN_NATIVE_TOKEN_STORE_JSON;
      }
      if (prevAllow !== undefined) {
        process.env.QWEN_ALLOW_ENV_CREDENTIAL_BRIDGE = prevAllow;
      } else {
        delete process.env.QWEN_ALLOW_ENV_CREDENTIAL_BRIDGE;
      }
      if (prevFallback !== undefined) {
        process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK = prevFallback;
      } else {
        delete process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK;
      }
    }
  });

  it("emits storage backend unavailable when encrypted fallback disabled", async () => {
    const previousFallback = process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK;
    const previousNative = process.env.QWEN_NATIVE_TOKEN_STORE_JSON;
    delete process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK;
    delete process.env.QWEN_NATIVE_TOKEN_STORE_JSON;

    try {
      await expect(loadTokens()).rejects.toMatchObject({
        code: "E_STORAGE_BACKEND_UNAVAILABLE"
      });

      await expect(loadTokens()).rejects.toThrow("Native credential backend unavailable");
    } finally {
      if (previousFallback !== undefined) {
        process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK = previousFallback;
      }
      if (previousNative !== undefined) {
        process.env.QWEN_NATIVE_TOKEN_STORE_JSON = previousNative;
      }
    }
  });

  it("round-trips encrypted fallback tokens when enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qwen-store-"));
    const path = join(dir, "tokens.json");

    const previousFallback = process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK;
    const previousKey = process.env.QWEN_TOKEN_ENCRYPTION_KEY;
    process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK = "1";
    process.env.QWEN_TOKEN_ENCRYPTION_KEY = "test-encryption-key-123";

    try {
      await saveTokens([
        {
          accessToken: "acc",
          refreshToken: "ref",
          expiresAt: Date.now() + 100_000,
          accountId: "acc-1"
        }
      ], path);

      const loaded = await loadTokens(path);
      expect(loaded[0]?.accountId).toBe("acc-1");
    } finally {
      if (previousFallback !== undefined) {
        process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK = previousFallback;
      } else {
        delete process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK;
      }
      if (previousKey !== undefined) {
        process.env.QWEN_TOKEN_ENCRYPTION_KEY = previousKey;
      } else {
        delete process.env.QWEN_TOKEN_ENCRYPTION_KEY;
      }
    }
  });
});
