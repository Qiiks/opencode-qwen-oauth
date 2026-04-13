import { ERROR_CODES, PluginError } from "./errors.js";
import type { RetryClass } from "./types.js";

export interface RetryPolicy {
  maxAttempts: { A: number; B: number; C: number };
  budget: { capacity: number; windowSeconds: number; refillPerSecond: number };
  breaker: {
    failureThreshold: number;
    windowSeconds: number;
    cooldownSeconds: number;
    halfOpenProbes: number;
  };
  backoff: { baseMs: number; minMs: number; maxMs: number };
}

type BreakerState = "closed" | "open" | "half-open";
type BreakerTransition = BreakerState;

export class RetryBudget {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly windowSeconds: number
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  consume(amount = 1): boolean {
    this.refill();
    if (this.tokens < amount) {
      return false;
    }

    this.tokens -= amount;
    return true;
  }

  private refill(): void {
    const now = Date.now();
    const deltaSeconds = (now - this.lastRefill) / 1000;
    if (deltaSeconds <= 0) {
      return;
    }

    const cappedDelta = Math.min(deltaSeconds, this.windowSeconds);
    const refill = cappedDelta * this.refillPerSecond;
    this.tokens = Math.min(this.capacity, this.tokens + refill);
    this.lastRefill = now;
  }
}

export class CircuitBreaker {
  private failures: number[] = [];
  private state: BreakerState = "closed";
  private openedAt = 0;
  private halfOpenProbes = 0;

  constructor(
    private readonly policy: RetryPolicy["breaker"],
    private readonly onTransition?: (state: BreakerTransition) => void
  ) {}

  private setState(next: BreakerState): void {
    if (this.state === next) {
      return;
    }

    this.state = next;
    this.onTransition?.(next);
  }

  check(): void {
    if (this.state === "open") {
      const elapsed = (Date.now() - this.openedAt) / 1000;
      if (elapsed >= this.policy.cooldownSeconds) {
        this.setState("half-open");
        this.halfOpenProbes = 0;
      } else {
        throw new PluginError(ERROR_CODES.BREAKER_OPEN, "Circuit breaker is open");
      }
    }

    if (this.state === "half-open" && this.halfOpenProbes >= this.policy.halfOpenProbes) {
      this.setState("open");
      this.openedAt = Date.now();
      throw new PluginError(ERROR_CODES.BREAKER_OPEN, "Circuit breaker half-open probes exhausted");
    }

    if (this.state === "half-open") {
      this.halfOpenProbes += 1;
    }
  }

  success(): void {
    if (this.state === "half-open" && this.halfOpenProbes >= this.policy.halfOpenProbes) {
      this.setState("closed");
      this.failures = [];
    }
  }

  failure(): void {
    const now = Date.now();
    this.failures.push(now);
    const windowStart = now - this.policy.windowSeconds * 1000;
    this.failures = this.failures.filter((value) => value >= windowStart);

    if (this.failures.length >= this.policy.failureThreshold) {
      this.setState("open");
      this.openedAt = now;
    }

    if (this.state === "half-open") {
      this.setState("open");
      this.openedAt = now;
    }
  }
}

export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly policy: RetryPolicy["breaker"],
    private readonly onTransition?: (state: BreakerTransition) => void
  ) {}

  forService(serviceKey: string): CircuitBreaker {
    const existing = this.breakers.get(serviceKey);
    if (existing) {
      return existing;
    }

    const created = new CircuitBreaker(this.policy, this.onTransition);
    this.breakers.set(serviceKey, created);
    return created;
  }
}

export function assertRetryAllowed(retryClass: RetryClass, idempotencyKey?: string): void {
  if (retryClass === "C") {
    throw new PluginError(ERROR_CODES.RETRY_CLASS_DISALLOWED, "Class C requests cannot be retried automatically");
  }

  if (retryClass === "B" && !idempotencyKey) {
    throw new PluginError(ERROR_CODES.RETRY_CLASS_DISALLOWED, "Class B retries require idempotency key");
  }
}

export function ensureBudgetToken(budget: RetryBudget): void {
  if (!budget.consume()) {
    throw new PluginError(ERROR_CODES.RETRY_BUDGET_EXHAUSTED, "Retry budget exhausted");
  }
}

export function maxAttemptsForClass(policy: RetryPolicy, retryClass: RetryClass): number {
  return policy.maxAttempts[retryClass];
}

export function fullJitterBackoff(baseMs: number, minMs: number, maxMs: number, attempt: number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const raw = Math.floor(Math.random() * exp);
  return Math.max(minMs, Math.min(maxMs, raw));
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
