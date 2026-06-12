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

---

## Write Endpoints (JWT only)

### 3. `PATCH /api/v1/vault/configs/{tenant_id}/{service}`

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

### 4. `GET /api/v1/prompts/{tenant_id}/{service}/{prompt_key}/versions`

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

### 5. `POST /api/v1/prompts/{prompt_id}/versions`

Create a new prompt version. Automatically activates the new version and deactivates the previous one.

**Request** — `CreatePromptVersionRequest`:

```json
{
  "sections": { "identity": "...", "guidelines": "..." },
  "version_name": "SAE v4",
  "version_note": "Rewrote identity section",
  "created_by": 1
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `sections` | `object` | Yes | Complete snapshot of all prompt sections |
| `version_name` | `string` | Yes | Version label (1-100 chars) |
| `version_note` | `string \| null` | No | Optional description of changes |
| `created_by` | `integer \| null` | No | User ID (defaults to JWT user) |

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

### 6. `POST /api/v1/prompts/ensure`

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