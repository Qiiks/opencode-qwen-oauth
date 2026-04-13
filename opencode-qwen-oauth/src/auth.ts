import { ERROR_CODES, PluginError } from "./errors.js";
import { RefreshCoordinator } from "./refresh.js";
import { loadTokens, saveTokens } from "./storage.js";
import { incrementCounter } from "./telemetry.js";
import type { TokenRecord } from "./types.js";

const REFRESH_WINDOW_SECONDS = 300;

export interface AuthManagerOptions {
  coordinator: RefreshCoordinator;
  now?: () => number;
  refreshFn?: (token: TokenRecord) => Promise<TokenRecord>;
  loadTokensFn?: () => Promise<TokenRecord[]>;
  saveTokensFn?: (tokens: TokenRecord[]) => Promise<void>;
}

export class AuthManager {
  private readonly coordinator: RefreshCoordinator;
  private readonly now: () => number;
  private readonly refreshFn: (token: TokenRecord) => Promise<TokenRecord>;
  private readonly loadTokensFn: () => Promise<TokenRecord[]>;
  private readonly saveTokensFn: (tokens: TokenRecord[]) => Promise<void>;
  private nextIndex = 0;

  constructor(options: AuthManagerOptions) {
    this.coordinator = options.coordinator;
    this.now = options.now ?? (() => Date.now());
    this.refreshFn = options.refreshFn ?? (async (token) => token);
    this.loadTokensFn = options.loadTokensFn ?? loadTokens;
    this.saveTokensFn = options.saveTokensFn ?? saveTokens;
  }

  async getActiveToken(accountId?: string): Promise<TokenRecord> {
    const tokens = (await this.loadTokensFn()).filter((token) => token.enabled !== false);
    if (tokens.length === 0) {
      throw new PluginError(ERROR_CODES.AUTH_MISSING_CREDENTIALS, "No Qwen OAuth credentials found");
    }

    let selected: TokenRecord | undefined;
    if (accountId) {
      selected = tokens.find((token) => token.accountId === accountId);
      if (!selected) {
        throw new PluginError(ERROR_CODES.AUTH_SCOPE_UNSUPPORTED, "Requested account is not available.", { accountId });
      }
    } else {
      // Prefer accounts that are not near expiry and rotate for fairness.
      const now = this.now();
      const healthy = tokens.filter((token) => token.expiresAt > now + 60_000);
      const pool = healthy.length > 0 ? healthy : tokens;
      selected = pool[this.nextIndex % pool.length];
      this.nextIndex = (this.nextIndex + 1) % Math.max(pool.length, 1);
    }

    if (!selected) {
      throw new PluginError(ERROR_CODES.AUTH_SCOPE_UNSUPPORTED, "No account available for token selection.");
    }

    if (!selected.accessToken || selected.expiresAt <= 0) {
      throw new PluginError(
        ERROR_CODES.AUTH_INVALID_CREDENTIALS,
        "Stored credentials are invalid or malformed. Re-authenticate with Qwen OAuth."
      );
    }

    if (isNearExpiry(selected, this.now)) {
      return this.refreshToken(selected, tokens);
    }

    return selected;
  }

  async failIfHeadlessWithoutSupport(): Promise<void> {
    const headless = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    if (headless) {
      throw new PluginError(
        ERROR_CODES.AUTH_HEADLESS_UNSUPPORTED,
        "Headless OAuth is unsupported in v1. Run in interactive mode and authenticate first."
      );
    }
  }

  private async refreshToken(token: TokenRecord, allTokens: TokenRecord[]): Promise<TokenRecord> {
    try {
      incrementCounter("refresh.attempt");
      const refreshed = await this.coordinator.runSingleFlight(token.accountId, async () => {
        const result = await this.refreshFn(token);
        if (!result.accessToken || result.expiresAt <= this.now()) {
          throw new PluginError(ERROR_CODES.REFRESH_UPSTREAM_REJECTED, "Upstream refresh produced invalid token");
        }

        const updated = allTokens.map((value) => {
          if (value.accountId !== token.accountId) {
            return value;
          }
          return result;
        });

        await this.saveTokensFn(updated);
        incrementCounter("refresh.success");
        return result;
      });

      return refreshed;
    } catch (error) {
      if (error instanceof PluginError) {
        incrementCounter("refresh.fail");
        throw error;
      }

      incrementCounter("refresh.fail");
      throw new PluginError(
        ERROR_CODES.REFRESH_UPSTREAM_REJECTED,
        "Qwen OAuth refresh failed",
        { cause: error instanceof Error ? error.message : String(error), accountId: token.accountId }
      );
    }
  }
}

export function isNearExpiry(token: TokenRecord, now: () => number): boolean {
  return token.expiresAt - now() <= REFRESH_WINDOW_SECONDS * 1000;
}
