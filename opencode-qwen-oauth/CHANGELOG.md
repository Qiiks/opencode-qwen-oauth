# opencode-qwen-auth-plugin

## 0.1.4

### Patch Changes

- a9c2522: fix: handle non-array records in loadMenuAccountRecords

  When native credential store returns a non-array truthy value (e.g.
  corrupted data or env bridge), loadMenuAccountRecords would fail
  with "records.map is not a function" when trying to normalize records.

  - Add Array.isArray guard before accessing .length
  - Add Array.isArray guard in saveMenuAccountRecords
  - Add defensive check for parsed object with tokens property

## 0.1.3

### Patch Changes

- 9819493: fix: prevent cross-process token refresh race condition with file locking

  When multiple OpenCode sessions run simultaneously, each process could
  independently detect token expiry and attempt refresh using the same
  refresh token. Since Qwen uses refresh token rotation, the second
  refresh would fail with invalid_grant, leaving one session unable to
  authenticate.

  - Add mkdir-based file lock (acquireRefreshLock) for cross-process coordination
  - Detect invalid_grant/invalid_token OAuth errors and recover by re-reading storage
  - Add re-read-after-lock pattern to all refresh paths (resolvePluginAuth, getPreferredAccount, checkAllQuotas)
  - Prevent duplicate refresh calls when another process already refreshed
