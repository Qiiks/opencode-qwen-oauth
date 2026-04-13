import type { ProviderModel } from "./types.js";

export interface ModelCacheEntry {
  models: Record<string, ProviderModel>;
  expiresAt: number;
  staleAt: number;
}

export interface ModelCacheOptions {
  now?: () => number;
  ttlMs?: number;
  staleMs?: number;
}

export class ModelCache {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private readonly entries = new Map<string, ModelCacheEntry>();

  constructor(options: ModelCacheOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.staleMs = options.staleMs ?? 30 * 60_000;
  }

  getFresh(key: string): Record<string, ProviderModel> | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt < this.now()) {
      return undefined;
    }

    return entry.models;
  }

  getStale(key: string): Record<string, ProviderModel> | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.staleAt < this.now()) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.models;
  }

  set(key: string, models: Record<string, ProviderModel>): void {
    const now = this.now();
    this.entries.set(key, {
      models,
      expiresAt: now + this.ttlMs,
      staleAt: now + this.staleMs
    });
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }
}
