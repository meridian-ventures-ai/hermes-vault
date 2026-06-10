# Hermes Vault — Sentinel API Contract

This document is the **source of truth** for both SDKs. When Sentinel's API changes, this file is updated first — then both SDKs are updated to match.

---

## SDK Endpoints (read-only, `X-Internal-Key` auth)

### 1. `GET /api/v1/vault/configs/{tenant_id}/{service}`

Returns merged global + service config with decrypted secrets.

**Auth:** `X-Internal-Key` header

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

**Auth:** `X-Internal-Key` header

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

## Error Responses

All endpoints return errors in the following format:

```json
{
  "detail": "Error message describing what went wrong"
}
```

| HTTP Status | Meaning |
|---|---|
| `401` | Missing or invalid `X-Internal-Key` |
| `403` | Insufficient permissions |
| `404` | Resource not found |
| `422` | Validation error |
| `5xx` | Server error |

---

## Dashboard-Only Endpoints (JWT auth, not in SDK)

These endpoints are used only by the dashboard frontend and are documented here for reference:

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/v1/prompts/{tenant_id}/{service}/{key}/versions` | `GET` | JWT | Version history |
| `/api/v1/prompts/{prompt_id}/versions` | `POST` | JWT | Create new version |
| `/api/v1/prompts/ensure` | `POST` | JWT | Find-or-create prompt slot |
| `/api/v1/vault/configs/{tenant_id}/{service}` | `PATCH` | JWT | Update config/secrets |