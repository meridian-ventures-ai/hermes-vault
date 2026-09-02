# Hermes Vault — Sentinel API Contract

This document is the **source of truth** for both SDKs. When Sentinel's API changes, this file is updated first — then both SDKs are updated to match.

---

## Auth Modes

The SDK supports two authentication modes:

| Mode | Header | Use case |
|---|---|---|
| Internal key | `X-Internal-Key: <key>` | Backend services (Phoenix, URAG, Hermes Core) |
| JWT | `Authorization: Bearer <token>` | Dashboard (read + write operations) |

Read endpoints accept either auth mode. Write endpoints require JWT.

### Tenant Isolation

Write endpoints enforce tenant isolation via the `X-Operating-Tenant-Id` header. When using JWT auth, the SDK sends this header so Sentinel can resolve the operating tenant. Sentinel validates that the resource being modified belongs to the operating tenant and returns `403` if there is a mismatch.

| Header | Description |
|---|---|
| `X-Operating-Tenant-Id` | Active tenant ID for the dashboard session. Sent automatically by the SDK when `operatingTenantId` / `operating_tenant_id` is set at construction. |

---

## Read Endpoints (`X-Internal-Key` or JWT)

### 1. `GET /api/v1/vault/configs/{tenant_id}/{service}`

Returns merged global + service config with decrypted secrets. Sentinel performs a per-key merge of the `_default` tenant's config with the target tenant's config and returns provenance metadata indicating where each key originated.

**Read-only merge:** per-key merge applies only here (and on bulk load). The write endpoint (PATCH, §4) **replaces** entire `config` / `secrets` maps on the service row — it does not merge. Do not round-trip this response as a PATCH body without stripping `"_default"`-sourced keys (see §4).

**Response** — `ConfigResponse`:

```json
{
  "tenant_id": "sae_university",
  "service": "phoenix",
  "enabled": true,
  "config": {
    "voice": "alloy",
    "max_call_duration": 300,
    "default_openai_model": "gpt-4o",
    "openai_api_key": "sk-global-key"
  },
  "secrets": {
    "twilio_account_sid": "AC12345678",
    "twilio_auth_token": "secret_value",
    "elevenlabs_api_key": "el-global-key"
  },
  "config_sources": {
    "voice": "tenant",
    "max_call_duration": "tenant",
    "default_openai_model": "tenant",
    "openai_api_key": "_default"
  },
  "secrets_sources": {
    "twilio_account_sid": "tenant",
    "twilio_auth_token": "tenant",
    "elevenlabs_api_key": "_default"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `tenant_id` | `string` | Tenant identifier |
| `service` | `string` | Service name |
| `enabled` | `boolean` | Whether the tenant/service is enabled |
| `config` | `object` | Non-sensitive operational configuration |
| `secrets` | `object` | Decrypted secret key-value pairs |
| `config_sources` | `object` | Per-key provenance: `"tenant"`, `"_default"`, or `"merged"`. Nested dicts report at sub-key level. |
| `secrets_sources` | `object` | Per-key provenance for secrets (same semantics as `config_sources`) |

### 2. `GET /api/v1/prompts/{tenant_id}/{service}/{prompt_key}/active`

Returns the active prompt version. Sentinel tries tenant-specific first, falls back to default (NULL tenant).

#### Prompt sections shape

`sections` accepts and returns **two shapes**:

- **Ordered array** (preferred): `[{ "key": "identity", "value": "..." }, ...]`. Section order is part of the data and survives JSONB storage. New writes should use this shape.
- **Legacy object**: `{ "identity": "...", ... }`. Still returned for versions saved before the array migration. JSONB does not preserve object key order, so these read back in length-then-alphabetical order rather than authored order.

Both SDKs normalize either shape into a plain dict/record for consumers, preserving the order Sentinel sent. JSON examples below use the legacy object form for brevity.

**Response** — `ActivePromptResponse`:

```json
{
  "prompt_id": "uuid",
  "tenant_id": "sae_university",
  "service": "phoenix",
  "prompt_key": "system_prompt",
  "version": 3,
  "version_name": "SAE v3",
  "sections": {
    "identity": "...",
    "guidelines": "...",
    "intro": "..."
  }
}
```

| Field | Type | Description |
|---|---|---|
| `prompt_id` | `string` (UUID) | Unique prompt identifier |
| `tenant_id` | `string \| null` | Tenant ID, or null for default/fallback prompts |
| `service` | `string` | Service name |
| `prompt_key` | `string` | Prompt key (e.g. `system_prompt`) |
| `version` | `integer` | Active version number |
| `version_name` | `string` | Human-readable version label |
| `sections` | `array \| object` | Prompt content sections (see [Prompt sections shape](#prompt-sections-shape)) |

### 3. `GET /api/v1/vault/configs/bulk/{service}`

Bulk-load all configs, secrets, and active prompts for a service across every tenant. The SDK uses this endpoint internally for `preload()` cache warming — it is not exposed as a return value. Designed for service startup so that subsequent `getConfig()`, `getSecret()`, and `getPrompt()` calls are all cache hits.

Each tenant entry includes per-key merge with the `_default` tenant and provenance metadata. The `_default` tenant itself is excluded from the tenant list.

**Response** — `BulkServiceResponse`:

```json
{
  "service": "phoenix",
  "tenants": {
    "sae_university": {
      "enabled": true,
      "config": { "voice": "alloy", "max_call_duration": 300 },
      "secrets": { "twilio_account_sid": "AC12345678" },
      "config_sources": { "voice": "tenant", "max_call_duration": "tenant" },
      "secrets_sources": { "twilio_account_sid": "tenant" },
      "prompts": {
        "system_prompt": {
          "version": 3,
          "version_name": "SAE v3",
          "sections": { "identity": "...", "guidelines": "..." }
        }
      }
    }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `service` | `string` | Service name |
| `tenants` | `object` | Per-tenant data keyed by tenant_id (excludes `_default`) |
| `tenants[].enabled` | `boolean` | Whether the tenant/service pair is active |
| `tenants[].config` | `object` | Non-sensitive operational configuration |
| `tenants[].secrets` | `object` | Decrypted secret key-value pairs |
| `tenants[].config_sources` | `object` | Per-key provenance for config |
| `tenants[].secrets_sources` | `object` | Per-key provenance for secrets |
| `tenants[].prompts` | `object` | Active prompts keyed by prompt_key |
| `tenants[].prompts[].version` | `integer` | Active version number |
| `tenants[].prompts[].version_name` | `string` | Human-readable version label |
| `tenants[].prompts[].sections` | `array \| object` | Prompt content sections (see [Prompt sections shape](#prompt-sections-shape)) |

---

## Write Endpoints (JWT only)

### 4. `PATCH /api/v1/vault/configs/{tenant_id}/{service}`

Replace config and/or secrets for a tenant/service pair. Secrets are encrypted server-side before storage. Sentinel enforces that `tenant_id` matches the operating tenant resolved from the JWT / `X-Operating-Tenant-Id` header (403 on mismatch).

**Write semantics (critical):** this is **not** a per-key merge. For each top-level field you include:

- `config` — **replaces the entire** `config` JSON column on the **service-specific** row (`tenant_id` + `service`). Keys omitted from the object are **deleted** from that row.
- `secrets` — **replaces the entire** `secrets` JSON column on that same row. Keys omitted are **deleted**.

Omitting a top-level field (or sending `null`) leaves that column unchanged. There is no partial / deep-merge write: send the **full desired** `config` and/or `secrets` map for the service row.

Per-key merge with `_default` applies only on **read** (endpoints 1 and 3), never on write.

**Do not** round-trip the GET response as a PATCH body without care: GET returns the **merged** view (`global` + service + `_default`). Writing that object back materializes `_default` keys onto the tenant service row and freezes inheritance. Prefer editing from a known full service-row document, or strip keys whose provenance is `"_default"` before write.

When `tenant_id` is `_default`, Sentinel sends a wildcard cache invalidation so all consumer services clear their entire config cache (since `_default` values propagate to every tenant).

**Request** — `ConfigUpdateRequest`:

```json
{
  "config": {
    "voice": "nova",
    "timezone": "America/New_York",
    "max_call_duration": 600
  },
  "secrets": {
    "twilio_account_sid": "AC...",
    "twilio_auth_token": "new_secret_value"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `config` | `object \| null` | No | Full non-sensitive config map to **store** on the service row (replaces existing). Omit/`null` to leave config unchanged. |
| `secrets` | `object \| null` | No | Full plaintext secrets map to **store** (replaces existing; encrypted by Sentinel). Omit/`null` to leave secrets unchanged. |

**Response** — `ConfigResponse` (same shape as the read endpoint: **merged** view including `config_sources` and `secrets_sources`). The response is not the raw stored row.

### 5. `GET /api/v1/prompts/{tenant_id}/{service}/{prompt_key}/versions`

Get full version history for a prompt. Uses exact `tenant_id` match (no fallback). Use `_default` for default prompts.

**Response** — `PromptVersionListItem[]`:

```json
[
  {
    "id": "uuid",
    "version": 3,
    "version_name": "SAE v3",
    "version_note": "Updated guidelines",
    "is_active": true,
    "created_by": 1,
    "created_at": "2025-01-15T10:30:00Z"
  }
]
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` (UUID) | Version UUID |
| `version` | `integer` | Version number |
| `version_name` | `string` | Human-readable version label |
| `version_note` | `string \| null` | Optional description of changes |
| `is_active` | `boolean` | Whether this version is currently active |
| `created_by` | `integer \| null` | User ID of the creator |
| `created_at` | `string` (ISO-8601) | Creation timestamp |

### 6. `POST /api/v1/prompts/{prompt_id}/versions`

Create a new prompt version.

By default (`activate=true`), the new version is set as active and the previous active version is deactivated. Pass `activate=false` to create the version as a draft without changing the currently active version. The first version of a prompt is always activated regardless of this flag. Sentinel enforces that the prompt belongs to the operating tenant resolved from the JWT / `X-Operating-Tenant-Id` header (403 on mismatch). Default prompts (`tenant_id IS NULL`) can be versioned by any authenticated dashboard user.

**Request** — `CreatePromptVersionRequest`:

```json
{
  "sections": { "identity": "...", "guidelines": "..." },
  "version_name": "SAE v4",
  "version_note": "Rewrote identity section",
  "created_by": 1,
  "activate": true
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `sections` | `array \| object` | Yes | Complete snapshot of all prompt sections — ordered array preferred (see [Prompt sections shape](#prompt-sections-shape)) |
| `version_name` | `string` | Yes | Version label (1-100 chars) |
| `version_note` | `string \| null` | No | Optional description of changes |
| `created_by` | `integer \| null` | No | User ID (defaults to JWT user) |
| `activate` | `boolean` | No | Activate the new version immediately. Default `true`. Ignored for the first version of a prompt (always activated). |

**Response** — `CreatePromptVersionResponse`:

```json
{
  "id": "uuid",
  "prompt_id": "uuid",
  "version": 4,
  "version_name": "SAE v4",
  "is_active": true
}
```

### 7. `POST /api/v1/prompts/ensure`

Idempotently find or create a prompt slot. If a prompt with the given tenant/service/key already exists, returns it. Sentinel enforces that `tenant_id` matches the operating tenant resolved from the JWT / `X-Operating-Tenant-Id` header (403 on mismatch).

**Request** — `EnsurePromptRequest`:

```json
{
  "tenant_id": "sae_university",
  "service": "phoenix",
  "prompt_key": "system_prompt"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `tenant_id` | `string \| null` | No | Tenant ID, or `null` for default/fallback |
| `service` | `string` | Yes | Service name (1-50 chars) |
| `prompt_key` | `string` | Yes | Prompt key (1-100 chars) |

**Response** — `EnsurePromptResponse`:

```json
{
  "id": "uuid",
  "tenant_id": "sae_university",
  "service": "phoenix",
  "prompt_key": "system_prompt",
  "created": false
}
```

### 8. `GET /api/v1/prompts`

List prompt slots, optionally scoped to defaults.

Without `tenant_id`, lists prompts for the caller's operating tenant. Pass `tenant_id=_default` to list system-wide default/fallback prompts (`tenant_id IS NULL`) — needed so the dashboard can browse and manage existing defaults.

**Query params:**

| Param | Type | Required | Description |
|---|---|---|---|
| `service` | `string` | No | Filter by service name |
| `tenant_id` | `string` | No | `_default` to list default prompts (tenant_id IS NULL), an explicit tenant ID, or omit to use the authenticated user's operating tenant |

**Response** — `PromptListItem[]`:

```json
[
  {
    "id": "uuid",
    "tenant_id": "sae_university",
    "service": "phoenix",
    "prompt_key": "system_prompt",
    "active_version": 3,
    "active_version_name": "SAE v3",
    "version_count": 3,
    "updated_at": "2025-01-15T10:30:00Z"
  }
]
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` (UUID) | Prompt UUID |
| `tenant_id` | `string \| null` | Tenant ID, or null for default prompts |
| `service` | `string` | Service name |
| `prompt_key` | `string` | Prompt key |
| `active_version` | `integer \| null` | Active version number, or null if none |
| `active_version_name` | `string \| null` | Label of the active version |
| `version_count` | `integer` | Total number of versions |
| `updated_at` | `string` (ISO-8601) | Last update timestamp |

### 9. `GET /api/v1/prompts/versions/{version_id}`

Get full detail (including sections content) for a single prompt version.

**Response** — `PromptVersionDetail`:

```json
{
  "id": "uuid",
  "prompt_id": "uuid",
  "version": 3,
  "version_name": "SAE v3",
  "version_note": "Updated guidelines",
  "sections": { "identity": "...", "guidelines": "..." },
  "is_active": true,
  "created_by": 1,
  "created_at": "2025-01-15T10:30:00Z"
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` (UUID) | Version UUID |
| `prompt_id` | `string` (UUID) | Parent prompt UUID |
| `version` | `integer` | Version number |
| `version_name` | `string` | Human-readable version label |
| `version_note` | `string \| null` | Optional description of changes |
| `sections` | `array \| object` | Prompt content sections (see [Prompt sections shape](#prompt-sections-shape)) |
| `is_active` | `boolean` | Whether this version is currently active |
| `created_by` | `integer \| null` | User ID of the creator |
| `created_at` | `string` (ISO-8601) | Creation timestamp |

### 10. `PATCH /api/v1/prompts/versions/{version_id}/activate`

Set a specific version as the active version (rollback/promote). Deactivates the current active version and activates the specified one.

**Response** — `PromptVersionDetail` (same shape as endpoint 10).

### 11. `PATCH /api/v1/prompts/versions/{version_id}`

Update version_name and/or version_note for a prompt version. Does not modify the sections content — content changes require creating a new version.

**Request** — `UpdateVersionMetadataRequest`:

```json
{
  "version_name": "SAE v3 — revised",
  "version_note": "Fixed typo in guidelines"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `version_name` | `string \| null` | No | New version label (1-100 chars) |
| `version_note` | `string \| null` | No | New description |

**Response** — `PromptVersionDetail` (same shape as endpoint 10).

### 12. `DELETE /api/v1/prompts/versions/{version_id}`

Delete a prompt version. Cannot delete the last remaining version — delete the prompt instead. If the active version is deleted, the latest remaining version is auto-activated.

**Response** — `MessageResponse`:

```json
{
  "message": "Version deleted"
}
```

### 13. `DELETE /api/v1/prompts/{prompt_id}`

Delete a prompt slot and all its versions.

**Response** — `MessageResponse`:

```json
{
  "message": "Prompt deleted"
}
```

---

## Error Responses

All endpoints return errors in the following format:

```json
{
  "detail": "Error message describing what went wrong"
}
```

| HTTP Status | Meaning |
|---|---|
| `401` | Missing or invalid auth (internal key or JWT) |
| `403` | Insufficient permissions |
| `404` | Resource not found |
| `422` | Validation error |
| `5xx` | Server error |