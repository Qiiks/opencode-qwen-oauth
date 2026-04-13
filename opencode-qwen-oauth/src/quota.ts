import type { TokenRecord } from "./types.js";

export interface QuotaSnapshot {
  source: string;
  limitPerDay?: number;
  limitPerMinute?: number;
  remainingPerDay?: number;
  remainingPerMinute?: number;
  raw?: unknown;
}

export type QuotaSignalKind = "exhausted" | "throttled";

export interface QuotaSignal {
  kind: QuotaSignalKind;
  source: string;
  message?: string;
  code?: string;
  retryAfterMs?: number;
}

const QUOTA_CANDIDATE_PATHS = [
  "/v1/quota",
  "/quota",
  "/api/v1/quota",
  "/v1/account/quota",
  "/api/v1/account/quota",
  "/models"
];

export const DEFAULT_QUOTA_ESTIMATE_WINDOW_MS = 15 * 60_000;

export function applyQuotaEstimate(
  record: TokenRecord,
  status: number,
  signalKind?: QuotaSignalKind,
  now = Date.now(),
  windowMs = DEFAULT_QUOTA_ESTIMATE_WINDOW_MS
): TokenRecord {
  const existing = record.quotaEstimate;
  const expired =
    !existing ||
    existing.windowMs !== windowMs ||
    now - existing.windowStartedAt >= existing.windowMs;

  const base = expired
    ? {
        windowStartedAt: now,
        windowMs,
        requests: 0,
        successes: 0,
        failures: 0,
        throttled: 0,
        exhausted: 0,
        lastStatus: undefined as number | undefined,
        lastUpdatedAt: now
      }
    : existing;

  const isSuccess = status >= 200 && status < 400;
  const isFailure = status >= 400;
  const isThrottled = signalKind === "throttled" || status === 429 || status === 503 || status === 529;
  const isExhausted = signalKind === "exhausted";

  return {
    ...record,
    quotaEstimate: {
      ...base,
      requests: base.requests + 1,
      successes: base.successes + (isSuccess ? 1 : 0),
      failures: base.failures + (isFailure ? 1 : 0),
      throttled: base.throttled + (isThrottled ? 1 : 0),
      exhausted: base.exhausted + (isExhausted ? 1 : 0),
      lastStatus: status,
      lastUpdatedAt: now
    }
  };
}

export function formatQuotaEstimate(record: TokenRecord, now = Date.now()): string | null {
  const estimate = record.quotaEstimate;
  if (!estimate) {
    return null;
  }

  const remainingMs = Math.max(0, estimate.windowStartedAt + estimate.windowMs - now);
  const remainingMinutes = Math.ceil(remainingMs / 60_000);
  const windowMinutes = Math.round(estimate.windowMs / 60_000);
  return `Local estimate (${windowMinutes}m): req=${estimate.requests}, ok=${estimate.successes}, throttled=${estimate.throttled}, exhausted=${estimate.exhausted}, window-left=${remainingMinutes}m`;
}

function parseNumberLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }

  return undefined;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = parseNumberLike(value);
  if (seconds !== undefined && seconds >= 0) {
    return seconds * 1000;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  const diff = timestamp - Date.now();
  return diff > 0 ? diff : undefined;
}

function extractErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const nested = record.error;
  if (typeof nested === "string") {
    return nested;
  }

  if (nested && typeof nested === "object") {
    const nestedRecord = nested as Record<string, unknown>;
    const nestedMessage = nestedRecord.message;
    if (typeof nestedMessage === "string") {
      return nestedMessage;
    }
  }

  const message = record.message;
  return typeof message === "string" ? message : undefined;
}

function extractErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const nested = record.error;
  if (nested && typeof nested === "object") {
    const nestedRecord = nested as Record<string, unknown>;
    const nestedCode = nestedRecord.code;
    if (typeof nestedCode === "string" || typeof nestedCode === "number") {
      return String(nestedCode);
    }
  }

  const code = record.code;
  if (typeof code === "string" || typeof code === "number") {
    return String(code);
  }

  return undefined;
}

function classifyQuotaSignal(
  source: string,
  status: number,
  code: string | undefined,
  message: string | undefined,
  retryAfterMs: number | undefined
): QuotaSignal | null {
  const normalizedCode = code?.toLowerCase();
  const normalizedMessage = message?.toLowerCase();

  const isHardQuotaExceeded =
    normalizedCode === "insufficient_quota" ||
    normalizedMessage?.includes("free allocated quota exceeded") ||
    normalizedMessage?.includes("quota exceeded for quota metric") ||
    normalizedMessage?.includes("daily quota") ||
    normalizedMessage?.includes("quota has been reached");

  if ((status === 429 || status === 403) && isHardQuotaExceeded) {
    return {
      kind: "exhausted",
      source,
      message,
      code,
      retryAfterMs
    };
  }

  const isThrottleCode =
    normalizedCode === "rate_limit_exceeded" ||
    normalizedCode === "too_many_requests" ||
    normalizedCode === "1302" ||
    normalizedCode === "1305";

  const isThrottleMessage =
    normalizedMessage?.includes("rate limit") ||
    normalizedMessage?.includes("throttl") ||
    normalizedMessage?.includes("too many requests") ||
    normalizedMessage?.includes("resource_exhausted");

  if (status === 429 || status === 503 || isThrottleCode || isThrottleMessage) {
    return {
      kind: "throttled",
      source,
      message,
      code,
      retryAfterMs
    };
  }

  return null;
}

export async function detectQuotaSignal(response: Response, source = "api"): Promise<QuotaSignal | null> {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  const status = response.status;

  if (status !== 429 && status !== 403 && status !== 503) {
    return null;
  }

  let payload: unknown;
  try {
    const text = await response.clone().text();
    if (text.trim()) {
      payload = JSON.parse(text) as unknown;
    }
  } catch {
    // Ignore parse failures and classify based on status and headers.
  }

  const code = extractErrorCode(payload);
  const message = extractErrorMessage(payload);
  return classifyQuotaSignal(source, status, code, message, retryAfterMs);
}

export function formatQuotaSignal(signal: QuotaSignal | null): string | null {
  if (!signal) {
    return null;
  }

  if (signal.kind === "exhausted") {
    return signal.message
      ? `Quota signal: exhausted (${signal.message})`
      : "Quota signal: exhausted (daily/free quota likely reached)";
  }

  const retryHint =
    signal.retryAfterMs !== undefined && signal.retryAfterMs > 0
      ? `, retry in ~${Math.ceil(signal.retryAfterMs / 1000)}s`
      : "";
  return signal.message
    ? `Quota signal: throttled (${signal.message}${retryHint})`
    : `Quota signal: throttled${retryHint}`;
}

function tryMapQuotaPayload(source: string, payload: unknown): QuotaSnapshot | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const record = payload as Record<string, unknown>;

  const remainingPerDay = parseNumberLike(
    record.remaining_per_day ?? record.daily_remaining ?? record.remainingDaily ?? record.remaining
  );
  const limitPerDay = parseNumberLike(
    record.limit_per_day ?? record.daily_limit ?? record.limitDaily ?? record.total
  );
  const remainingPerMinute = parseNumberLike(
    record.remaining_per_minute ?? record.minute_remaining ?? record.remainingMinute
  );
  const limitPerMinute = parseNumberLike(
    record.limit_per_minute ?? record.minute_limit ?? record.limitMinute
  );

  if (
    remainingPerDay === undefined &&
    limitPerDay === undefined &&
    remainingPerMinute === undefined &&
    limitPerMinute === undefined
  ) {
    return undefined;
  }

  return {
    source,
    limitPerDay,
    limitPerMinute,
    remainingPerDay,
    remainingPerMinute,
    raw: payload
  };
}

function tryMapQuotaHeaders(source: string, headers: Headers): QuotaSnapshot | undefined {
  const getHeaderNumber = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = headers.get(key);
      const parsed = parseNumberLike(value);
      if (parsed !== undefined) {
        return parsed;
      }
    }
    return undefined;
  };

  const limitPerMinute = getHeaderNumber(
    "x-ratelimit-limit-requests",
    "x-ratelimit-limit",
    "ratelimit-limit"
  );
  const remainingPerMinute = getHeaderNumber(
    "x-ratelimit-remaining-requests",
    "x-ratelimit-remaining",
    "ratelimit-remaining"
  );
  const limitPerDay = getHeaderNumber(
    "x-ratelimit-limit-day",
    "x-ratelimit-day-limit"
  );
  const remainingPerDay = getHeaderNumber(
    "x-ratelimit-remaining-day",
    "x-ratelimit-day-remaining"
  );

  if (
    remainingPerDay === undefined &&
    limitPerDay === undefined &&
    remainingPerMinute === undefined &&
    limitPerMinute === undefined
  ) {
    return undefined;
  }

  return {
    source: `${source} (headers)`,
    limitPerDay,
    limitPerMinute,
    remainingPerDay,
    remainingPerMinute,
    raw: {
      retryAfter: headers.get("retry-after") ?? undefined,
      requestLimit: headers.get("x-ratelimit-limit-requests") ?? headers.get("x-ratelimit-limit") ?? undefined,
      requestRemaining: headers.get("x-ratelimit-remaining-requests") ?? headers.get("x-ratelimit-remaining") ?? undefined
    }
  };
}

export async function queryQuota(baseUrl: string, accessToken: string): Promise<QuotaSnapshot | null> {
  const diagnostics: string[] = [];

  for (const path of QUOTA_CANDIDATE_PATHS) {
    const url = new URL(path, baseUrl).toString();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        }
      });
    } catch {
      diagnostics.push(`${path}:fetch-error`);
      continue;
    }

    diagnostics.push(`${path}:${response.status}`);

    const mappedHeaders = tryMapQuotaHeaders(path, response.headers);
    if (mappedHeaders) {
      mappedHeaders.raw = {
        ...(typeof mappedHeaders.raw === "object" && mappedHeaders.raw ? mappedHeaders.raw : {}),
        diagnostics
      };
      return mappedHeaders;
    }

    if (!response.ok) {
      continue;
    }

    const text = await response.text();
    if (!text.trim()) {
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      continue;
    }

    const mapped = tryMapQuotaPayload(path, payload);
    if (mapped) {
      return mapped;
    }
  }

  if (diagnostics.length > 0) {
    return {
      source: "probe",
      raw: { diagnostics }
    };
  }

  return null;
}

export function formatQuota(snapshot: QuotaSnapshot | null): string {
  if (!snapshot) {
    return "Quota: unavailable via public endpoint";
  }

  const chunks: string[] = [];
  if (snapshot.remainingPerDay !== undefined || snapshot.limitPerDay !== undefined) {
    chunks.push(`daily ${snapshot.remainingPerDay ?? "?"}/${snapshot.limitPerDay ?? "?"}`);
  }

  if (snapshot.remainingPerMinute !== undefined || snapshot.limitPerMinute !== undefined) {
    chunks.push(`minute ${snapshot.remainingPerMinute ?? "?"}/${snapshot.limitPerMinute ?? "?"}`);
  }

  if (chunks.length === 0) {
    if (
      snapshot.raw &&
      typeof snapshot.raw === "object" &&
      Array.isArray((snapshot.raw as { diagnostics?: unknown }).diagnostics)
    ) {
      const diagnostics = (snapshot.raw as { diagnostics: string[] }).diagnostics;
      return `Quota (${snapshot.source}): unavailable via public endpoint [${diagnostics.join(", ")}]`;
    }

    return `Quota (${snapshot.source}): unavailable via public endpoint`;
  }

  const summary = chunks.join(", ");
  return `Quota (${snapshot.source}): ${summary}`;
}
