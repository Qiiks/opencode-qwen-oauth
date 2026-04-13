# opencode-qwen-oauth

OpenCode plugin for Qwen OAuth with robust retry, refresh, multi-account pooling, and compatibility policies.

## Install

### Via NPM (Recommended)

```bash
npm install opencode-qwen-oauth
# or
bun add opencode-qwen-oauth
# or
pnpm add opencode-qwen-oauth
```

Then add to your OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-qwen-oauth@latest"]
}
```

Run `opencode auth login` and select the Qwen OAuth option.

### From Source

```bash
git clone https://github.com/Qiiks/opencode-qwen-oauth.git
cd opencode-qwen-oauth/opencode-qwen-oauth
npm install
npm run build
```

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./path/to/opencode-qwen-oauth/dist/index.js"]
}
```

## Features

- **Qwen OAuth** with device flow + PKCE authentication
- **Multi-account pooling** with weighted rotation and automatic cooldown on `429/529`
- **Smart retry** with class-based idempotency (`A/B/C`), retry budget, full-jitter backoff, and circuit breaker
- **Model discovery** with local cache (TTL + stale fallback)
- **Quota probing** surfaced during OAuth login flow
- **Compatibility enforcement** against OpenCode version matrix
- **Structured logging** with secret redaction

## Key Defaults

- Retry attempts: `A=4`, `B=3` (requires idempotency key), `C=1`
- Retry budget: `capacity=120`, refill `2 tokens/sec`
- Circuit breaker: open at `10` failures within `30s`, cooldown `45s`, `3` half-open probes
- Backoff: full jitter, base `250ms`, floor `100ms`, cap `5000ms`
- Scheduling mode: `cache-first` (wait for same account when Retry-After is short)
- Token budget: per-account local budget with refill to avoid bursty 429 storms

## Configuration

### Environment Variables

- `QWEN_SCHEDULING_MODE=cache-first|balance`
- `QWEN_MAX_CACHE_FIRST_WAIT_SECONDS=30`
- `QWEN_TOKEN_BUDGET_PER_ACCOUNT=8`
- `QWEN_TOKEN_REGEN_PER_MINUTE=2`

### JSON Config (Preferred)

Located next to `opencode.json`:

- Linux/macOS: `~/.config/opencode/qwen-code-oauth.json`
- Windows: `C:\Users\<you>\.config\opencode\qwen-code-oauth.json`
- Override: `OPENCODE_CONFIG_DIR`

```json
{
  "schedulingMode": "cache-first",
  "maxCacheFirstWaitSeconds": 30,
  "tokenBudgetPerAccount": 8,
  "tokenRegenPerMinute": 2
}
```

Precedence: env vars > JSON config > built-in defaults.

## Multi-Account Management

The plugin includes an interactive account manager:

- **Add accounts**: Run `opencode auth login` → select Qwen OAuth → "Add account"
- **Manage accounts**: Enable/disable or delete saved accounts
- **Check quotas**: View quota status for all saved accounts

## Token Storage

- Native credential source checked first via `QWEN_NATIVE_TOKEN_STORE_JSON` bridge
- Encrypted file fallback (disabled by default):

```bash
export QWEN_ENABLE_ENCRYPTED_FALLBACK=1
export QWEN_TOKEN_ENCRYPTION_KEY="your-strong-key-material"
```

## Security

- Do not commit token files
- Use OS-protected paths and restricted permissions
- Logs are redacted by default for bearer/auth token patterns

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Limitations

- Quota endpoint availability depends on upstream API exposure
- Provider-side OAuth flow differences may require updates if upstream contracts change

## Troubleshooting

| Error | Solution |
|-------|----------|
| `E_AUTH_HEADLESS_UNSUPPORTED` | Run initial OAuth in an interactive terminal |
| `E_STORAGE_BACKEND_UNAVAILABLE` | Provide native token bridge or enable encrypted fallback |
| `E_COMPAT_VERSION_UNSUPPORTED` | Check `.omc/contracts/compatibility-matrix.json` and pin OpenCode version |
| Repeated `429/529` | Reduce concurrent load or add `retryExecutor` callback |

## License

MIT
