import { ERROR_CODES, PluginError } from "./errors.js";
import { incrementCounter } from "./telemetry.js";
import type { TokenRecord } from "./types.js";

export class RefreshCoordinator {
  private inflight = new Map<string, Promise<TokenRecord>>();

  async runSingleFlight(
    key: string,
    refreshFn: () => Promise<TokenRecord>,
    timeoutMs = 10_000
  ): Promise<TokenRecord> {
    const existing = this.inflight.get(key);
    if (existing) {
      const startedAt = Date.now();
      const result = await this.withTimeout(existing, timeoutMs);
      incrementCounter("refresh.lock.wait", 1);
      incrementCounter("refresh.lock.wait.ms", Date.now() - startedAt);
      return result;
    }

    const promise = refreshFn().finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, promise);
    return this.withTimeout(promise, timeoutMs);
  }

  private async withTimeout(promise: Promise<TokenRecord>, timeoutMs: number): Promise<TokenRecord> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<TokenRecord>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new PluginError(
          ERROR_CODES.REFRESH_SINGLEFLIGHT_TIMEOUT,
          `Refresh lock wait exceeded ${timeoutMs}ms`
        ));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
