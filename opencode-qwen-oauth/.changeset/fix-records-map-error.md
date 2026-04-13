---
"opencode-qwen-auth-plugin": patch
---

fix: handle non-array records in loadMenuAccountRecords

When native credential store returns a non-array truthy value (e.g.
corrupted data or env bridge), loadMenuAccountRecords would fail
with "records.map is not a function" when trying to normalize records.

- Add Array.isArray guard before accessing .length
- Add Array.isArray guard in saveMenuAccountRecords
- Add defensive check for parsed object with tokens property
