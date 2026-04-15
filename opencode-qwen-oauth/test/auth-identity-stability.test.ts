import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { canonicalAccountId, createRefreshTokenFingerprint, extractAccountIdFromAccessToken } from "../src/account-identity.js";
import type { TokenRecord, StoredAuth } from "../src/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMenuAccountRecords, saveMenuAccountRecords, QwenOauthPlugin } from "../src/index.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

afterEach(async () => {
  vi.restoreAllMocks();
});

describe("canonicalAccountId stability", () => {
  it("produces the same accountId when access token changes but refresh token stays the same", () => {
    const refreshToken = "stable-refresh-token-abc123";
    const oldAccessToken = createJwt({ sub: "user-1" });
    const newAccessToken = createJwt({ sub: "user-1" });

    const idBeforeRefresh = canonicalAccountId({
      accountId: "primary",
      accessToken: oldAccessToken,
      refreshToken
    });

    const idAfterRefresh = canonicalAccountId({
      accountId: "primary",
      accessToken: newAccessToken,
      refreshToken
    });

    expect(idBeforeRefresh).toBe(idAfterRefresh);
  });

  it("produces the same accountId when access token changes to a completely different JWT", () => {
    const refreshToken = "stable-refresh-token-xyz789";
    const jwtOld = createJwt({ sub: "user-alice" });
    const jwtNew = createJwt({ sub: "user-alice", email: "alice@example.com" });

    const idOld = canonicalAccountId({
      accountId: "primary",
      accessToken: jwtOld,
      refreshToken
    });

    const idNew = canonicalAccountId({
      accountId: "primary",
      accessToken: jwtNew,
      refreshToken
    });

    expect(idOld).toBe(idNew);
  });

  it("uses explicit non-primary accountId when provided", () => {
    const id = canonicalAccountId({
      accountId: "custom-account-id",
      accessToken: "any-token",
      refreshToken: "any-refresh"
    });

    expect(id).toBe("custom-account-id");
  });

  it("normalizes 'primary' accountId using refreshToken fingerprint", () => {
    const refreshToken = "my-refresh-token";
    const id = canonicalAccountId({
      accountId: "primary",
      accessToken: createJwt({ sub: "user-1" }),
      refreshToken
    });

    const expectedFingerprint = createRefreshTokenFingerprint(refreshToken);
    expect(id).toBe(expectedFingerprint);
  });

  it("normalizes 'PRIMARY' (case-insensitive) using refreshToken fingerprint", () => {
    const refreshToken = "my-refresh-token";
    const id = canonicalAccountId({
      accountId: "PRIMARY",
      accessToken: createJwt({ sub: "user-1" }),
      refreshToken
    });

    const expectedFingerprint = createRefreshTokenFingerprint(refreshToken);
    expect(id).toBe(expectedFingerprint);
  });

  it("falls back to accessToken JWT subject when no refreshToken", () => {
    const accessToken = createJwt({ sub: "jwt-subject-123" });
    const id = canonicalAccountId({
      accessToken,
      refreshToken: undefined
    });

    expect(id).toBe("jwt-subject-123");
  });

  it("falls back to accessToken fingerprint when no refreshToken and non-JWT access", () => {
    const id = canonicalAccountId({
      accessToken: "opaque-access-token",
      refreshToken: undefined
    });

    expect(id).toMatch(/^acct-[0-9a-f]{12}$/);
  });

  it("returns 'qwencode' when no tokens at all", () => {
    const id = canonicalAccountId({});
    expect(id).toBe("qwencode");
  });
});

describe("createRefreshTokenFingerprint", () => {
  it("produces consistent fingerprints for the same refreshToken", () => {
    const fp1 = createRefreshTokenFingerprint("same-refresh-token");
    const fp2 = createRefreshTokenFingerprint("same-refresh-token");
    expect(fp1).toBe(fp2);
  });

  it("produces different fingerprints for different refreshTokens", () => {
    const fp1 = createRefreshTokenFingerprint("refresh-token-a");
    const fp2 = createRefreshTokenFingerprint("refresh-token-b");
    expect(fp1).not.toBe(fp2);
  });

  it("returns undefined for empty or missing refreshToken", () => {
    expect(createRefreshTokenFingerprint("")).toBeUndefined();
    expect(createRefreshTokenFingerprint(undefined)).toBeUndefined();
    expect(createRefreshTokenFingerprint("  ")).toBeUndefined();
  });

  it("produces acct- prefixed fingerprint", () => {
    const fp = createRefreshTokenFingerprint("some-refresh");
    expect(fp).toMatch(/^acct-[0-9a-f]{12}$/);
  });
});

describe("extractAccountIdFromAccessToken", () => {
  it("extracts sub from JWT", () => {
    const token = createJwt({ sub: "user-123" });
    expect(extractAccountIdFromAccessToken(token)).toBe("user-123");
  });

  it("extracts email when no sub", () => {
    const token = createJwt({ email: "user@example.com" });
    expect(extractAccountIdFromAccessToken(token)).toBe("user@example.com");
  });

  it("extracts uid when no sub or email", () => {
    const token = createJwt({ uid: "uid-456" });
    expect(extractAccountIdFromAccessToken(token)).toBe("uid-456");
  });

  it("prefers sub over email and uid", () => {
    const token = createJwt({ sub: "sub-val", email: "email-val", uid: "uid-val" });
    expect(extractAccountIdFromAccessToken(token)).toBe("sub-val");
  });

  it("returns undefined for non-JWT string", () => {
    expect(extractAccountIdFromAccessToken("not-a-jwt")).toBeUndefined();
  });

  it("returns undefined for JWT with no identity claims", () => {
    const token = createJwt({ iat: 1234 });
    expect(extractAccountIdFromAccessToken(token)).toBeUndefined();
  });
});

describe("token record deduplication on refresh", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "qwen-dedup-"));
    process.env.OPENCODE_CONFIG_DIR = tempDir;
    delete process.env.QWEN_ALLOW_ENV_CREDENTIAL_BRIDGE;
    delete process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK;
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not create duplicate accounts when token is refreshed with same refreshToken", async () => {
    const now = Date.now();
    const refreshToken = "stable-refresh-abc";
    const accountId = canonicalAccountId({ accountId: "primary", refreshToken });

    const originalRecords: TokenRecord[] = [
      {
        accountId,
        accessToken: createJwt({ sub: "user-1" }),
        refreshToken,
        expiresAt: now + 3_600_000,
        enabled: true,
        createdAt: now,
        lastUsedAt: now,
        label: accountId
      }
    ];

    await saveMenuAccountRecords(originalRecords);

    const refreshedAccessToken = createJwt({ sub: "user-1", email: "updated@example.com" });
    const refreshedRecords: TokenRecord[] = [
      {
        accountId,
        accessToken: refreshedAccessToken,
        refreshToken,
        expiresAt: now + 7_200_000,
        enabled: true,
        createdAt: now,
        lastUsedAt: now + 1_000,
        label: accountId
      }
    ];

    await saveMenuAccountRecords(refreshedRecords);

    const loaded = await loadMenuAccountRecords();
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.accessToken).toBe(refreshedAccessToken);
    expect(loaded[0]?.refreshToken).toBe(refreshToken);
  });

  it("merges accounts with matching refreshToken fingerprint but different accountId", async () => {
    const now = Date.now();
    const refreshToken = "shared-refresh-token";

    const record1: TokenRecord = {
      accountId: "some-old-id",
      accessToken: createJwt({ sub: "user-1" }),
      refreshToken,
      expiresAt: now + 3_600_000,
      enabled: true,
      createdAt: now - 10_000,
      lastUsedAt: now - 5_000,
      label: "some-old-id"
    };

    const expectedAccountId = canonicalAccountId({ refreshToken });
    const record2: TokenRecord = {
      accountId: expectedAccountId,
      accessToken: createJwt({ sub: "user-1" }),
      refreshToken,
      expiresAt: now + 7_200_000,
      enabled: true,
      createdAt: now,
      lastUsedAt: now,
      label: expectedAccountId
    };

    await saveMenuAccountRecords([record1, record2]);

    const loaded = await loadMenuAccountRecords();
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.refreshToken).toBe(refreshToken);
  });

  it("preserves multiple distinct accounts with different refreshTokens", async () => {
    const now = Date.now();
    const refresh1 = "refresh-user-a";
    const refresh2 = "refresh-user-b";
    const accountId1 = canonicalAccountId({ refreshToken: refresh1 });
    const accountId2 = canonicalAccountId({ refreshToken: refresh2 });

    const records: TokenRecord[] = [
      {
        accountId: accountId1,
        accessToken: createJwt({ sub: "user-a" }),
        refreshToken: refresh1,
        expiresAt: now + 3_600_000,
        enabled: true,
        createdAt: now,
        lastUsedAt: now,
        label: accountId1
      },
      {
        accountId: accountId2,
        accessToken: createJwt({ sub: "user-b" }),
        refreshToken: refresh2,
        expiresAt: now + 3_600_000,
        enabled: true,
        createdAt: now,
        lastUsedAt: now,
        label: accountId2
      }
    ];

    await saveMenuAccountRecords(records);
    const loaded = await loadMenuAccountRecords();
    expect(loaded.length).toBe(2);
  });

  it("handles legacy primary accountId correctly", async () => {
    const now = Date.now();
    const refreshToken = "legacy-refresh-token";
    const canonicalId = canonicalAccountId({ accountId: "primary", refreshToken });

    const record: TokenRecord = {
      accountId: "primary",
      accessToken: createJwt({ sub: "user-1" }),
      refreshToken,
      expiresAt: now + 3_600_000,
      enabled: true,
      createdAt: now,
      lastUsedAt: now,
      label: "primary"
    };

    await saveMenuAccountRecords([record]);
    const loaded = await loadMenuAccountRecords();

    expect(loaded.length).toBe(1);
    expect(loaded[0]?.accountId).toBe(canonicalId);
  });
});

describe("resolvePluginAuth with refresh", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "qwen-resolve-"));
    process.env.OPENCODE_CONFIG_DIR = tempDir;
    delete process.env.QWEN_ALLOW_ENV_CREDENTIAL_BRIDGE;
    delete process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK;
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves auth from local store when live token is expired", async () => {
    const now = Date.now();
    const refreshToken = "resolve-refresh-token";
    const accountId = canonicalAccountId({ refreshToken });

    const freshAccessToken = createJwt({ sub: "user-1" });
    await saveMenuAccountRecords([
      {
        accountId,
        accessToken: freshAccessToken,
        refreshToken,
        expiresAt: now + 3_600_000,
        enabled: true,
        createdAt: now,
        lastUsedAt: now,
        label: accountId
      }
    ]);

    const plugin = await QwenOauthPlugin({ client: { app: { log: async () => undefined } } });
    const loader = plugin.auth?.loader;
    expect(loader).toBeTypeOf("function");

    const getAuth = async (): Promise<StoredAuth> => ({
      type: "oauth",
      access: "expired-access-token",
      refresh: refreshToken,
      expires: now - 10_000,
      accountId: "primary"
    });

    const loaded = await loader?.(getAuth, {
      id: "qwen-code",
      name: "qwen",
      source: "custom",
      options: {},
      models: {}
    });

    expect(loaded).toBeDefined();
    expect(loaded).toHaveProperty("apiKey", "QWEN_OAUTH_DYNAMIC_TOKEN");
  });

  it("does not create duplicate when OpenCode returns primary accountId", async () => {
    const now = Date.now();
    const refreshToken = "no-dup-refresh-token";
    const canonicalId = canonicalAccountId({ accountId: "primary", refreshToken });

    await saveMenuAccountRecords([
      {
        accountId: canonicalId,
        accessToken: createJwt({ sub: "user-1" }),
        refreshToken,
        expiresAt: now + 3_600_000,
        enabled: true,
        createdAt: now,
        lastUsedAt: now,
        label: canonicalId
      }
    ]);

    const plugin = await QwenOauthPlugin({ client: { app: { log: async () => undefined } } });
    const loader = plugin.auth?.loader;
    if (!loader) throw new Error("No loader");

    const getAuth = async (): Promise<StoredAuth> => ({
      type: "oauth",
      access: createJwt({ sub: "user-1" }),
      refresh: refreshToken,
      expires: now + 3_600_000,
      accountId: "primary"
    });

    await loader(getAuth, {
      id: "qwen-code",
      name: "qwen",
      source: "custom",
      options: {},
      models: {}
    });

    const recordsAfter = await loadMenuAccountRecords();
    const withSameRefresh = recordsAfter.filter(
      (r) => r.refreshToken === refreshToken
    );
    expect(withSameRefresh.length).toBe(1);
  });
});

describe("refresh token fingerprint matching", () => {
  it("finds account by refreshToken fingerprint when accountId differs", async () => {
    const now = Date.now();
    const refreshToken = "fingerprint-match-refresh";

    const storedRecord: TokenRecord = {
      accountId: "some-old-id",
      accessToken: createJwt({ sub: "user-1" }),
      refreshToken,
      expiresAt: now + 3_600_000,
      enabled: true,
      createdAt: now,
      lastUsedAt: now,
      label: "some-old-id"
    };

    await saveMenuAccountRecords([storedRecord]);

    const loaded = await loadMenuAccountRecords();
    const matchByFingerprint = loaded.find(
      (r) => createRefreshTokenFingerprint(r.refreshToken) === createRefreshTokenFingerprint(refreshToken)
    );

    expect(matchByFingerprint).toBeDefined();
    expect(matchByFingerprint?.refreshToken).toBe(refreshToken);
  });
});
