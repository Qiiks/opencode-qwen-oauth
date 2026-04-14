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

export function canonicalAccountId(input: {
  accountId?: string;
  accessToken?: string;
  refreshToken?: string;
}): string {
  const provided = input.accountId?.trim();
  if (provided && provided.toLowerCase() !== "primary") {
    return provided;
  }

  const derived = input.accessToken ? extractAccountIdFromAccessToken(input.accessToken) : undefined;
  if (derived) {
    return derived;
  }

  const seed = input.refreshToken?.trim() || input.accessToken?.trim();
  if (seed) {
    return `acct-${createAccountFingerprint(seed)}`;
  }

  return "qwencode";
}

export function canonicalAccountLabel(label: string | undefined, accountId: string): string {
  const cleaned = label?.trim();
  if (!cleaned || cleaned.toLowerCase() === "primary") {
    return accountId;
  }

  return cleaned;
}
