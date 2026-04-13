import { chmod, mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, userInfo } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ERROR_CODES, PluginError } from "./errors.js";
import type { TokenRecord } from "./types.js";

const LOCK_STALE_MS = 30_000;
const LOCK_POLL_INTERVAL_MS = 200;
const LOCK_MAX_WAIT_MS = 10_000;

export function getLockDirPath(storagePath = getTokenStoragePath()): string {
  return `${storagePath}.refresh-lock`;
}

export async function acquireRefreshLock(storagePath = getTokenStoragePath()): Promise<() => Promise<void>> {
  const lockDir = getLockDirPath(storagePath);
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      await mkdir(lockDir, { recursive: false });
      return async () => {
        try {
          await rmdir(lockDir);
        } catch {
          // Lock already removed (e.g. stale cleanup by another process).
        }
      };
    } catch (error: unknown) {
      const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "EEXIST") {
        throw error;
      }

      // Check if lock is stale (owner process likely crashed).
      try {
        const lockStat = await stat(lockDir);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          try {
            await rmdir(lockDir);
          } catch {
            // Another process cleaned it up first — retry mkdir.
          }
          continue;
        }
      } catch {
        // Lock directory disappeared between mkdir and stat — retry.
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
    }
  }

  throw new PluginError(
    ERROR_CODES.STORAGE_BACKEND_UNAVAILABLE,
    `Could not acquire refresh lock within ${LOCK_MAX_WAIT_MS}ms. Another process may be refreshing tokens.`
  );
}

interface PersistedState {
  version: number;
  mode: "encrypted-file";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

let fallbackWarningShown = false;
const execFileAsync = promisify(execFile);

function getBaseConfigDir(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  }

  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

export function getTokenStoragePath(): string {
  return join(getBaseConfigDir(), "opencode", "qwen-auth-accounts.json");
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  const tempPath = `${path}.tmp-${Date.now()}`;
  await writeFile(tempPath, content, "utf8");

  if (process.platform !== "win32") {
    await chmod(tempPath, 0o600);
  }

  await rename(tempPath, path);
}

function getNativeTokensFromEnv(): TokenRecord[] | null {
  const raw = process.env.QWEN_NATIVE_TOKEN_STORE_JSON;
  if (!raw) {
    return null;
  }

  if (process.env.QWEN_ALLOW_ENV_CREDENTIAL_BRIDGE !== "1") {
    throw new PluginError(
      ERROR_CODES.STORAGE_BACKEND_UNAVAILABLE,
      "Env credential bridge is disabled. Set QWEN_ALLOW_ENV_CREDENTIAL_BRIDGE=1 to allow this source."
    );
  }

  const parsed = JSON.parse(raw) as { tokens?: TokenRecord[] };
  if (!Array.isArray(parsed.tokens)) {
    throw new PluginError(ERROR_CODES.STORAGE_BACKEND_UNAVAILABLE, "Invalid QWEN_NATIVE_TOKEN_STORE_JSON format");
  }

  return parsed.tokens;
}

async function readNativeTokensMacOS(): Promise<TokenRecord[] | null> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      "opencode-qwen-oauth",
      "-w"
    ]);
    const parsed = JSON.parse(stdout.trim()) as { tokens?: TokenRecord[] };
    return Array.isArray(parsed.tokens) ? parsed.tokens : null;
  } catch {
    return null;
  }
}

async function readNativeTokensWindows(): Promise<TokenRecord[] | null> {
  try {
    const { stdout } = await execFileAsync("powershell", [
      "-NoProfile",
      "-Command",
      "if (Get-Command Get-StoredCredential -ErrorAction SilentlyContinue) { $c=Get-StoredCredential -Target 'opencode-qwen-oauth'; if ($c) { $c.Password } }"
    ]);

    if (!stdout.trim()) {
      return null;
    }

    const parsed = JSON.parse(stdout.trim()) as { tokens?: TokenRecord[] };
    return Array.isArray(parsed.tokens) ? parsed.tokens : null;
  } catch {
    return null;
  }
}

async function readNativeTokensLinux(): Promise<TokenRecord[] | null> {
  try {
    const { stdout } = await execFileAsync("secret-tool", [
      "lookup",
      "service",
      "opencode-qwen-oauth"
    ]);
    if (!stdout.trim()) {
      return null;
    }

    const parsed = JSON.parse(stdout.trim()) as { tokens?: TokenRecord[] };
    return Array.isArray(parsed.tokens) ? parsed.tokens : null;
  } catch {
    return null;
  }
}

async function loadNativeTokensFromOs(): Promise<TokenRecord[] | null> {
  if (process.platform === "darwin") {
    return readNativeTokensMacOS();
  }

  if (process.platform === "win32") {
    return readNativeTokensWindows();
  }

  return readNativeTokensLinux();
}

async function writeNativeTokensMacOS(tokens: TokenRecord[]): Promise<boolean> {
  try {
    const payload = JSON.stringify({ tokens });
    await execFileAsync("security", [
      "add-generic-password",
      "-U",
      "-a",
      userInfo().username,
      "-s",
      "opencode-qwen-oauth",
      "-w",
      payload
    ]);
    return true;
  } catch {
    return false;
  }
}

async function writeNativeTokensWindows(tokens: TokenRecord[]): Promise<boolean> {
  try {
    const payload = JSON.stringify({ tokens }).replace(/"/g, "\\\"");
    await execFileAsync("powershell", [
      "-NoProfile",
      "-Command",
      `if (Get-Command New-StoredCredential -ErrorAction SilentlyContinue) { New-StoredCredential -Target 'opencode-qwen-oauth' -UserName 'opencode-qwen-oauth' -Password \"${payload}\" -Persist LocalMachine | Out-Null; exit 0 } else { exit 1 }`
    ]);
    return true;
  } catch {
    return false;
  }
}

async function writeNativeTokensLinux(tokens: TokenRecord[]): Promise<boolean> {
  try {
    const payload = JSON.stringify({ tokens }).replace(/'/g, `'"'"'`);
    await execFileAsync("bash", [
      "-lc",
      `printf '%s' '${payload}' | secret-tool store --label='opencode-qwen-oauth' service opencode-qwen-oauth`
    ]);
    return true;
  } catch {
    return false;
  }
}

async function saveNativeTokensToOs(tokens: TokenRecord[]): Promise<boolean> {
  if (process.platform === "darwin") {
    return writeNativeTokensMacOS(tokens);
  }

  if (process.platform === "win32") {
    return writeNativeTokensWindows(tokens);
  }

  return writeNativeTokensLinux(tokens);
}

function isEncryptedFallbackEnabled(): boolean {
  return process.env.QWEN_ENABLE_ENCRYPTED_FALLBACK === "1";
}

function getEncryptionMaterial(saltHex?: string): { key: Buffer; salt: Buffer } {
  const salt = saltHex ? Buffer.from(saltHex, "hex") : randomBytes(16);
  const configuredKey = process.env.QWEN_TOKEN_ENCRYPTION_KEY;
  if (!configuredKey) {
    throw new PluginError(
      ERROR_CODES.STORAGE_BACKEND_UNAVAILABLE,
      "Encrypted fallback requires QWEN_TOKEN_ENCRYPTION_KEY to be set."
    );
  }

  const key = scryptSync(configuredKey, salt, 32);
  return { key, salt };
}

function encryptTokens(tokens: TokenRecord[]): PersistedState {
  const { key, salt } = getEncryptionMaterial();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(tokens);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    mode: "encrypted-file",
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: ciphertext.toString("hex")
  };
}

function decryptTokens(state: PersistedState): TokenRecord[] {
  const { key } = getEncryptionMaterial(state.salt);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(state.iv, "hex"));
  decipher.setAuthTag(Buffer.from(state.tag, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(state.ciphertext, "hex")),
    decipher.final()
  ]).toString("utf8");

  const parsed = JSON.parse(plaintext) as TokenRecord[];
  if (!Array.isArray(parsed)) {
    throw new PluginError(ERROR_CODES.STORAGE_BACKEND_UNAVAILABLE, "Invalid decrypted token payload");
  }

  return parsed;
}

function warnEncryptedFallback(path: string): void {
  if (fallbackWarningShown) {
    return;
  }

  fallbackWarningShown = true;
  console.warn(`[opencode-qwen-oauth] Native credential backend unavailable, using encrypted file fallback at ${path}`);
}

export async function loadTokens(path = getTokenStoragePath()): Promise<TokenRecord[]> {
  const osNativeTokens = await loadNativeTokensFromOs();
  if (osNativeTokens) {
    return osNativeTokens;
  }

  const nativeTokens = getNativeTokensFromEnv();
  if (nativeTokens) {
    return nativeTokens;
  }

  if (!isEncryptedFallbackEnabled()) {
    throw new PluginError(
      ERROR_CODES.STORAGE_BACKEND_UNAVAILABLE,
      "Native credential backend unavailable and encrypted fallback is disabled. Set QWEN_ENABLE_ENCRYPTED_FALLBACK=1 to allow encrypted file storage."
    );
  }

  warnEncryptedFallback(path);

  try {
    await stat(path);
  } catch {
    return [];
  }

  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as PersistedState;
  if (parsed.mode !== "encrypted-file") {
    throw new PluginError(
      ERROR_CODES.STORAGE_BACKEND_UNAVAILABLE,
      `Invalid token store format at ${path}`
    );
  }

  return decryptTokens(parsed);
}

export async function saveTokens(tokens: TokenRecord[], path = getTokenStoragePath()): Promise<void> {
  const wroteNative = await saveNativeTokensToOs(tokens);
  if (wroteNative) {
    return;
  }

  if (getNativeTokensFromEnv()) {
    throw new PluginError(
      ERROR_CODES.STORAGE_BACKEND_UNAVAILABLE,
      "Native credential backend is read-only from env bridge; cannot persist updates"
    );
  }

  if (!isEncryptedFallbackEnabled()) {
    throw new PluginError(
      ERROR_CODES.STORAGE_BACKEND_UNAVAILABLE,
      "Encrypted fallback persistence is disabled. Set QWEN_ENABLE_ENCRYPTED_FALLBACK=1 to persist tokens in encrypted file mode."
    );
  }

  warnEncryptedFallback(path);
  const payload = encryptTokens(tokens);

  try {
    await atomicWrite(path, JSON.stringify(payload, null, 2));
  } catch (error) {
    throw new PluginError(
      ERROR_CODES.STORAGE_BACKEND_UNAVAILABLE,
      "Failed writing token store",
      { cause: error instanceof Error ? error.message : String(error), path }
    );
  }
}
