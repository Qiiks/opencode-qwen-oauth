export interface PluginContext {
  project?: { name?: string };
  directory?: string;
  worktree?: string;
  client?: {
    app?: {
      log?: (entry: { body: Record<string, unknown> }) => Promise<void>;
    };
  };
}

export interface ProviderModel {
  id: string;
  providerID?: string;
  name: string;
  family?: string;
  api: {
    id: string;
    url: string;
    npm: string;
  };
  limit: {
    context: number;
    output: number;
    input?: number;
  };
  capabilities: {
    toolcall: boolean;
    temperature: boolean;
    reasoning: boolean;
    attachment: boolean;
    input: {
      text: boolean;
      image: boolean;
      audio: boolean;
      video: boolean;
      pdf: boolean;
    };
    output: {
      text: boolean;
      image: boolean;
      audio: boolean;
      video: boolean;
      pdf: boolean;
    };
    interleaved: boolean;
  };
  status: "active" | "alpha" | "beta" | "deprecated";
  headers: Record<string, string>;
  options: Record<string, unknown>;
  cost: {
    input: number;
    output: number;
    cache: { read: number; write: number };
  };
  release_date: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  source: "env" | "config" | "custom" | "api";
  options: Record<string, unknown>;
  models: Record<string, ProviderModel>;
}

export type StoredAuth =
  | {
      type: "oauth";
      refresh: string;
      access: string;
      expires: number;
      accountId?: string;
      resourceUrl?: string;
    }
  | { type: "api"; key: string };

export type OAuthSuccess = {
  type: "success";
  provider?: string;
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
  resourceUrl?: string;
};

export type OAuthFailure = { type: "failed" };

export type OAuthAuthorize = {
  url: string;
  instructions: string;
  method: "auto";
  callback: () => Promise<OAuthSuccess | OAuthFailure>;
};

export interface AuthMethod {
  type: "oauth" | "api";
  label: string;
  authorize: (inputs?: Record<string, string>) => Promise<OAuthAuthorize>;
}

export interface AuthHook {
  provider: string;
  loader?: (
    getAuth: () => Promise<StoredAuth>,
    provider: ProviderInfo
  ) => Promise<Record<string, unknown>>;
  methods: AuthMethod[];
}

export interface ProviderHook {
  id: string;
  models?: (
    provider: ProviderInfo,
    ctx: { auth?: StoredAuth }
  ) => Promise<Record<string, ProviderModel>>;
}

export interface ToolExecuteInput {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolExecuteOutput {
  args: Record<string, unknown>;
}

export interface ShellEnvInput {
  cwd: string;
}

export interface ShellEnvOutput {
  env: Record<string, string>;
}

export interface PluginHooks {
  event?: (input: { event: { type: string; data?: unknown } }) => Promise<void>;
  auth?: AuthHook;
  provider?: ProviderHook;
  "tool.execute.before"?: (
    input: ToolExecuteInput,
    output: ToolExecuteOutput
  ) => Promise<void>;
  "tool.execute.after"?: (
    input: ToolExecuteInput,
    output: ToolExecuteOutput
  ) => Promise<void>;
  "shell.env"?: (input: ShellEnvInput, output: ShellEnvOutput) => Promise<void>;
}

export type PluginFactory = (ctx: PluginContext) => Promise<PluginHooks>;

export interface TokenRecord {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  accountId: string;
  resourceUrl?: string;
  enabled?: boolean;
  createdAt?: number;
  lastUsedAt?: number;
  label?: string;
  quotaState?: "ok" | "throttled" | "exhausted" | "unknown";
  quotaMessage?: string;
  quotaUpdatedAt?: number;
  quotaEstimate?: {
    windowStartedAt: number;
    windowMs: number;
    requests: number;
    successes: number;
    failures: number;
    throttled: number;
    exhausted: number;
    lastStatus?: number;
    lastUpdatedAt: number;
  };
}

export type RetryClass = "A" | "B" | "C";
