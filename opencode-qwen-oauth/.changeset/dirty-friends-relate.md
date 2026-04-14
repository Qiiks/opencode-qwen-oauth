---
"opencode-qwen-auth-plugin": minor
---

feat: harden token refresh and account identity handling

- Implement canonical account identity resolution to prevent primary/qwencode duplication
- Merge native and local token stores for reliable refresh source-of-truth
- Add explicit invalid_grant handling with account disabling and re-auth guidance
- Introduce shared account-identity module with canonicalization helpers
- Strengthen token merge policies and add comprehensive test coverage
- Fix e2e smoke test path resolution for build artifact layout
- Add regression tests for account deduplication and source merging
