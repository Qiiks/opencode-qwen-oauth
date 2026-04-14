import { BUNDLED_COMPATIBILITY_MATRIX, DEFAULT_CONFIG } from "./config.js";
import { getPluginConfigPath } from "./config.js";
import { enforceCompatibility } from "./compatibility.js";
import { ERROR_CODES, PluginError } from "./errors.js";
import { logInfo } from "./logging.js";
import { incrementCounter } from "./telemetry.js";
import { AuthManager } from "./auth.js";
import { RefreshCoordinator } from "./refresh.js";
import { acquireRefreshLock, loadTokens, saveTokens } from "./storage.js";
import { AccountPool } from "./account-pool.js";
import { ModelCache } from "./model-cache.js";
import { applyQuotaEstimate, detectQuotaSignal, formatQuota, formatQuotaEstimate, formatQuotaSignal, queryQuota } from "./quota.js";
import { confirmMenu, isInteractiveTTY, selectMenu } from "./tui.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { canonicalAccountId, canonicalAccountLabel } from "./account-identity.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import {
  assertRetryAllowed,
  CircuitBreakerRegistry,
  ensureBudgetToken,
  fullJitterBackoff,
  maxAttemptsForClass,
  RetryBudget,
  sleep,
  type RetryPolicy
} from "./retry.js";
import type {
  OAuthFailure,
  OAuthSuccess,
  PluginFactory,
  ProviderModel,
  StoredAuth,
  TokenRecord,
  ToolExecuteInput,
  ToolExecuteOutput
} from "./types.js";

const RETRYABLE_STATUS = new Set([429, 529]);
const QWEN_PROVIDER_ID = "qwen-code";
const QWEN_OAUTH_BASE_URL = "https://chat.qwen.ai";
const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device/code`;
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`;
const QWEN_OAUTH_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
const QWEN_OAUTH_SCOPE = "openid profile email model.completion";
const QWEN_OAUTH_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const QWEN_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const QWEN_MENU_ACCOUNT_STORE_FILE = "qwen-code-oauth.accounts.json";

interface DeviceAuthorizationData {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
}

interface DeviceTokenPending {
  status?: "pending";
  slowDown?: boolean;
  error?: string;
  error_description?: string;
}

interface DeviceTokenSuccess {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  resource_url?: string;
}

interface QwenModelListResponse {
  data?: Array<{ id?: string; name?: string }>;
}

interface QwenChatCompletionResponse {
  model?: string;
}

interface QwenChatContentPart {
  type: string;
  text?: string;
  cache_control?: { type: "ephemeral" };
  [key: string]: unknown;
}

interface QwenChatMessage {
  role?: string;
  content?: string | QwenChatContentPart[] | null;
  [key: string]: unknown;
}

interface QwenChatCompletionBody {
  messages?: QwenChatMessage[];
  [key: string]: unknown;
}

type LoginMenuMode = "add" | "manage" | "check" | "open-config" | "cancel";

function toBase64Url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizeStoredAuthAccount(auth: StoredAuth & { type: "oauth" }): StoredAuth & { type: "oauth" } {
  const accountId = canonicalAccountId({
    accountId: auth.accountId,
    accessToken: auth.access,
    refreshToken: auth.refresh
  });

  return {
    ...auth,
    accountId
  };
}

function normalizeTokenRecord(record: TokenRecord): TokenRecord {
  const accountId = canonicalAccountId({
    accountId: record.accountId,
    accessToken: record.accessToken,
    refreshToken: record.refreshToken
  });

  return {
    ...record,
    accountId,
    enabled: record.enabled ?? true,
    createdAt: record.createdAt ?? Date.now(),
    lastUsedAt: record.lastUsedAt ?? Date.now(),
    label: canonicalAccountLabel(record.label, accountId)
  };
}

function mergeTokenRecords(left: TokenRecord, right: TokenRecord): TokenRecord {
  const preferred = left.expiresAt >= right.expiresAt ? left : right;
  const fallback = preferred === left ? right : left;

  const accountId = canonicalAccountId({
    accountId: preferred.accountId,
    accessToken: preferred.accessToken,
    refreshToken: preferred.refreshToken
  });

  return {
    ...preferred,
    accessToken: preferred.accessToken || fallback.accessToken,
    refreshToken: preferred.refreshToken || fallback.refreshToken,
    resourceUrl: preferred.resourceUrl || fallback.resourceUrl,
    accountId,
    enabled: preferred.enabled ?? true,
    createdAt: Math.min(left.createdAt ?? Date.now(), right.createdAt ?? Date.now()),
    lastUsedAt: Math.max(left.lastUsedAt ?? 0, right.lastUsedAt ?? 0),
    label: canonicalAccountLabel(preferred.label ?? fallback.label, accountId)
  };
}

function normalizeTokenRecords(records: TokenRecord[]): TokenRecord[] {
  const byAccountId = new Map<string, TokenRecord>();
  for (const record of records) {
    const normalized = normalizeTokenRecord(record);
    const existing = byAccountId.get(normalized.accountId);
    if (!existing) {
      byAccountId.set(normalized.accountId, normalized);
      continue;
    }

    byAccountId.set(normalized.accountId, mergeTokenRecords(existing, normalized));
  }

  return [...byAccountId.values()];
}

function formatRelativeAge(timestamp?: number): string {
  if (!timestamp || timestamp <= 0) {
    return "never";
  }

  const ageMs = Date.now() - timestamp;
  if (ageMs < 60_000) {
    return "just now";
  }
  if (ageMs < 3_600_000) {
    return `${Math.round(ageMs / 60_000)}m ago`;
  }
  if (ageMs < 86_400_000) {
    return `${Math.round(ageMs / 3_600_000)}h ago`;
  }
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}

function summarizeStoredQuota(record: TokenRecord): string | null {
  const estimate = formatQuotaEstimate(record);
  const state = record.quotaState;
  if (!state || state === "ok") {
    return estimate;
  }

  const age = formatRelativeAge(record.quotaUpdatedAt);
  const message = record.quotaMessage?.trim();
  if (message) {
    return estimate
      ? `Quota signal (${state}, ${age}): ${message}; ${estimate}`
      : `Quota signal (${state}, ${age}): ${message}`;
  }

  if (state === "exhausted") {
    return estimate
      ? `Quota signal (${state}, ${age}): daily/free quota likely reached; ${estimate}`
      : `Quota signal (${state}, ${age}): daily/free quota likely reached`;
  }

  return estimate
    ? `Quota signal (${state}, ${age}): temporary throttling likely; ${estimate}`
    : `Quota signal (${state}, ${age}): temporary throttling likely`;
}

async function ensurePluginConfigExists(): Promise<string> {
  const configPath = getPluginConfigPath();
  try {
    await readFile(configPath, "utf8");
    return configPath;
  } catch {
    // continue and create default file
  }

  await mkdir(dirname(configPath), { recursive: true });
  const defaultPayload = {
    schedulingMode: "cache-first",
    maxCacheFirstWaitSeconds: 30,
    tokenBudgetPerAccount: 8,
    tokenRegenPerMinute: 2
  };
  await writeFile(configPath, `${JSON.stringify(defaultPayload, null, 2)}\n`, "utf8");
  return configPath;
}

export function getMenuAccountStorePath(): string {
  return join(dirname(getPluginConfigPath()), QWEN_MENU_ACCOUNT_STORE_FILE);
}

export async function loadMenuAccountRecords(): Promise<TokenRecord[]> {
  let nativeRecords: TokenRecord[] = [];
  try {
    const native = await loadTokens();
    if (Array.isArray(native)) {
      nativeRecords = native;
    }
  } catch {
    // fallback to menu-local store
  }

  let localRecords: TokenRecord[] = [];
  try {
    const path = getMenuAccountStorePath();
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { version?: number; tokens?: TokenRecord[] } | TokenRecord[];
    if (Array.isArray(parsed)) {
      localRecords = parsed;
    } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.tokens)) {
      localRecords = parsed.tokens;
    }
  } catch {
    // local fallback missing/unreadable
  }

  return normalizeTokenRecords([...nativeRecords, ...localRecords]);
}

export async function saveMenuAccountRecords(records: TokenRecord[]): Promise<void> {
  if (!Array.isArray(records)) {
    return;
  }

  const normalized = normalizeTokenRecords(records);

  let nativeSaved = false;
  try {
    await saveTokens(normalized);
    nativeSaved = true;
  } catch {
    // continue to local fallback
  }

  if (nativeSaved) {
    return;
  }

  const path = getMenuAccountStorePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ version: 1, tokens: normalized }, null, 2)}\n`,
    "utf8"
  );
}

async function promptLoginMode(tokens: TokenRecord[]): Promise<LoginMenuMode> {
  const promptLoginModeFallback = async (): Promise<LoginMenuMode> => {
    const rl = createInterface({ input, output });
    try {
      if (tokens.length > 0) {
        console.log(`\n${tokens.length} Qwen account(s) saved:`);
        for (let i = 0; i < tokens.length; i += 1) {
          const token = tokens[i];
          if (!token) continue;
          const label = token.label ?? token.accountId;
          const enabled = token.enabled === false ? "disabled" : "active";
          console.log(`  ${i + 1}. ${label} [${enabled}] used ${formatRelativeAge(token.lastUsedAt)}`);
        }
        console.log("");
      }

      while (true) {
        const answer = (await rl.question("(a)dd account, (m)anage accounts, (c)heck quotas, (o)pen config, (x) cancel [a/m/c/o/x]: "))
          .trim()
          .toLowerCase();

        if (answer === "a" || answer === "add") return "add";
        if (answer === "m" || answer === "manage") return "manage";
        if (answer === "c" || answer === "check") return "check";
        if (answer === "o" || answer === "open" || answer === "config") return "open-config";
        if (answer === "x" || answer === "cancel") return "cancel";
        console.log("Invalid option. Use a/m/c/o/x.");
      }
    } finally {
      rl.close();
    }
  };

  if (!isInteractiveTTY()) {
    return promptLoginModeFallback();
  }

  const accountRows = tokens.length
    ? tokens.map((token, idx) => {
        const label = token.label ?? token.accountId;
        const status = token.enabled === false ? "disabled" : "active";
        return {
          label: `${idx + 1}. ${label} [${status}]`,
          value: "cancel" as LoginMenuMode,
          kind: "heading" as const
        };
      })
    : [
        {
          label: "No accounts saved yet",
          value: "cancel" as LoginMenuMode,
          kind: "heading" as const
        }
      ];

  const action = await selectMenu<LoginMenuMode>(
    [
      { label: "Actions", value: "add", kind: "heading" },
      { label: "Add account", value: "add", color: "cyan" },
      { label: "Manage accounts", value: "manage", color: "cyan" },
      { label: "Check quotas", value: "check", color: "cyan" },
      { label: "Open config", value: "open-config", color: "cyan" },
      { label: "", value: "cancel", separator: true },
      { label: "Accounts", value: "cancel", kind: "heading" },
      ...accountRows,
      { label: "", value: "cancel", separator: true },
      { label: "Exit", value: "cancel", color: "red" }
    ],
    {
      title: "Qwen OAuth Login",
      subtitle:
        tokens.length > 0
          ? `${tokens.length} account(s) saved. Select an action.`
          : "No saved accounts yet. Add your first account.",
      clearScreen: true
    }
  );

  return action ?? promptLoginModeFallback();
}

async function promptManageAccounts(tokens: TokenRecord[]): Promise<TokenRecord[]> {
  if (tokens.length === 0) {
    return tokens;
  }

  const promptManageAccountsFallback = async (initial: TokenRecord[]): Promise<TokenRecord[]> => {
    if (!input.isTTY || !output.isTTY) {
      return initial;
    }

    const rl = createInterface({ input, output });
    let recordsFallback = [...initial];
    try {
      while (true) {
        console.log("\nAccounts:");
        for (let i = 0; i < recordsFallback.length; i += 1) {
          const token = recordsFallback[i];
          if (!token) continue;
          const label = token.label ?? token.accountId;
          const enabled = token.enabled === false ? "disabled" : "active";
          console.log(`  ${i + 1}. ${label} [${enabled}] used ${formatRelativeAge(token.lastUsedAt)}`);
        }
        console.log("\nActions: t <n> toggle, d <n> delete, q quit");

        const answer = (await rl.question("> ")).trim().toLowerCase();
        if (answer === "q" || answer === "quit") {
          return recordsFallback;
        }

        const [action, indexRaw] = answer.split(/\s+/);
        const index = Number(indexRaw) - 1;
        if (!Number.isInteger(index) || index < 0 || index >= recordsFallback.length) {
          console.log("Invalid account index.");
          continue;
        }

        if (action === "t" || action === "toggle") {
          recordsFallback = recordsFallback.map((token, idx) =>
            idx === index
              ? {
                  ...token,
                  enabled: token.enabled === false
                }
              : token
          );
          continue;
        }

        if (action === "d" || action === "delete") {
          recordsFallback = recordsFallback.filter((_, idx) => idx !== index);
          if (recordsFallback.length === 0) {
            console.log("All accounts removed.");
            return recordsFallback;
          }
          continue;
        }

        console.log("Unknown action.");
      }
    } finally {
      rl.close();
    }
  };

  if (!isInteractiveTTY()) {
    return promptManageAccountsFallback(tokens);
  }

  let records = [...tokens];

  while (true) {
    const accountItems = records.map((token, idx) => {
      const label = token.label ?? token.accountId;
      const status = token.enabled === false ? "disabled" : "active";
      return {
        label: `${idx + 1}. ${label} [${status}]`,
        hint: `used ${formatRelativeAge(token.lastUsedAt)}`,
        value: { type: "account" as const, index: idx }
      };
    });

    const selected = await selectMenu<{ type: "account"; index: number } | { type: "back" }>(
      [
        { label: "Accounts", value: { type: "back" }, kind: "heading" },
        ...accountItems,
        { label: "", value: { type: "back" }, separator: true },
        { label: "Back", value: { type: "back" }, color: "yellow" }
      ],
      {
        title: "Manage Qwen Accounts",
        subtitle: "Select an account to toggle or delete",
        clearScreen: true
      }
    );

    if (!selected || selected.type === "back") {
      return records;
    }

    const current = records[selected.index];
    if (!current) {
      continue;
    }

    const accountLabel = current.label ?? current.accountId;
    const accountAction = await selectMenu<"back" | "toggle" | "delete">(
      [
        { label: "Actions", value: "back", kind: "heading" },
        {
          label: current.enabled === false ? "Enable account" : "Disable account",
          value: "toggle",
          color: current.enabled === false ? "green" : "yellow"
        },
        { label: "Delete account", value: "delete", color: "red" },
        { label: "", value: "back", separator: true },
        { label: "Back", value: "back" }
      ],
      {
        title: accountLabel,
        subtitle: `Last used ${formatRelativeAge(current.lastUsedAt)}`,
        clearScreen: true
      }
    );

    if (!accountAction || accountAction === "back") {
      continue;
    }

    if (accountAction === "toggle") {
      records = records.map((token, idx) =>
        idx === selected.index
          ? {
              ...token,
              enabled: token.enabled === false
            }
          : token
      );
      continue;
    }

    if (accountAction === "delete") {
      const confirmed = await confirmMenu(`Delete ${accountLabel}?`);
      if (!confirmed) {
        continue;
      }
      records = records.filter((_, idx) => idx !== selected.index);
      if (records.length === 0) {
        return records;
      }
    }
  }
}

async function checkAllQuotas(records: TokenRecord[]): Promise<TokenRecord[]> {
  if (records.length === 0) {
    console.log("No accounts available for quota check.");
    return records;
  }

  const updated = [...records];
  console.log("\nChecking quotas...\n");
  for (const [idx, account] of records.entries()) {
    const label = account.label ?? account.accountId;
    const disabled = account.enabled === false ? " [disabled]" : "";

    let accessToken = account.accessToken;
    let expiresAt = account.expiresAt;
    let refreshToken = account.refreshToken;
    let resourceUrl = account.resourceUrl;

    if (expiresAt <= Date.now() + 60_000 && refreshToken) {
      try {
        const release = await acquireRefreshLock();
        try {
          const reReadRecords = await loadMenuAccountRecords();
          const freshRecord = reReadRecords.find(
            (r) => r.accountId === account.accountId && r.enabled !== false && r.expiresAt > Date.now() + 60_000
          );
          if (freshRecord) {
            accessToken = freshRecord.accessToken;
            expiresAt = freshRecord.expiresAt;
            refreshToken = freshRecord.refreshToken;
            resourceUrl = freshRecord.resourceUrl;
          } else {
            const refreshed = await refreshOAuthToken({
              type: "oauth",
              access: accessToken,
              refresh: refreshToken,
              expires: expiresAt,
              accountId: account.accountId,
              resourceUrl
            });
            accessToken = refreshed.access;
            expiresAt = refreshed.expires;
            refreshToken = refreshed.refresh;
            resourceUrl = refreshed.resourceUrl;
          }
        } finally {
          await release();
        }
        const existing = updated[idx];
        if (existing) {
          updated[idx] = {
            ...existing,
            accessToken,
            refreshToken,
            expiresAt,
            resourceUrl,
            lastUsedAt: Date.now()
          };
        }
      } catch {
        // fall through with possibly stale token
      }
    }

    let rendered = "Quota: unavailable via public endpoint";
    try {
      const snapshot = await queryQuota(normalizeBaseUrl(resourceUrl), accessToken);
      rendered = formatQuota(snapshot);
      if (
        snapshot &&
        (snapshot.remainingPerDay !== undefined ||
          snapshot.limitPerDay !== undefined ||
          snapshot.remainingPerMinute !== undefined ||
          snapshot.limitPerMinute !== undefined)
      ) {
        const existing = updated[idx];
        if (existing) {
          updated[idx] = {
            ...existing,
            quotaState: "ok",
            quotaMessage: rendered,
            quotaUpdatedAt: Date.now()
          };
        }
      }
    } catch {
      // Keep unavailable message.
    }

    const storedSignal = summarizeStoredQuota(account);

    console.log(`${idx + 1}. ${label}${disabled}`);
    console.log(`   ${rendered}`);
    if (storedSignal) {
      console.log(`   ${storedSignal}`);
    }
  }
  console.log("");
  return updated;
}

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = toBase64Url(randomBytes(48));
  const codeChallenge = toBase64Url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function normalizeBaseUrl(resourceUrl?: string): string {
  const raw = (resourceUrl ?? QWEN_DEFAULT_BASE_URL).trim();
  const withProtocol = raw.startsWith("http") ? raw : `https://${raw}`;
  return withProtocol.endsWith("/v1") ? withProtocol : `${withProtocol}/v1`;
}

function isOauthAuth(auth: StoredAuth): auth is StoredAuth & { type: "oauth" } {
  return auth.type === "oauth";
}

async function postForm(url: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      ...headers
    },
    body: new URLSearchParams(body).toString()
  });
}

async function requestDeviceAuthorization(codeChallenge: string): Promise<DeviceAuthorizationData> {
  const response = await postForm(
    QWEN_OAUTH_DEVICE_CODE_ENDPOINT,
    {
      client_id: QWEN_OAUTH_CLIENT_ID,
      scope: QWEN_OAUTH_SCOPE,
      code_challenge: codeChallenge,
      code_challenge_method: "S256"
    },
    {
      "x-request-id": randomUUID()
    }
  );

  if (!response.ok) {
    throw new Error(`Qwen device authorization failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as DeviceAuthorizationData;
}

async function pollDeviceToken(deviceCode: string, codeVerifier: string, expiresInSeconds: number): Promise<OAuthSuccess | OAuthFailure> {
  const deadline = Date.now() + Math.max(expiresInSeconds * 1000, 5 * 60 * 1000);
  let pollIntervalMs = 5_000;

  while (Date.now() < deadline) {
    const response = await postForm(QWEN_OAUTH_TOKEN_ENDPOINT, {
      grant_type: QWEN_OAUTH_GRANT_TYPE,
      client_id: QWEN_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      code_verifier: codeVerifier
    });

    const payloadText = await response.text();
    let payload: DeviceTokenPending & DeviceTokenSuccess = {};
    try {
      payload = JSON.parse(payloadText) as DeviceTokenPending & DeviceTokenSuccess;
    } catch {
      payload = {};
    }

    if (!response.ok) {
      const oauthError = payload.error ?? "";
      if (response.status === 400 && (oauthError === "authorization_pending" || oauthError === "slow_down")) {
        if (oauthError === "slow_down") {
          pollIntervalMs += 5_000;
        }
        await sleep(pollIntervalMs);
        continue;
      }
      return { type: "failed" };
    }

    if (payload.status === "pending") {
      if (payload.slowDown) {
        pollIntervalMs += 5_000;
      }
      await sleep(pollIntervalMs);
      continue;
    }

    if (!payload.access_token) {
      await sleep(pollIntervalMs);
      continue;
    }

    return {
      type: "success",
      provider: QWEN_PROVIDER_ID,
      access: payload.access_token,
      refresh: payload.refresh_token ?? payload.access_token,
      expires: Date.now() + (payload.expires_in ?? 3600) * 1000,
      resourceUrl: payload.resource_url
    };
  }

  return { type: "failed" };
}

async function refreshOAuthToken(auth: StoredAuth & { type: "oauth" }): Promise<StoredAuth & { type: "oauth" }> {
  const response = await postForm(QWEN_OAUTH_TOKEN_ENDPOINT, {
    grant_type: "refresh_token",
    refresh_token: auth.refresh,
    client_id: QWEN_OAUTH_CLIENT_ID
  });

  if (!response.ok) {
    let details = "";
    let oauthError = "";
    try {
      const raw = await response.text();
      if (raw.trim()) {
        details = `: ${raw.slice(0, 300)}`;
        try {
          const parsed = JSON.parse(raw) as { error?: string };
          oauthError = parsed.error ?? "";
        } catch {
          // Not JSON, details already captured.
        }
      }
    } catch {
      // Keep fallback error text.
    }

    if (oauthError === "invalid_grant" || oauthError === "invalid_token") {
      throw new PluginError(
        ERROR_CODES.REFRESH_UPSTREAM_REJECTED,
        `Qwen OAuth refresh token was already used or invalidated (concurrent refresh race).${details}`,
        { oauthError, accountId: auth.accountId }
      );
    }

    throw new PluginError(
      ERROR_CODES.REFRESH_UPSTREAM_REJECTED,
      `Qwen OAuth refresh failed: ${response.status} ${response.statusText}${details}`
    );
  }

  const payload = (await response.json()) as DeviceTokenSuccess;
  if (!payload.access_token) {
    throw new PluginError(ERROR_CODES.REFRESH_UPSTREAM_REJECTED, "Qwen OAuth refresh returned no access token");
  }

  return {
    type: "oauth",
    access: payload.access_token,
    refresh: payload.refresh_token ?? auth.refresh,
    expires: Date.now() + (payload.expires_in ?? 3600) * 1000,
    accountId: auth.accountId,
    resourceUrl: payload.resource_url ?? auth.resourceUrl
  };
}

function isInvalidGrantError(error: unknown): boolean {
  return error instanceof PluginError
    && error.code === ERROR_CODES.REFRESH_UPSTREAM_REJECTED
    && Boolean(error.details?.oauthError);
}

function modelFromId(id: string, baseUrl: string): ProviderModel {
  return {
    id,
    providerID: QWEN_PROVIDER_ID,
    name: id,
    family: "qwen",
    api: {
      id,
      url: baseUrl,
      npm: "@ai-sdk/openai-compatible"
    },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 262_144, output: 16_384 },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false
    },
    release_date: ""
  };
}

function defaultQwenModels(baseUrl: string): Record<string, ProviderModel> {
  const defaults = ["coder-model", "qwen3-coder-plus", "qwen3-coder-flash"];
  const models: Record<string, ProviderModel> = {};
  for (const id of defaults) {
    models[id] = modelFromId(id, baseUrl);
  }
  return models;
}

function mapModelsToBaseUrl(models: Record<string, ProviderModel>, baseUrl: string): Record<string, ProviderModel> {
  const mapped: Record<string, ProviderModel> = {};
  for (const [id, model] of Object.entries(models)) {
    mapped[id] = {
      ...model,
      api: {
        ...model.api,
        id,
        url: baseUrl,
        npm: "@ai-sdk/openai-compatible"
      },
      providerID: QWEN_PROVIDER_ID,
      id,
      name: model.name || id
    };
  }
  return mapped;
}

function addEphemeralCacheControl(content: string | QwenChatContentPart[]): QwenChatContentPart[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content, cache_control: { type: "ephemeral" } }];
  }

  if (content.length === 0) {
    return [{ type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } }];
  }

  const cloned = content.map((part) => ({ ...part }));
  const lastIndex = cloned.length - 1;
  cloned[lastIndex] = {
    ...cloned[lastIndex],
    cache_control: { type: "ephemeral" }
  };

  return cloned;
}

function normalizeQwenChatBody(rawBody: string): string {
  let parsed: QwenChatCompletionBody;
  try {
    parsed = JSON.parse(rawBody) as QwenChatCompletionBody;
  } catch {
    return rawBody;
  }

  const messages = Array.isArray(parsed.messages) ? [...parsed.messages] : [];
  const systemIndex = messages.findIndex((message) => message.role === "system");

  if (systemIndex === -1) {
    messages.unshift({
      role: "system",
      content: [{ type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } }]
    });
  } else {
    const systemMessage = { ...messages[systemIndex] };
    const existing = systemMessage.content;
    if (typeof existing === "string") {
      systemMessage.content = addEphemeralCacheControl(existing);
    } else if (Array.isArray(existing)) {
      systemMessage.content = addEphemeralCacheControl(existing);
    } else {
      systemMessage.content = [{ type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } }];
    }
    messages[systemIndex] = systemMessage;
  }

  return JSON.stringify({
    ...parsed,
    messages
  });
}

async function loadQwenModelsFromApi(baseUrl: string, accessToken: string): Promise<Record<string, ProviderModel>> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Qwen model list request failed: ${response.status}`);
  }

  const payload = (await response.json()) as QwenModelListResponse;
  const entries = payload.data ?? [];
  const models: Record<string, ProviderModel> = {};
  for (const item of entries) {
    const id = item.id?.trim();
    if (!id) {
      continue;
    }
    models[id] = modelFromId(id, baseUrl);
  }

  return Object.keys(models).length > 0 ? models : defaultQwenModels(baseUrl);
}

async function probeQwenModels(baseUrl: string, accessToken: string): Promise<Record<string, ProviderModel>> {
  const aliasCandidates = ["coder-model", "qwen3-coder-plus", "qwen3-coder-flash"];
  const qwenUserAgent = `QwenCode/1.0.0 (${process.platform}; ${process.arch})`;
  const discovered = new Set<string>();

  for (const alias of aliasCandidates) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": qwenUserAgent,
        "X-DashScope-CacheControl": "enable",
        "X-DashScope-UserAgent": qwenUserAgent,
        "X-DashScope-AuthType": "qwen-oauth"
      },
      body: JSON.stringify({
        model: alias,
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: "You are a helpful assistant.",
                cache_control: { type: "ephemeral" }
              }
            ]
          },
          {
            role: "user",
            content: "ping"
          }
        ],
        max_tokens: 8,
        stream: false
      })
    });

    if (!response.ok) {
      continue;
    }

    discovered.add(alias);
    const payload = (await response.json()) as QwenChatCompletionResponse;
    const canonical = payload.model?.trim();
    if (canonical) {
      discovered.add(canonical);
    }
  }

  const models: Record<string, ProviderModel> = {};
  for (const id of discovered) {
    models[id] = modelFromId(id, baseUrl);
  }
  return models;
}

function classifyRetry(input: ToolExecuteInput): "A" | "B" | "C" {
  const method = String(input.args.method ?? "GET").toUpperCase();
  if (["GET", "HEAD", "OPTIONS", "DELETE"].includes(method)) {
    return "A";
  }

  if (["POST", "PATCH", "PUT"].includes(method)) {
    return "B";
  }

  return "C";
}

function getIdempotencyKey(input: ToolExecuteInput): string | undefined {
  const headers = (input.args.headers as Record<string, string> | undefined) ?? {};
  return headers["Idempotency-Key"] ?? headers["idempotency-key"];
}

interface RetryExecutorResult {
  status: number;
}

function getServiceKey(input: ToolExecuteInput): string {
  const rawUrl = String(input.args.url ?? "");
  try {
    return new URL(rawUrl).host || "qwen-default";
  } catch {
    return "qwen-default";
  }
}

function parseRetryAfterMs(response: Response): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const timestamp = Date.parse(retryAfter);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }

  const diff = timestamp - Date.now();
  return diff > 0 ? diff : undefined;
}

function toTokenRecord(auth: StoredAuth & { type: "oauth" }): TokenRecord {
  const accountId = canonicalAccountId({
    accountId: auth.accountId,
    accessToken: auth.access,
    refreshToken: auth.refresh
  });
  return {
    accountId,
    accessToken: auth.access,
    refreshToken: auth.refresh,
    expiresAt: auth.expires,
    resourceUrl: auth.resourceUrl,
    enabled: true,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    label: canonicalAccountLabel(auth.accountId, accountId)
  };
}

function fromTokenRecord(token: TokenRecord): StoredAuth & { type: "oauth" } {
  return {
    type: "oauth",
    access: token.accessToken,
    refresh: token.refreshToken ?? token.accessToken,
    expires: token.expiresAt,
    accountId: token.accountId,
    resourceUrl: token.resourceUrl
  };
}

export const QwenOauthPlugin: PluginFactory = async (ctx) => {
  const policy: RetryPolicy = DEFAULT_CONFIG.retry;
  const budget = new RetryBudget(
    policy.budget.capacity,
    policy.budget.refillPerSecond,
    policy.budget.windowSeconds
  );
  const breakerRegistry = new CircuitBreakerRegistry(policy.breaker, (nextState) => {
    incrementCounter(`breaker.transition.${nextState}`);
  });
  const auth = new AuthManager({ coordinator: new RefreshCoordinator() });
  const accountPool = new AccountPool({
    defaultCooldownMs: 45_000,
    maxTokens: DEFAULT_CONFIG.tokenBudgetPerAccount,
    regenPerMinute: DEFAULT_CONFIG.tokenRegenPerMinute
  });
  const modelCache = new ModelCache({ ttlMs: 10 * 60_000, staleMs: 60 * 60_000 });
  let authCache: (StoredAuth & { type: "oauth" }) | undefined;
  let refreshInFlight: Promise<StoredAuth & { type: "oauth" }> | undefined;
  let localPoolHydration: Promise<void> | undefined;

  async function persistTokenRecord(record: TokenRecord): Promise<void> {
    const existing = await loadMenuAccountRecords();
    const deduped = existing.filter((item) => item.accountId !== record.accountId);
    deduped.push({
      ...record,
      enabled: record.enabled ?? true,
      createdAt: record.createdAt ?? Date.now(),
      lastUsedAt: Date.now(),
      label: record.label ?? record.accountId
    });
    await saveMenuAccountRecords(deduped);
  }

  async function persistQuotaTelemetry(
    accountId: string,
    status: number,
    signal?: { text: string; kind: "throttled" | "exhausted" }
  ): Promise<void> {
    const existing = await loadMenuAccountRecords();
    const updated = existing.map((item) => {
      if (item.accountId !== accountId) {
        return item;
      }

      const estimated = applyQuotaEstimate(item, status, signal?.kind);
      return {
        ...estimated,
        quotaState: signal?.kind ?? estimated.quotaState,
        quotaMessage: signal?.text ?? estimated.quotaMessage,
        quotaUpdatedAt: signal ? Date.now() : estimated.quotaUpdatedAt
      };
    });

    await saveMenuAccountRecords(updated);
  }

  async function disableAccountRecord(accountId: string): Promise<void> {
    const existing = await loadMenuAccountRecords();
    const updated = existing.map((item) => {
      if (item.accountId !== accountId) {
        return item;
      }

      return {
        ...item,
        enabled: false,
        lastUsedAt: Date.now()
      };
    });

    await saveMenuAccountRecords(updated);
  }

  async function hydratePoolFromLocalStore(): Promise<void> {
    if (!localPoolHydration) {
      localPoolHydration = (async () => {
        const records = await loadMenuAccountRecords();
        accountPool.importTokenRecords(records);
      })();
    }

    await localPoolHydration;
  }

  async function resolvePluginAuth(getAuth: () => Promise<StoredAuth>): Promise<StoredAuth & { type: "oauth" }> {
    const now = () => Date.now();
    const hasUsableAccess = (auth: StoredAuth & { type: "oauth" }): boolean =>
      Boolean(auth.access && auth.access.trim().length > 0 && auth.expires > now() + 60_000);

    const persistAuthBestEffort = async (auth: StoredAuth & { type: "oauth" }): Promise<void> => {
      try {
        await persistTokenRecord(toTokenRecord(auth));
      } catch {
        // Best effort only.
      }
    };

    const getLocalFreshAuthCandidate = async (
      preferredAccountId?: string
    ): Promise<(StoredAuth & { type: "oauth" }) | undefined> => {
      const records = await loadMenuAccountRecords();
      const enabled = records.filter((record) => record.enabled !== false);
      const now = Date.now();

      let candidate: TokenRecord | undefined;
      if (preferredAccountId) {
        candidate = enabled.find(
          (record) => record.accountId === preferredAccountId && record.expiresAt > now + 60_000
        );
      }

      if (!candidate) {
        candidate = enabled.find((record) => record.expiresAt > now + 60_000);
      }

      if (!candidate) {
        return undefined;
      }

      const canonical = canonicalAccountId({
        accountId: candidate.accountId,
        accessToken: candidate.accessToken,
        refreshToken: candidate.refreshToken
      });

      return {
        type: "oauth",
        access: candidate.accessToken,
        refresh: candidate.refreshToken ?? candidate.accessToken,
        expires: candidate.expiresAt,
        accountId: canonical,
        resourceUrl: candidate.resourceUrl
      };
    };

    const live = await getAuth();
    if (!isOauthAuth(live)) {
      throw new PluginError(ERROR_CODES.AUTH_INVALID_CREDENTIALS, "QwenCode provider requires OAuth credentials");
    }

    const normalizedLive = normalizeStoredAuthAccount(live);

    if (
      !authCache
      || authCache.access !== normalizedLive.access
      || authCache.refresh !== normalizedLive.refresh
      || authCache.accountId !== normalizedLive.accountId
    ) {
      authCache = normalizedLive;
      accountPool.importStoredAuth(normalizedLive);
    }

    const currentAuth = authCache ?? normalizedLive;

    if (hasUsableAccess(currentAuth)) {
      await persistAuthBestEffort(currentAuth);
      return currentAuth;
    }

    const localFreshBeforeRefresh = await getLocalFreshAuthCandidate(currentAuth.accountId);
    if (localFreshBeforeRefresh) {
      authCache = localFreshBeforeRefresh;
      accountPool.importStoredAuth(localFreshBeforeRefresh);
      return localFreshBeforeRefresh;
    }

    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        const release = await acquireRefreshLock();
        try {
          const reReadCandidate = await getLocalFreshAuthCandidate(currentAuth.accountId);
          if (reReadCandidate) {
            return reReadCandidate;
          }

          const reReadAuth = await getAuth();
          const candidate = isOauthAuth(reReadAuth) ? normalizeStoredAuthAccount(reReadAuth) : currentAuth;

          try {
            return normalizeStoredAuthAccount(await refreshOAuthToken(candidate));
          } catch (error) {
            if (isInvalidGrantError(error)) {
              const afterGrantFailure = await getLocalFreshAuthCandidate(currentAuth.accountId);
              if (afterGrantFailure) {
                return afterGrantFailure;
              }
            }
            throw error;
          }
        } finally {
          await release();
        }
      })().finally(() => {
        refreshInFlight = undefined;
      });
    }

    try {
      const refreshed = normalizeStoredAuthAccount(await refreshInFlight);
      authCache = refreshed;
      accountPool.importStoredAuth(refreshed);
      try {
        await persistTokenRecord(toTokenRecord(refreshed));
      } catch {
        // Keep runtime auth successful even if persistence fails.
      }
      return authCache ?? currentAuth;
    } catch {
      try {
        const latest = await getAuth();
        if (isOauthAuth(latest)) {
          const normalizedLatest = normalizeStoredAuthAccount(latest);
          if (hasUsableAccess(normalizedLatest)) {
            authCache = normalizedLatest;
            accountPool.importStoredAuth(normalizedLatest);
            await persistAuthBestEffort(normalizedLatest);
            return normalizedLatest;
          }
        }
      } catch {
        // Continue with local fallback check.
      }

      const localFreshAfterFailure = await getLocalFreshAuthCandidate(currentAuth.accountId);
      if (localFreshAfterFailure) {
        authCache = localFreshAfterFailure;
        accountPool.importStoredAuth(localFreshAfterFailure);
        await persistAuthBestEffort(localFreshAfterFailure);
        return localFreshAfterFailure;
      }

      throw new PluginError(
        ERROR_CODES.REFRESH_UPSTREAM_REJECTED,
        "Qwen OAuth refresh failed and no fresh local token was available. Re-authenticate with `opencode auth login`."
      );
    }
  }

  async function getPreferredAccount(getAuth: () => Promise<StoredAuth>): Promise<TokenRecord> {
    await hydratePoolFromLocalStore();
    const live = await resolvePluginAuth(getAuth);
    accountPool.importStoredAuth(live);

    const selected = accountPool.select(live.accountId) ?? accountPool.select();
    if (!selected) {
      return toTokenRecord(live);
    }

    if (selected.expiresAt > Date.now() + 60_000) {
      return {
        accountId: selected.accountId,
        accessToken: selected.accessToken,
        refreshToken: selected.refreshToken,
        expiresAt: selected.expiresAt,
        resourceUrl: selected.resourceUrl
      };
    }

    if (!selected.refreshToken) {
      return {
        accountId: selected.accountId,
        accessToken: selected.accessToken,
        refreshToken: selected.refreshToken,
        expiresAt: selected.expiresAt,
        resourceUrl: selected.resourceUrl
      };
    }

    const release = await acquireRefreshLock();
    try {
      const reReadRecords = await loadMenuAccountRecords();
      const reReadMatch = reReadRecords.find(
        (r) => r.accountId === selected.accountId && r.enabled !== false && r.expiresAt > Date.now() + 60_000
      );
      if (reReadMatch) {
        accountPool.replace({
          accountId: reReadMatch.accountId,
          accessToken: reReadMatch.accessToken,
          refreshToken: reReadMatch.refreshToken,
          expiresAt: reReadMatch.expiresAt,
          resourceUrl: reReadMatch.resourceUrl
        });
        return {
          accountId: reReadMatch.accountId,
          accessToken: reReadMatch.accessToken,
          refreshToken: reReadMatch.refreshToken,
          expiresAt: reReadMatch.expiresAt,
          resourceUrl: reReadMatch.resourceUrl
        };
      }

      try {
        const refreshed = await refreshOAuthToken(fromTokenRecord({
          accountId: selected.accountId,
          accessToken: selected.accessToken,
          refreshToken: selected.refreshToken,
          expiresAt: selected.expiresAt,
          resourceUrl: selected.resourceUrl
        }));
        const refreshedRecord = toTokenRecord(refreshed);
        accountPool.replace({
          accountId: refreshedRecord.accountId,
          accessToken: refreshedRecord.accessToken,
          refreshToken: refreshedRecord.refreshToken,
          expiresAt: refreshedRecord.expiresAt,
          resourceUrl: refreshedRecord.resourceUrl
        });
        try {
          await persistTokenRecord(refreshedRecord);
        } catch {
          // Non-fatal for request path.
        }
        return refreshedRecord;
      } catch (error) {
        if (isInvalidGrantError(error)) {
          const afterGrantFailure = await loadMenuAccountRecords();
          const freshRecord = afterGrantFailure.find(
            (r) => r.accountId === selected.accountId && r.enabled !== false && r.expiresAt > Date.now() + 60_000
          );
          if (freshRecord) {
            accountPool.replace({
              accountId: freshRecord.accountId,
              accessToken: freshRecord.accessToken,
              refreshToken: freshRecord.refreshToken,
              expiresAt: freshRecord.expiresAt,
              resourceUrl: freshRecord.resourceUrl
            });
            return {
              accountId: freshRecord.accountId,
              accessToken: freshRecord.accessToken,
              refreshToken: freshRecord.refreshToken,
              expiresAt: freshRecord.expiresAt,
              resourceUrl: freshRecord.resourceUrl
            };
          }

          try {
            await disableAccountRecord(selected.accountId);
          } catch {
            // Best effort only.
          }

          throw new PluginError(
            ERROR_CODES.REFRESH_UPSTREAM_REJECTED,
            "Qwen OAuth refresh token is no longer valid for this account. Re-authenticate with `opencode auth login`.",
            { accountId: selected.accountId }
          );
        }

        const fallbackRecords = await loadMenuAccountRecords();
        const fallbackFresh = fallbackRecords.find(
          (r) => r.accountId === selected.accountId && r.enabled !== false && r.expiresAt > Date.now() + 60_000
        );
        if (fallbackFresh) {
          accountPool.replace({
            accountId: fallbackFresh.accountId,
            accessToken: fallbackFresh.accessToken,
            refreshToken: fallbackFresh.refreshToken,
            expiresAt: fallbackFresh.expiresAt,
            resourceUrl: fallbackFresh.resourceUrl
          });
          return {
            accountId: fallbackFresh.accountId,
            accessToken: fallbackFresh.accessToken,
            refreshToken: fallbackFresh.refreshToken,
            expiresAt: fallbackFresh.expiresAt,
            resourceUrl: fallbackFresh.resourceUrl
          };
        }

        accountPool.markFailure(selected.accountId, 30_000);
        return {
          accountId: selected.accountId,
          accessToken: selected.accessToken,
          refreshToken: selected.refreshToken,
          expiresAt: selected.expiresAt,
          resourceUrl: selected.resourceUrl
        };
      }
    } finally {
      await release();
    }
  }

  return {
    auth: {
      provider: QWEN_PROVIDER_ID,
      async loader(getAuth) {
        const current = await getPreferredAccount(getAuth);
        const baseURL = normalizeBaseUrl(current.resourceUrl);
        const qwenUserAgent = `QwenCode/1.0.0 (${process.platform}; ${process.arch})`;

        return {
          apiKey: "QWEN_OAUTH_DYNAMIC_TOKEN",
          baseURL,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const selected = await getPreferredAccount(getAuth);
            const method = String(init?.method ?? "GET").toUpperCase();
            const targetUrl =
              typeof requestInput === "string"
                ? requestInput
                : requestInput instanceof URL
                  ? requestInput.toString()
                  : requestInput.url;

            const headers = new Headers(
              requestInput instanceof Request
                ? requestInput.headers
                : init?.headers
            );

            headers.set("Authorization", `Bearer ${selected.accessToken}`);

            // Qwen OAuth on portal requires these headers for chat completions.
            if (targetUrl.includes("/chat/completions")) {
              headers.set("User-Agent", qwenUserAgent);
              headers.set("X-DashScope-CacheControl", "enable");
              headers.set("X-DashScope-UserAgent", qwenUserAgent);
              headers.set("X-DashScope-AuthType", "qwen-oauth");
            }

            let body = init?.body;
            if (method === "POST" && targetUrl.includes("/chat/completions") && typeof body === "string") {
              body = normalizeQwenChatBody(body);
            }

            const response = await fetch(requestInput, {
              ...init,
              headers,
              body
            });

            try {
              const signal = await detectQuotaSignal(response, "chat");
              const formatted = formatQuotaSignal(signal);
              await persistQuotaTelemetry(
                selected.accountId,
                response.status,
                signal && formatted ? { text: formatted, kind: signal.kind } : undefined
              );
            } catch {
              // Do not block normal request handling on quota signal parsing.
            }

            if (!RETRYABLE_STATUS.has(response.status)) {
              accountPool.markSuccess(selected.accountId);
              return response;
            }

            const retryAfterMs = parseRetryAfterMs(response);
            if (
              DEFAULT_CONFIG.schedulingMode === "cache-first" &&
              retryAfterMs !== undefined &&
              retryAfterMs <= DEFAULT_CONFIG.maxCacheFirstWaitSeconds * 1000
            ) {
              await sleep(retryAfterMs);
              const retrySame = await fetch(requestInput, {
                ...init,
                headers,
                body
              });

              try {
                const signal = await detectQuotaSignal(retrySame, "chat-retry-same");
                const formatted = formatQuotaSignal(signal);
                await persistQuotaTelemetry(
                  selected.accountId,
                  retrySame.status,
                  signal && formatted ? { text: formatted, kind: signal.kind } : undefined
                );
              } catch {
                // Non-fatal for request path.
              }

              if (!RETRYABLE_STATUS.has(retrySame.status)) {
                accountPool.markSuccess(selected.accountId);
              } else {
                accountPool.markFailure(selected.accountId, parseRetryAfterMs(retrySame));
              }
              return retrySame;
            }

            accountPool.markFailure(selected.accountId, retryAfterMs);
            const fallback = accountPool.select();
            if (!fallback || fallback.accountId === selected.accountId) {
              return response;
            }

            const retryHeaders = new Headers(headers);
            retryHeaders.set("Authorization", `Bearer ${fallback.accessToken}`);
            const replay = await fetch(requestInput, {
              ...init,
              headers: retryHeaders,
              body
            });

            try {
              const signal = await detectQuotaSignal(replay, "chat-replay");
              const formatted = formatQuotaSignal(signal);
              await persistQuotaTelemetry(
                fallback.accountId,
                replay.status,
                signal && formatted ? { text: formatted, kind: signal.kind } : undefined
              );
            } catch {
              // Non-fatal for request path.
            }

            if (RETRYABLE_STATUS.has(replay.status)) {
              accountPool.markFailure(fallback.accountId, parseRetryAfterMs(replay));
            } else {
              accountPool.markSuccess(fallback.accountId);
            }

            return replay;
          }
        };
      },
      methods: [
        {
          type: "oauth",
          label: "QwenCode OAuth (Device Flow + Quota Check)",
          async authorize(inputs) {
            if (inputs) {
              let records: TokenRecord[] = [];
              records = await loadMenuAccountRecords();

              while (true) {
                const mode = await promptLoginMode(records);
                if (mode === "add") {
                  break;
                }

                if (mode === "cancel") {
                  return {
                    method: "auto",
                    url: "",
                    instructions: "Login canceled.",
                    callback: async () => ({ type: "failed" })
                  };
                }

                if (mode === "open-config") {
                  const configPath = await ensurePluginConfigExists();
                  console.log(`\nPlugin config: ${configPath}\n`);
                  continue;
                }

                if (mode === "manage") {
                  const managed = await promptManageAccounts(records);
                  records = managed;
                  try {
                    await saveMenuAccountRecords(records);
                  } catch {
                    // best effort only
                  }
                  continue;
                }

                if (mode === "check") {
                  records = await checkAllQuotas(records);
                  try {
                    await saveMenuAccountRecords(records);
                  } catch {
                    // best effort only
                  }
                  continue;
                }
              }
            }

            const { codeVerifier, codeChallenge } = generatePKCE();
            const device = await requestDeviceAuthorization(codeChallenge);
            const url = device.verification_uri_complete ?? device.verification_uri;
            let quotaInfo = "Quota: unavailable (log in first or endpoint unsupported)";

            try {
              const records = await loadMenuAccountRecords();
              if (records.length > 0) {
                const latest = [...records].sort((a, b) => b.expiresAt - a.expiresAt)[0];
                const snapshot = await queryQuota(normalizeBaseUrl(latest.resourceUrl), latest.accessToken);
                quotaInfo = formatQuota(snapshot);
              }
            } catch {
              // Ignore quota probe failures to keep auth flow fast.
            }

            return {
              method: "auto",
              url,
              instructions: `Enter code: ${device.user_code}\n${quotaInfo}`,
              callback: async () => {
                const result = await pollDeviceToken(device.device_code, codeVerifier, device.expires_in);
                if (result.type === "success") {
                  const accountId = canonicalAccountId({
                    accountId: result.accountId,
                    accessToken: result.access,
                    refreshToken: result.refresh
                  });
                  const record: TokenRecord = {
                    accountId,
                    accessToken: result.access,
                    refreshToken: result.refresh,
                    expiresAt: result.expires,
                    resourceUrl: result.resourceUrl,
                    enabled: true,
                    createdAt: Date.now(),
                    lastUsedAt: Date.now(),
                    label: canonicalAccountLabel(result.accountId, accountId)
                  };
                  accountPool.importTokenRecords([record]);
                  try {
                    await persistTokenRecord(record);
                  } catch {
                    // Non-fatal: OAuth success still returns to host.
                  }
                }
                return result;
              }
            };
          }
        }
      ]
    },

    provider: {
      id: QWEN_PROVIDER_ID,
      async models(provider, context) {
        await hydratePoolFromLocalStore();
        const oauth = context.auth;
        if (!oauth || oauth.type !== "oauth") {
          return Object.keys(provider.models).length > 0
            ? provider.models
            : defaultQwenModels(QWEN_DEFAULT_BASE_URL);
        }

        const normalizedOauth = normalizeStoredAuthAccount(oauth);
        accountPool.importStoredAuth(normalizedOauth);
        const selected = accountPool.select(normalizedOauth.accountId) ?? accountPool.select();
        const accessToken = selected?.accessToken ?? oauth.access;
        const baseUrl = normalizeBaseUrl(selected?.resourceUrl ?? normalizedOauth.resourceUrl);
        const cacheKey = `${selected?.accountId ?? normalizedOauth.accountId}:${baseUrl}`;
        const cached = modelCache.getFresh(cacheKey);
        if (cached) {
          return cached;
        }

        try {
          const fetched = await loadQwenModelsFromApi(baseUrl, accessToken);
          modelCache.set(cacheKey, fetched);
          if (selected) {
            accountPool.markSuccess(selected.accountId);
          }
          return fetched;
        } catch {
          if (selected) {
            accountPool.markFailure(selected.accountId, 20_000);
          }
          try {
            const probed = await probeQwenModels(baseUrl, accessToken);
            if (Object.keys(probed).length > 0) {
              modelCache.set(cacheKey, probed);
              return probed;
            }
          } catch {
            // fall through to config/default fallback
          }

          const stale = modelCache.getStale(cacheKey);
          if (stale) {
            return stale;
          }

          const fallback = Object.keys(provider.models).length > 0
            ? provider.models
            : defaultQwenModels(baseUrl);
          return mapModelsToBaseUrl(fallback, baseUrl);
        }
      }
    },

    event: async ({ event }) => {
      if (event.type === "server.connected") {
        await auth.failIfHeadlessWithoutSupport();
        const version = process.env.OPENCODE_VERSION ?? "0.14.0";
        let compat;
        try {
          compat = await enforceCompatibility(BUNDLED_COMPATIBILITY_MATRIX, version);
        } catch (error) {
          if (error instanceof PluginError && error.code === ERROR_CODES.COMPAT_VERSION_UNSUPPORTED) {
            process.exitCode = 78;
          }
          throw error;
        }
        await logInfo(ctx.client?.app?.log, compat.message, { version, severity: compat.severity });
      }
    },

    "tool.execute.before": async (input: ToolExecuteInput, output: ToolExecuteOutput) => {
      if (input.tool !== "fetch") {
        return;
      }

      await auth.failIfHeadlessWithoutSupport();
      const serviceKey = getServiceKey(input);
      const breaker = breakerRegistry.forService(serviceKey);
      breaker.check();

      const retryClass = classifyRetry(input);
      const idempotencyKey = getIdempotencyKey(input);
      const maxAttempts = maxAttemptsForClass(policy, retryClass);

      const token = await auth.getActiveToken();
      const headers = (output.args.headers as Record<string, string> | undefined) ?? {};
      headers.Authorization = `Bearer ${token.accessToken}`;
      output.args.headers = headers;

      output.args.retryMeta = {
        serviceKey,
        retryClass,
        maxAttempts,
        idempotencyKey
      };
    },

    "tool.execute.after": async (input: ToolExecuteInput, output: ToolExecuteOutput) => {
      if (input.tool !== "fetch") {
        return;
      }

      const serviceKey = getServiceKey(input);
      const breaker = breakerRegistry.forService(serviceKey);
      const status = Number(output.args.status ?? 0);
      if (!RETRYABLE_STATUS.has(status)) {
        breaker.success();
        incrementCounter("breaker.success");
        return;
      }

      breaker.failure();
      incrementCounter(`http.${status}`);
      incrementCounter("breaker.failure");
      const retryMeta = output.args.retryMeta as
        | {
            retryClass: "A" | "B" | "C";
            maxAttempts: number;
            serviceKey: string;
            idempotencyKey?: string;
          }
        | undefined;
      if (!retryMeta) {
        return;
      }

      if (retryMeta.maxAttempts > 1 && retryMeta.retryClass !== "A") {
        assertRetryAllowed(retryMeta.retryClass, retryMeta.idempotencyKey);
      }

      const retryExecutor = output.args.retryExecutor as
        | (() => Promise<RetryExecutorResult>)
        | undefined;

      for (let attempt = 2; attempt <= retryMeta.maxAttempts; attempt += 1) {
        breaker.check();
        incrementCounter(`retry.attempt.class.${retryMeta.retryClass}`);
        ensureBudgetToken(budget);

        const delay = fullJitterBackoff(
          policy.backoff.baseMs,
          policy.backoff.minMs,
          policy.backoff.maxMs,
          attempt
        );

        await sleep(delay);

        if (!retryExecutor) {
          continue;
        }

        const replay = await retryExecutor();
        if (!RETRYABLE_STATUS.has(Number(replay.status))) {
          breaker.success();
          incrementCounter("breaker.success");
          output.args.status = replay.status;
          return;
        }

        breaker.failure();
        incrementCounter(`http.${replay.status}`);
        incrementCounter("breaker.failure");
      }
    },

    "shell.env": async (input, output) => {
      output.env.QWEN_PLUGIN_PROJECT_ROOT = input.cwd;
    }
  };
};

export default QwenOauthPlugin;
