import { createHash } from "node:crypto";

export function extractAccountIdFromAccessToken(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2) {
    return undefined;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const candidate = payload.sub ?? payload.email ?? payload.uid;
    return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function createAccountFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * Derive a stable accountId for a Qwen OAuth account.
 *
 * Stability guarantee: For the same logical user (same refreshToken),
 * the returned accountId is stable across access token refreshes.
 *
 * Priority order:
 * 1. Explicit non-"primary" accountId → use as-is (already stable)
 * 2. RefreshToken fingerprint → stable across access token changes
 * 3. AccessToken JWT subject → only if no refreshToken available
 * 4. AccessToken fingerprint → last resort
 * 5. "qwencode" fallback
 *
 * The refreshToken is the primary identity anchor because:
 * - It changes rarely (only on explicit re-auth or rotation)
 * - It uniquely identifies a Qwen user session
 * - It survives access token refreshes unchanged
 */
export function canonicalAccountId(input: {
  accountId?: string;
  accessToken?: string;
  refreshToken?: string;
}): string {
  const provided = input.accountId?.trim();
  if (provided && provided.toLowerCase() !== "primary") {
    return provided;
  }

  // Prefer refreshToken fingerprint as stable identity.
  // The refreshToken survives access token refreshes, making it
  // a reliable anchor that doesn't create duplicate accounts.
  const refreshTokenSeed = input.refreshToken?.trim();
  if (refreshTokenSeed) {
    return `acct-${createAccountFingerprint(refreshTokenSeed)}`;
  }

  // Fall back to JWT subject only when no refreshToken is available.
  const derived = input.accessToken ? extractAccountIdFromAccessToken(input.accessToken) : undefined;
  if (derived) {
    return derived;
  }

  // Last resort: fingerprint from access token.
  const accessTokenSeed = input.accessToken?.trim();
  if (accessTokenSeed) {
    return `acct-${createAccountFingerprint(accessTokenSeed)}`;
  }

  return "qwencode";
}

export function createRefreshTokenFingerprint(refreshToken?: string): string | undefined {
  const seed = refreshToken?.trim();
  if (!seed) {
    return undefined;
  }
  return `acct-${createAccountFingerprint(seed)}`;
}

export function canonicalAccountLabel(label: string | undefined, accountId: string): string {
  const cleaned = label?.trim();
  if (!cleaned || cleaned.toLowerCase() === "primary") {
    return accountId;
  }

  return cleaned;
}
