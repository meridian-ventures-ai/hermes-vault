# Changelog

## 1.1.0

Added support for all new Sentinel dashboard and bulk-load endpoints.

### New endpoints (both SDKs)

| Python method | TypeScript method | Endpoint | Auth |
|---|---|---|---|
| `get_bulk_config()` | `getBulkConfig()` | `GET /vault/configs/bulk/{service}` | Internal Key |
| `list_prompts(service?)` | `listPrompts(service?)` | `GET /prompts` | JWT |
| `get_version_detail(version_id)` | `getVersionDetail(versionId)` | `GET /prompts/versions/{version_id}` | JWT |
| `activate_version(version_id)` | `activateVersion(versionId)` | `PATCH /prompts/versions/{version_id}/activate` | JWT |
| `update_version_metadata(...)` | `updateVersionMetadata(...)` | `PATCH /prompts/versions/{version_id}` | JWT |
| `delete_version(version_id)` | `deleteVersion(versionId)` | `DELETE /prompts/versions/{version_id}` | JWT |
| `delete_prompt(prompt_id)` | `deletePrompt(promptId)` | `DELETE /prompts/{prompt_id}` | JWT |

### New models

- `PromptListItem` — prompt slot in list view (id, tenant_id, service, prompt_key, active_version, version_count, updated_at)
- `PromptVersionDetail` — full version detail including sections content
- `BulkPromptEntry`, `BulkTenantEntry`, `BulkServiceData` — bulk load response models

### Documentation
- Updated `CONTRACT.md` with all 13 endpoints (was 6)
- Updated `README.md` with usage examples for dashboard and bulk-load modes

---

## 1.0.0

Initial release of the Hermes Vault SDK monorepo.

### Python SDK (`hermes-vault`)
- `HermesVault` client with `get_config`, `get_secret`, `get_prompt`, `invalidate`
- `TenantCache` with TTL + LRU eviction
- `TenantConfig` and `ActivePrompt` dataclasses
- Exception hierarchy: `VaultError`, `VaultConnectionError`, `VaultHTTPError`, `VaultNotFoundError`, `VaultAuthError`

### TypeScript SDK (`@meridian-ventures/hermes-vault`)
- `HermesVault` client with `getConfig`, `getSecret`, `getPrompt`, `invalidate`
- `TenantCache` with TTL + LRU eviction
- `TenantConfig` and `ActivePrompt` interfaces
- Exception hierarchy: `VaultError`, `VaultConnectionError`, `VaultHttpError`, `VaultNotFoundError`, `VaultAuthError`