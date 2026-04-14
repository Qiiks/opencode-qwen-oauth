import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QwenOauthPlugin, saveMenuAccountRecords } from "../src/index.js";
import type { StoredAuth } from "../src/types.js";

interface LoaderOutput {
  fetch: (requestInput: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

function hasFetch(value: unknown): value is LoaderOutput {
  return typeof value === "object" && value !== null && "fetch" in value
    && typeof (value as { fetch?: unknown }).fetch === "function";
}

const ENV_KEYS = [
  "QWEN_NATIVE_TOKEN_STORE_JSON",
  "QWEN_ALLOW_ENV_CREDENTIAL_BRIDGE",
  "QWEN_ENABLE_ENCRYPTED_FALLBACK",
  "QWEN_TOKEN_ENCRYPTION_KEY",
  "OPENCODE_CONFIG_DIR"
] as const;

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

describe("canonical account identity", () => {
  it("uses canonical subject from local token store when live auth accountId is legacy primary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qwen-canonical-"));
    process.env.OPENCODE_CONFIG_DIR = dir;

    delete process.env.QWEN_ALLOW_ENV_CREDENTIAL_BRIDGE;
    delete process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK;

    const now = Date.now();
    const jwt = createJwt({ sub: "qwencode" });

    await saveMenuAccountRecords([
      {
        accountId: "qwencode",
        accessToken: jwt,
        refreshToken: "refresh-qwencode",
        expiresAt: now + 3_600_000,
        enabled: true,
        createdAt: now,
        lastUsedAt: now,
        label: "qwencode"
      }
    ]);

    const plugin = await QwenOauthPlugin({ client: { app: { log: async () => undefined } } });
    const loader = plugin.auth?.loader;
    expect(loader).toBeTypeOf("function");

    const getAuth = async (): Promise<StoredAuth> => ({
      type: "oauth",
      access: jwt,
      refresh: "refresh-primary",
      expires: now - 1_000,
      accountId: "primary"
    });

    const loaded = await loader?.(getAuth, {
      id: "qwen-code",
      name: "qwen",
      source: "custom",
      options: {},
      models: {}
    });

    expect(hasFetch(loaded)).toBe(true);
    if (!hasFetch(loaded)) {
      throw new Error("Expected auth loader output with fetch function");
    }

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    await loaded.fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/models", { method: "GET" });

    const request = fetchMock.mock.calls[0]?.[0];
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url).toContain("/models");
    expect(new Headers(init?.headers).get("authorization")).toContain("Bearer ");

    await rm(dir, { recursive: true, force: true });
  });
});
