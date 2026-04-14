import { describe, expect, it } from "vitest";
import { AccountPool } from "../src/account-pool.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

describe("account pool", () => {
  it("selects both accounts fairly", () => {
    let now = 1_000;
    const pool = new AccountPool({ now: () => now });
    pool.importTokenRecords([
      {
        accountId: "a",
        accessToken: "ta",
        refreshToken: "ra",
        expiresAt: 999_999,
        resourceUrl: "https://portal.qwen.ai"
      },
      {
        accountId: "b",
        accessToken: "tb",
        refreshToken: "rb",
        expiresAt: 999_999,
        resourceUrl: "https://portal.qwen.ai"
      }
    ]);

    const first = pool.select();
    if (first) {
      pool.markSuccess(first.accountId);
    }
    now += 1;
    const second = pool.select();

    expect(first?.accountId).toBeDefined();
    expect(second?.accountId).toBeDefined();
    expect(first?.accountId).not.toBe(second?.accountId);
  });

  it("avoids recently rate-limited account", () => {
    let now = 5_000;
    const pool = new AccountPool({ now: () => now, defaultCooldownMs: 30_000 });
    pool.importTokenRecords([
      { accountId: "a", accessToken: "a", expiresAt: 999_999 },
      { accountId: "b", accessToken: "b", expiresAt: 999_999 }
    ]);

    const chosen = pool.select("a");
    expect(chosen?.accountId).toBe("a");
    if (chosen) {
      pool.markFailure(chosen.accountId, 20_000);
    }

    const fallback = pool.select();
    expect(fallback?.accountId).toBe("b");

    now += 25_000;
    const recovered = pool.select();
    expect(["a", "b"]).toContain(recovered?.accountId);
  });

  it("respects token budget and regenerates over time", () => {
    let now = 10_000;
    const pool = new AccountPool({ now: () => now, maxTokens: 1, regenPerMinute: 1 });
    pool.importTokenRecords([
      { accountId: "a", accessToken: "a", expiresAt: 999_999 },
      { accountId: "b", accessToken: "b", expiresAt: 999_999 }
    ]);

    const first = pool.select();
    expect(first).toBeDefined();
    const second = pool.select();
    expect(second).toBeDefined();
    const third = pool.select();
    expect(third).toBeUndefined();

    now += 60_000;
    const regenerated = pool.select();
    expect(regenerated).toBeDefined();
  });

  it("normalizes legacy primary account id to token-derived subject", () => {
    const pool = new AccountPool({ now: () => 1000 });
    const accessToken = createJwt({ sub: "qwencode" });

    pool.importStoredAuth({
      type: "oauth",
      access: accessToken,
      refresh: "refresh-1",
      expires: 999_999,
      accountId: "primary"
    });

    const selected = pool.select();
    expect(selected?.accountId).toBe("qwencode");
  });

  it("normalizes primary account id in imported token records", () => {
    const pool = new AccountPool({ now: () => 1000 });
    const accessToken = createJwt({ sub: "canonical-subject" });

    pool.importTokenRecords([
      {
        accountId: "primary",
        accessToken,
        refreshToken: "refresh-primary",
        expiresAt: 999_999,
        enabled: true
      }
    ]);

    const selected = pool.select();
    expect(selected?.accountId).toBe("canonical-subject");
  });
});
