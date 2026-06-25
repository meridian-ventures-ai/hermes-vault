# Changelog

## 1.4.0

Mutable access token for singleton dashboard clients, and no-TTL caching by default.

### Changed (both SDKs)

| Area | Change |
|---|---|
| **`set_access_token` / `setAccessToken`** | New public method to update the JWT token at runtime without recreating the client. Enables a singleton vault client whose credentials are synced per-request from the session (e.g. `localStorage`). |
| **Python auth headers** | Auth headers (`Authorization` / `X-Internal-Key`) are now stored as a mutable instance dict and merged per-request, matching the TypeScript SDK pattern. Previously baked into `httpx.Client` at construction. |
| **Cache TTL defaults** | `config_ttl_seconds` / `configTtlSeconds` and `prompt_ttl_seconds` / `promptTtlSeconds` now default to `None`/`null` (no expiration). Cached entries persist until explicitly invalidated via `invalidate(tenant_id)` or evicted by LRU. Pass a value to restore time-based expiration. Previously defaulted to 600s / 300s. |

### Documentation

- Updated `README.md` — dashboard examples for both SDKs now show `set_access_token` / `setAccessToken` per-request credential sync. Cache behavior section updated for no-TTL default.

---

## 1.3.0

Tenant-scoped cache invalidation, mutable operating tenant, and server-side tenant isolation enforcement.

### Changed (both SDKs)

| Area | Change |
|---|---|
| **`set_operating_tenant_id` / `setOperatingTenantId`** | New public method to change the active tenant at runtime without creating a new instance. Cache is preserved across switches. |
| **`operating_tenant_id` / `operatingTenantId`** | Can be passed at construction or changed later via the setter. Sent as `X-Operating-Tenant-Id` header per-request. Used for targeted cache invalidation. |
| **Prompt cache invalidation** | All write methods (`createPromptVersion`, `activateVersion`, `updateVersionMetadata`, `deleteVersion`, `deletePrompt`) now use targeted `deletePrefix(operatingTenantId)` instead of `clear()`. Falls back to `clear()` when operating tenant is not set. |
| **`updateVersionMetadata`** | Now invalidates the prompt cache (previously did no invalidation, leaving stale `versionName` in cache). |
| **Python `_request`** | `X-Operating-Tenant-Id` header now injected per-request (was baked into `httpx.Client` headers at construction). |

### Tenant isolation (Sentinel)

Write endpoints now enforce tenant isolation via `X-Operating-Tenant-Id`:
- `PATCH /vault/configs/{tenant_id}/{service}` — 403 if `tenant_id` does not match the operating tenant.
- `POST /prompts/{prompt_id}/versions` — 403 if the prompt does not belong to the operating tenant.
- `POST /prompts/ensure` — 403 if `body.tenant_id` does not match the operating tenant.

### Documentation

- Updated `CONTRACT.md` — added Tenant Isolation section, updated affected endpoint descriptions.
- Updated `README.md` — dashboard examples now include `operating_tenant_id` / `operatingTenantId`, cache behavior section updated.

---

## 1.2.0

Added support for creating prompt versions as drafts.

### Changed endpoints (both SDKs)

| Python method | TypeScript method | Change |
|---|---|---|
| `create_prompt_version(..., activate=True)` | `createPromptVersion(id, { ..., activate: true })` | New `activate` parameter (default `true`). Pass `false` to create a version as a draft without changing the currently active version. The first version of a prompt is always activated regardless of this flag. |

### Model changes

- `CreatedPromptVersion.is_active` / `isActive` — no longer always `true`; reflects whether the version was activated or created as a draft.

### Documentation

- Updated `CONTRACT.md` — added `activate` field to endpoint 6 (`POST /prompts/{prompt_id}/versions`).
- Updated `README.md` — added draft version examples for both Python and TypeScript.

---

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