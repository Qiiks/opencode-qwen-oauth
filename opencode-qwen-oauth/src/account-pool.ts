import type { TokenRecord, StoredAuth } from "./types.js";

export interface AccountCandidate {
  accountId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  resourceUrl?: string;
}

export interface AccountRuntime extends AccountCandidate {
  cooldownUntil: number;
  penaltyScore: number;
  lastSelectedAt: number;
  inFlightCount: number;
  tokens: number;
  tokensUpdatedAt: number;
}

export interface AccountPoolOptions {
  now?: () => number;
  defaultCooldownMs?: number;
  maxTokens?: number;
  regenPerMinute?: number;
}

export class AccountPool {
  private readonly now: () => number;
  private readonly defaultCooldownMs: number;
  private readonly maxTokens: number;
  private readonly regenPerMinute: number;
  private readonly runtimes = new Map<string, AccountRuntime>();

  constructor(options: AccountPoolOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.defaultCooldownMs = options.defaultCooldownMs ?? 30_000;
    this.maxTokens = Math.max(1, options.maxTokens ?? 8);
    this.regenPerMinute = Math.max(0.1, options.regenPerMinute ?? 2);
  }

  importStoredAuth(auth: StoredAuth): void {
    if (auth.type !== "oauth") {
      return;
    }

    this.upsert({
      accountId: auth.accountId ?? "primary",
      accessToken: auth.access,
      refreshToken: auth.refresh,
      expiresAt: auth.expires,
      resourceUrl: auth.resourceUrl
    });
  }

  importTokenRecords(records: TokenRecord[]): void {
    for (const record of records) {
      if (record.enabled === false) {
        continue;
      }

      this.upsert({
        accountId: record.accountId,
        accessToken: record.accessToken,
        refreshToken: record.refreshToken,
        expiresAt: record.expiresAt,
        resourceUrl: record.resourceUrl
      });
    }
  }

  list(): AccountRuntime[] {
    return Array.from(this.runtimes.values()).map((runtime) => ({ ...runtime }));
  }

  select(preferredAccountId?: string): AccountRuntime | undefined {
    const now = this.now();
    const candidates = Array.from(this.runtimes.values())
      .map((runtime) => this.applyRegen(runtime))
      .filter((runtime) => runtime.expiresAt > now + 15_000 && runtime.tokens >= 1);

    if (candidates.length === 0) {
      return undefined;
    }

    if (preferredAccountId) {
      const preferred = candidates.find((runtime) => runtime.accountId === preferredAccountId);
      if (preferred && preferred.cooldownUntil <= now) {
        return this.markSelected(preferred);
      }
    }

    const healthy = candidates.filter((runtime) => runtime.cooldownUntil <= now);
    const pool = healthy.length > 0 ? healthy : candidates;

    pool.sort((a, b) => {
      if (a.penaltyScore !== b.penaltyScore) {
        return a.penaltyScore - b.penaltyScore;
      }
      if (a.inFlightCount !== b.inFlightCount) {
        return a.inFlightCount - b.inFlightCount;
      }
      return a.lastSelectedAt - b.lastSelectedAt;
    });

    return this.markSelected(pool[0]);
  }

  markSuccess(accountId: string): void {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) {
      return;
    }

    runtime.penaltyScore = Math.max(0, runtime.penaltyScore - 1);
    runtime.inFlightCount = Math.max(0, runtime.inFlightCount - 1);
    runtime.tokens = Math.min(this.maxTokens, runtime.tokens + 0.15);
    this.runtimes.set(accountId, runtime);
  }

  markFailure(accountId: string, retryAfterMs?: number): void {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) {
      return;
    }

    runtime.penaltyScore += 2;
    runtime.inFlightCount = Math.max(0, runtime.inFlightCount - 1);
    runtime.cooldownUntil = Math.max(runtime.cooldownUntil, this.now() + (retryAfterMs ?? this.defaultCooldownMs));
    this.runtimes.set(accountId, runtime);
  }

  replace(candidate: AccountCandidate): void {
    const runtime = this.runtimes.get(candidate.accountId);
    if (!runtime) {
      this.upsert(candidate);
      return;
    }

    this.runtimes.set(candidate.accountId, {
      ...runtime,
      ...candidate,
      cooldownUntil: Math.min(runtime.cooldownUntil, this.now())
    });
  }

  private upsert(candidate: AccountCandidate): void {
    const existing = this.runtimes.get(candidate.accountId);
    if (!existing) {
      this.runtimes.set(candidate.accountId, {
        ...candidate,
        cooldownUntil: 0,
        penaltyScore: 0,
        lastSelectedAt: 0,
        inFlightCount: 0,
        tokens: this.maxTokens,
        tokensUpdatedAt: this.now()
      });
      return;
    }

    this.runtimes.set(candidate.accountId, {
      ...existing,
      ...candidate
    });
  }

  private markSelected(runtime: AccountRuntime): AccountRuntime {
    runtime.lastSelectedAt = this.now();
    runtime.inFlightCount += 1;
    runtime.tokens = Math.max(0, runtime.tokens - 1);
    runtime.tokensUpdatedAt = this.now();
    this.runtimes.set(runtime.accountId, runtime);
    return { ...runtime };
  }

  private applyRegen(runtime: AccountRuntime): AccountRuntime {
    const now = this.now();
    const elapsedMinutes = Math.max(0, now - runtime.tokensUpdatedAt) / 60_000;
    if (elapsedMinutes <= 0) {
      return runtime;
    }

    const replenished = Math.min(this.maxTokens, runtime.tokens + elapsedMinutes * this.regenPerMinute);
    const next = {
      ...runtime,
      tokens: replenished,
      tokensUpdatedAt: now
    };
    this.runtimes.set(next.accountId, next);
    return next;
  }
}
