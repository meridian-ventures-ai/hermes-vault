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

---

## Read Endpoints (`X-Internal-Key` or JWT)

### 1. `GET /api/v1/vault/configs/{tenant_id}/{service}`

Returns merged global + service config with decrypted secrets.

**Response** — `ConfigResponse`:

```json
{
  "tenant_id": "sae_university",
  "service": "phoenix",
  "enabled": true,
  "config": {
    "voice": "alloy",
    "max_call_duration": 300,
    "default_openai_model": "gpt-4o"
  },
  "secrets": {
    "twilio_account_sid": "AC12345678",
    "twilio_auth_token": "secret_value"
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

### 2. `GET /api/v1/prompts/{tenant_id}/{service}/{prompt_key}/active`

Returns the active prompt version. Sentinel tries tenant-specific first, falls back to default (NULL tenant).

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
| `sections` | `object` | Prompt content sections |

### 3. `GET /api/v1/vault/configs/bulk/{service}`

Bulk-load all configs, secrets, and active prompts for a service across every tenant. Designed for service startup — returns everything the service needs in a single call.

**Response** — `BulkServiceResponse`:

```json
{
  "service": "phoenix",
  "tenants": {
    "sae_university": {
      "enabled": true,
      "config": { "voice": "alloy", "max_call_duration": 300 },
      "secrets": { "twilio_account_sid": "AC12345678" },
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
| `tenants` | `object` | Per-tenant data keyed by tenant_id |
| `tenants[].enabled` | `boolean` | Whether the tenant/service pair is active |
| `tenants[].config` | `object` | Non-sensitive operational configuration |
| `tenants[].secrets` | `object` | Decrypted secret key-value pairs |
| `tenants[].prompts` | `object` | Active prompts keyed by prompt_key |
| `tenants[].prompts[].version` | `integer` | Active version number |
| `tenants[].prompts[].version_name` | `string` | Human-readable version label |
| `tenants[].prompts[].sections` | `object` | Prompt content sections |

---

## Write Endpoints (JWT only)

### 4. `PATCH /api/v1/vault/configs/{tenant_id}/{service}`

Update config and/or secrets for a tenant/service pair. Secrets are encrypted server-side before storage.

**Request** — `ConfigUpdateRequest`:

```json
{
  "config": { "voice": "nova" },
  "secrets": { "twilio_auth_token": "new_secret_value" }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `config` | `object \| null` | No | Non-sensitive config to merge |
| `secrets` | `object \| null` | No | Plaintext secrets to merge (encrypted by Sentinel) |

**Response** — `ConfigResponse` (same shape as the read endpoint).

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

By default (`activate=true`), the new version is set as active and the previous active version is deactivated. Pass `activate=false` to create the version as a draft without changing the currently active version. The first version of a prompt is always activated regardless of this flag.

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
| `sections` | `object` | Yes | Complete snapshot of all prompt sections |
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

Idempotently find or create a prompt slot. If a prompt with the given tenant/service/key already exists, returns it.

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

List all prompt slots for the authenticated user's tenant. Optionally filter by service.

**Query params:** `service` (optional) — filter by service name.

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
| `sections` | `object` | Prompt content sections |
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