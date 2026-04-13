import { afterEach, describe, expect, it, vi } from "vitest";
import { applyQuotaEstimate, detectQuotaSignal, formatQuota, formatQuotaEstimate, formatQuotaSignal, queryQuota } from "../src/quota.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("quota formatting", () => {
  it("formats quota snapshot", () => {
    const message = formatQuota({
      source: "/v1/quota",
      remainingPerDay: 850,
      limitPerDay: 1000,
      remainingPerMinute: 55,
      limitPerMinute: 60
    });

    expect(message).toContain("daily 850/1000");
    expect(message).toContain("minute 55/60");
  });

  it("formats unavailable quota", () => {
    expect(formatQuota(null)).toContain("unavailable");
  });

  it("formats probe diagnostics when numeric quota metrics are unavailable", () => {
    const message = formatQuota({
      source: "probe",
      raw: { diagnostics: ["/v1/quota:404", "/models:200"] }
    });

    expect(message).toContain("unavailable via public endpoint");
    expect(message).toContain("/v1/quota:404");
    expect(message).toContain("/models:200");
  });

  it("extracts quota from rate-limit headers when endpoint payload is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("", {
          status: 404,
          headers: {
            "x-ratelimit-limit-requests": "120",
            "x-ratelimit-remaining-requests": "119",
            "x-ratelimit-reset-requests": "12"
          }
        })
      )
    );

    const snapshot = await queryQuota("https://dashscope.aliyuncs.com/compatible-mode/v1", "token");
    expect(snapshot).not.toBeNull();
    expect(snapshot?.limitPerMinute).toBe(120);
    expect(snapshot?.remainingPerMinute).toBe(119);
    expect(snapshot?.source).toContain("headers");
  });

  it("classifies Qwen insufficient_quota as exhausted", async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          code: "insufficient_quota",
          message: "Free allocated quota exceeded."
        }
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json"
        }
      }
    );

    const signal = await detectQuotaSignal(response, "chat");
    expect(signal?.kind).toBe("exhausted");
    expect(formatQuotaSignal(signal)).toContain("exhausted");
  });

  it("classifies 429 rate limit as throttled and preserves retry-after", async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          code: "rate_limit_exceeded",
          message: "Rate limit exceeded"
        }
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "12"
        }
      }
    );

    const signal = await detectQuotaSignal(response, "chat");
    expect(signal?.kind).toBe("throttled");
    expect(signal?.retryAfterMs).toBe(12000);
    expect(formatQuotaSignal(signal)).toContain("throttled");
  });

  it("tracks rolling local estimate counters", () => {
    const now = Date.now();
    const base = {
      accountId: "acc-local-estimate",
      accessToken: "token",
      expiresAt: now + 60_000
    };

    const one = applyQuotaEstimate(base, 200, undefined, now, 15 * 60_000);
    const two = applyQuotaEstimate(one, 429, "throttled", now + 1_000, 15 * 60_000);
    const three = applyQuotaEstimate(two, 429, "exhausted", now + 2_000, 15 * 60_000);

    expect(three.quotaEstimate?.requests).toBe(3);
    expect(three.quotaEstimate?.successes).toBe(1);
    expect(three.quotaEstimate?.failures).toBe(2);
    expect(three.quotaEstimate?.throttled).toBe(2);
    expect(three.quotaEstimate?.exhausted).toBe(1);

    const summary = formatQuotaEstimate(three, now + 3_000);
    expect(summary).toContain("Local estimate (15m)");
    expect(summary).toContain("req=3");
    expect(summary).toContain("throttled=2");
    expect(summary).toContain("exhausted=1");
  });

  it("resets local estimate after window expiry", () => {
    const now = Date.now();
    const base = {
      accountId: "acc-window-reset",
      accessToken: "token",
      expiresAt: now + 60_000
    };

    const first = applyQuotaEstimate(base, 429, "throttled", now, 60_000);
    const second = applyQuotaEstimate(first, 200, undefined, now + 61_000, 60_000);

    expect(second.quotaEstimate?.requests).toBe(1);
    expect(second.quotaEstimate?.successes).toBe(1);
    expect(second.quotaEstimate?.throttled).toBe(0);
  });
});
