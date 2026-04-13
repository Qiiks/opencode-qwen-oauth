const SECRET_PATTERNS = [
  /(bearer\s+)[A-Za-z0-9._-]+/gi,
  /(refresh_token\"?\s*[:=]\s*\"?)[^\",\s]+/gi,
  /(access_token\"?\s*[:=]\s*\"?)[^\",\s]+/gi,
  /(authorization\"?\s*[:=]\s*\"?)[^\",\s]+/gi,
  /(auth_code\"?\s*[:=]\s*\"?)[^\",\s]+/gi,
  /(credential_handle\"?\s*[:=]\s*\"?)[^\",\s]+/gi
];

export function redactSecrets(message: string): string {
  let redacted = message;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "$1[REDACTED]");
  }
  return redacted;
}

export async function logInfo(logFn: ((entry: { body: Record<string, unknown> }) => Promise<void>) | undefined, message: string, extra?: Record<string, unknown>): Promise<void> {
  if (!logFn) {
    return;
  }

  await logFn({
    body: {
      service: "opencode-qwen-oauth",
      level: "info",
      message: redactSecrets(message),
      extra
    }
  });
}
