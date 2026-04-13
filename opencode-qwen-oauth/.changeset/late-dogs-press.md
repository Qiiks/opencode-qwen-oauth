---
"opencode-qwen-auth-plugin": patch
---

fix: prevent cross-process token refresh race condition with file locking

When multiple OpenCode sessions run simultaneously, each process could
independently detect token expiry and attempt refresh using the same
refresh token. Since Qwen uses refresh token rotation, the second
refresh would fail with invalid_grant, leaving one session unable to
authenticate.

- Add mkdir-based file lock (acquireRefreshLock) for cross-process coordination
- Detect invalid_grant/invalid_token OAuth errors and recover by re-reading storage
- Add re-read-after-lock pattern to all refresh paths (resolvePluginAuth, getPreferredAccount, checkAllQuotas)
- Prevent duplicate refresh calls when another process already refreshed
