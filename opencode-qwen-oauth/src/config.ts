import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));

export const BUNDLED_COMPATIBILITY_MATRIX: {
  $schema: string;
  version: string;
  updatedAt: string;
  openCode: { range: string; warnRanges: string[]; source: string; status: string };
  node: string[];
  bun: string[];
  os: string[];
} = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  version: "1.0.0",
  updatedAt: "2026-04-12",
  openCode: {
    range: ">=0.14.0 <1.0.0",
    warnRanges: [">=0.14.0 <0.14.2"],
    source: "bundled",
    status: "default"
  },
  node: ["20.x", "22.x"],
  bun: ["latest", "latest-1"],
  os: ["windows", "macos", "linux"]
};

export function getUserMatrixPath(): string {
  return join(getConfigDir(), "qwen-code-oauth-compat.json");
}

export interface RetryDefaults {
  maxAttempts: { A: number; B: number; C: number };
  budget: { capacity: number; windowSeconds: number; refillPerSecond: number };
  breaker: {
    failureThreshold: number;
    windowSeconds: number;
    cooldownSeconds: number;
    halfOpenProbes: number;
  };
  backoff: { baseMs: number; minMs: number; maxMs: number; jitter: "full" };
}

export interface PluginConfig {
  qwenApiBaseUrl: string;
  qwenOauthBaseUrl: string;
  compatibilityPath: string;
  retry: RetryDefaults;
  headlessPolicy: "fail-fast";
  schedulingMode: "cache-first" | "balance";
  maxCacheFirstWaitSeconds: number;
  tokenBudgetPerAccount: number;
  tokenRegenPerMinute: number;
  debug: boolean;
}

interface FileRetryConfig {
  maxAttempts?: { A?: number; B?: number; C?: number };
  budget?: { capacity?: number; windowSeconds?: number; refillPerSecond?: number };
  breaker?: {
    failureThreshold?: number;
    windowSeconds?: number;
    cooldownSeconds?: number;
    halfOpenProbes?: number;
  };
  backoff?: { baseMs?: number; minMs?: number; maxMs?: number; jitter?: "full" };
}

interface PluginFileConfig {
  qwenApiBaseUrl?: string;
  qwenOauthBaseUrl?: string;
  headlessPolicy?: "fail-fast";
  schedulingMode?: "cache-first" | "balance";
  maxCacheFirstWaitSeconds?: number;
  tokenBudgetPerAccount?: number;
  tokenRegenPerMinute?: number;
  debug?: boolean;
  retry?: FileRetryConfig;
  // snake_case compatibility for user-edited JSON.
  qwen_api_base_url?: string;
  qwen_oauth_base_url?: string;
  scheduling_mode?: "cache-first" | "balance";
  max_cache_first_wait_seconds?: number;
  token_budget_per_account?: number;
  token_regen_per_minute?: number;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getConfigDir(): string {
  const override = process.env.OPENCODE_CONFIG_DIR;
  if (override) {
    return override;
  }

  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "opencode");
}

export function getPluginConfigPath(): string {
  return join(getConfigDir(), "qwen-code-oauth.json");
}

function readFileConfig(): PluginFileConfig {
  const path = getPluginConfigPath();
  if (!existsSync(path)) {
    return {};
  }

  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as PluginFileConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function fileValue<T>(camel: T | undefined, snake: T | undefined): T | undefined {
  return camel ?? snake;
}

const DEFAULT_RETRY: RetryDefaults = {
  maxAttempts: { A: 4, B: 3, C: 1 },
  budget: { capacity: 120, windowSeconds: 60, refillPerSecond: 2 },
  breaker: {
    failureThreshold: 10,
    windowSeconds: 30,
    cooldownSeconds: 45,
    halfOpenProbes: 3
  },
  backoff: { baseMs: 250, minMs: 100, maxMs: 5000, jitter: "full" }
};

export function createDefaultConfig(): PluginConfig {
  const fileConfig = readFileConfig();

  return {
    qwenApiBaseUrl:
      process.env.QWEN_API_BASE_URL ??
      fileValue(fileConfig.qwenApiBaseUrl, fileConfig.qwen_api_base_url) ??
      "https://portal.qwen.ai/v1",
    qwenOauthBaseUrl:
      process.env.QWEN_OAUTH_BASE_URL ??
      fileValue(fileConfig.qwenOauthBaseUrl, fileConfig.qwen_oauth_base_url) ??
      "https://oauth.qwen.ai",
    compatibilityPath: getUserMatrixPath(),
    retry: {
      maxAttempts: {
        A: fileConfig.retry?.maxAttempts?.A ?? DEFAULT_RETRY.maxAttempts.A,
        B: fileConfig.retry?.maxAttempts?.B ?? DEFAULT_RETRY.maxAttempts.B,
        C: fileConfig.retry?.maxAttempts?.C ?? DEFAULT_RETRY.maxAttempts.C
      },
      budget: {
        capacity: fileConfig.retry?.budget?.capacity ?? DEFAULT_RETRY.budget.capacity,
        windowSeconds: fileConfig.retry?.budget?.windowSeconds ?? DEFAULT_RETRY.budget.windowSeconds,
        refillPerSecond: fileConfig.retry?.budget?.refillPerSecond ?? DEFAULT_RETRY.budget.refillPerSecond
      },
      breaker: {
        failureThreshold: fileConfig.retry?.breaker?.failureThreshold ?? DEFAULT_RETRY.breaker.failureThreshold,
        windowSeconds: fileConfig.retry?.breaker?.windowSeconds ?? DEFAULT_RETRY.breaker.windowSeconds,
        cooldownSeconds: fileConfig.retry?.breaker?.cooldownSeconds ?? DEFAULT_RETRY.breaker.cooldownSeconds,
        halfOpenProbes: fileConfig.retry?.breaker?.halfOpenProbes ?? DEFAULT_RETRY.breaker.halfOpenProbes
      },
      backoff: {
        baseMs: fileConfig.retry?.backoff?.baseMs ?? DEFAULT_RETRY.backoff.baseMs,
        minMs: fileConfig.retry?.backoff?.minMs ?? DEFAULT_RETRY.backoff.minMs,
        maxMs: fileConfig.retry?.backoff?.maxMs ?? DEFAULT_RETRY.backoff.maxMs,
        jitter: fileConfig.retry?.backoff?.jitter ?? DEFAULT_RETRY.backoff.jitter
      }
    },
    headlessPolicy: fileConfig.headlessPolicy ?? "fail-fast",
    schedulingMode:
      process.env.QWEN_SCHEDULING_MODE === "balance"
        ? "balance"
        : fileValue(fileConfig.schedulingMode, fileConfig.scheduling_mode) ?? "cache-first",
    maxCacheFirstWaitSeconds: parseNumber(
      process.env.QWEN_MAX_CACHE_FIRST_WAIT_SECONDS,
      fileValue(fileConfig.maxCacheFirstWaitSeconds, fileConfig.max_cache_first_wait_seconds) ?? 30
    ),
    tokenBudgetPerAccount: parseNumber(
      process.env.QWEN_TOKEN_BUDGET_PER_ACCOUNT,
      fileValue(fileConfig.tokenBudgetPerAccount, fileConfig.token_budget_per_account) ?? 8
    ),
    tokenRegenPerMinute: parseNumber(
      process.env.QWEN_TOKEN_REGEN_PER_MINUTE,
      fileValue(fileConfig.tokenRegenPerMinute, fileConfig.token_regen_per_minute) ?? 2
    ),
    debug: process.env.QWEN_DEBUG === "1" || fileConfig.debug === true
  };
}

export const DEFAULT_CONFIG: PluginConfig = createDefaultConfig();

