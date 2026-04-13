import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  assertRetryAllowed,
  CircuitBreaker,
  ensureBudgetToken,
  fullJitterBackoff,
  RetryBudget,
  type RetryPolicy
} from "../src/retry.js";
import { PluginError } from "../src/errors.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const policy: RetryPolicy = {
  maxAttempts: { A: 4, B: 3, C: 1 },
  budget: { capacity: 120, windowSeconds: 60, refillPerSecond: 2 },
  breaker: {
    failureThreshold: 2,
    windowSeconds: 30,
    cooldownSeconds: 1,
    halfOpenProbes: 2
  },
  backoff: { baseMs: 250, minMs: 100, maxMs: 5000 }
};

describe("retry policy", () => {
  it("rejects class C automatic retry", () => {
    try {
      assertRetryAllowed("C");
      throw new Error("expected class C rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError);
      expect((error as PluginError).code).toBe("E_RETRY_CLASS_DISALLOWED");
      expect((error as PluginError).message).toContain("Class C requests cannot be retried automatically");
    }
  });

  it("requires idempotency key for class B", () => {
    try {
      assertRetryAllowed("B");
      throw new Error("expected class B rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError);
      expect((error as PluginError).code).toBe("E_RETRY_CLASS_DISALLOWED");
      expect((error as PluginError).message).toContain("Class B retries require idempotency key");
    }

    expect(() => assertRetryAllowed("B", "idemp-1")).not.toThrow();
  });

  it("enforces budget consumption", () => {
    const budget = new RetryBudget(2, 0, 60);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(false);
  });

  it("emits retry budget exhausted canonical error", () => {
    const budget = new RetryBudget(1, 0, 60);
    ensureBudgetToken(budget);

    try {
      ensureBudgetToken(budget);
      throw new Error("expected budget failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError);
      expect((error as PluginError).code).toBe("E_RETRY_BUDGET_EXHAUSTED");
      expect((error as PluginError).message).toContain("Retry budget exhausted");
    }
  });

  it("keeps jitter in configured bounds", () => {
    for (let i = 0; i < 20; i += 1) {
      const delay = fullJitterBackoff(250, 100, 5000, i + 1);
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(5000);
    }
  });

  it("opens breaker after threshold failures", () => {
    const breaker = new CircuitBreaker(policy.breaker);
    breaker.failure();
    breaker.failure();
    try {
      breaker.check();
      throw new Error("expected breaker open");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError);
      expect((error as PluginError).code).toBe("E_BREAKER_OPEN");
      expect((error as PluginError).message).toContain("Circuit breaker");
    }
  });

  it("honors frozen default breaker policy and half-open probes", () => {
    const defaultBreakerPolicy = DEFAULT_CONFIG.retry.breaker;
    expect(defaultBreakerPolicy.failureThreshold).toBe(10);
    expect(defaultBreakerPolicy.cooldownSeconds).toBe(45);
    expect(defaultBreakerPolicy.halfOpenProbes).toBe(3);

    const breaker = new CircuitBreaker(defaultBreakerPolicy);
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(0);

    for (let i = 0; i < 10; i += 1) {
      breaker.failure();
    }

    expect(() => breaker.check()).toThrow();

    nowSpy.mockReturnValue(46_000);
    expect(() => breaker.check()).not.toThrow();
    breaker.success();
    breaker.success();
    breaker.success();
    expect(() => breaker.check()).not.toThrow();
    nowSpy.mockRestore();
  });

  it("enforces exactly three half-open probes before reopening", () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      windowSeconds: 30,
      cooldownSeconds: 1,
      halfOpenProbes: 3
    });

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(0);
    breaker.failure();

    nowSpy.mockReturnValue(2_000);
    expect(() => breaker.check()).not.toThrow();
    expect(() => breaker.check()).not.toThrow();
    expect(() => breaker.check()).not.toThrow();
    expect(() => breaker.check()).toThrowError(PluginError);

    nowSpy.mockRestore();
  });
});
