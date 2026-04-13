# opencode-qwen-oauth

[![npm version](https://img.shields.io/npm/v/opencode-qwen-auth-plugin.svg)](https://www.npmjs.com/package/opencode-qwen-auth-plugin)
[![npm downloads](https://img.shields.io/npm/dm/opencode-qwen-auth-plugin.svg)](https://www.npmjs.com/package/opencode-qwen-auth-plugin)
[![CI](https://github.com/Qiiks/opencode-qwen-oauth/actions/workflows/plugin-ci.yml/badge.svg)](https://github.com/Qiiks/opencode-qwen-oauth/actions/workflows/plugin-ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

OpenCode plugin for Qwen OAuth with robust retry, refresh, multi-account pooling, and compatibility policies.

## Quick Start

```bash
npm install opencode-qwen-auth-plugin
# or
bun add opencode-qwen-auth-plugin
# or
pnpm add opencode-qwen-auth-plugin
```

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-qwen-auth-plugin@latest"]
}
```

Then run `opencode auth login` and select the Qwen OAuth option.

## Features

- Qwen OAuth with device flow + PKCE authentication
- Multi-account pooling with weighted rotation and automatic cooldown on `429/529`
- Smart retry with class-based idempotency (`A/B/C`), retry budget, full-jitter backoff, and circuit breaker
- Model discovery with local cache (TTL + stale fallback)
- Quota probing surfaced during OAuth login flow
- Compatibility enforcement against OpenCode version matrix
- Structured logging with secret redaction

## Project Structure

```
├── .github/workflows/          # CI and release automation
│   ├── plugin-ci.yml           # Multi-OS, multi-Node CI
│   └── release.yml             # Auto-publish to NPM on version bump
├── opencode-qwen-oauth/        # Plugin source code
│   ├── src/                    # TypeScript source
│   ├── test/                   # Vitest test suite
│   ├── scripts/                # Development utilities
│   └── package.json
└── .gitignore
```

## Documentation

See [opencode-qwen-oauth/README.md](./opencode-qwen-oauth/README.md) for full configuration options, multi-account management, troubleshooting, and development setup.

## Development

```bash
cd opencode-qwen-oauth
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT
