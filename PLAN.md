# Hermes Vault SDK Monorepo — Implementation Plan

## Context

Hermes Vault is the SDK for fetching tenant-scoped configuration, secrets, and prompts across the Hermes ecosystem. Sentinel already exposes all the required endpoints under `/api/v1/`, with two auth modes:

- **`X-Internal-Key`** — for service-to-service reads (configs, secrets, active prompts)
- **JWT** — for dashboard-only writes (create/update prompts, update configs, version history)

The SDKs are **read-only** wrappers for services. Write operations are performed by the dashboard directly via JWT — the SDK never writes. Both SDKs talk to the same Sentinel API; neither connects to the database.

### Consumers

| Service | SDK | Runtime |
|---|---|---|
| Hermes Core | `@meridian-ventures/hermes-vault` | Node.js |
| Phoenix | `hermes-vault` (Python) | Python 3.11+ |
| URAG Indexing | `hermes-vault` (Python) | Python 3.11+ |
| Hermes Notifications | `hermes-vault` (Python) | Python 3.11+ |

---

## Repo Structure

Create a **new repository** at `C:\Dev\Meridian\hermes-vault` (sibling to `hermes-sentinel`).

```
hermes-vault/
├── README.md
├── CHANGELOG.md
├── CONTRACT.md                ← Sentinel endpoint + shape reference (source of truth)
│
├── python/
│   ├── pyproject.toml
│   └── hermes_vault/
│       ├── __init__.py        ← re-export HermesVault, models, exceptions
│       ├── client.py          ← HermesVault class
│       ├── cache.py           ← TenantCache (TTL + LRU)
│       ├── models.py          ← dataclasses for response shapes
│       └── exceptions.py      ← VaultError, VaultHTTPError, etc.
│
└── typescript/
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts           ← re-export everything
        ├── client.ts          ← HermesVault class
        ├── cache.ts           ← TenantCache (TTL + LRU)
        ├── models.ts          ← TypeScript interfaces
        └── exceptions.ts      ← VaultError, VaultHttpError, etc.
```

---

## CONTRACT.md — Sentinel API Reference (SDK-relevant endpoints)

CONTRACT.md is the source of truth for both SDKs. When Sentinel's API changes, CONTRACT.md is updated first — then both SDKs. This prevents the two SDKs from silently drifting.

The SDK only consumes the two **read-only, `X-Internal-Key`-protected** endpoints:

### 1. `GET /api/v1/vault/configs/{tenant_id}/{service}`

Returns merged global + service config with decrypted secrets.

**Auth:** `X-Internal-Key` header

**Response** (`ConfigResponse`):
```json
{
  "tenant_id": "sae_university",
  "service": "phoenix",
  "enabled": true,
  "config": { "voice": "alloy", "max_call_duration": 300, "default_openai_model": "gpt-4o" },
  "secrets": { "twilio_account_sid": "AC12345678", "twilio_auth_token": "secret_value" }
}
```

### 2. `GET /api/v1/prompts/{tenant_id}/{service}/{prompt_key}/active`

Returns the active prompt version. Sentinel tries tenant-specific first, falls back to default (NULL tenant).

**Auth:** `X-Internal-Key` header

**Response** (`ActivePromptResponse`):
```json
{
  "prompt_id": "uuid",
  "tenant_id": "sae_university",
  "service": "phoenix",
  "prompt_key": "system_prompt",
  "version": 3,
  "version_name": "SAE v3",
  "sections": { "identity": "...", "guidelines": "...", "intro": "..." }
}
```

### Dashboard-only endpoints (not in SDK, documented for reference)

These are JWT-protected and used only by the dashboard frontend:

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/v1/prompts/{tenant_id}/{service}/{key}/versions` | JWT | Version history |
| `POST /api/v1/prompts/{prompt_id}/versions` | JWT | Create new version |
| `POST /api/v1/prompts/ensure` | JWT | Find-or-create prompt slot |
| `PATCH /api/v1/vault/configs/{tenant_id}/{service}` | JWT | Update config/secrets |

---

## SDK Interface (both languages)

### Constructor

```python
# Python
vault = HermesVault(
    sentinel_url="https://auth.sentinel.hermes-agent.com",
    internal_key="<INTERNAL_SERVICE_KEY>",
    service="phoenix",             # scopes get_config / get_prompt
    config_ttl_seconds=600,        # default 600 (10 min)
    prompt_ttl_seconds=300,        # default 300 (5 min)
    max_cache_size=100,            # max tenants in LRU, default 100
)
```

```typescript
// TypeScript
const vault = new HermesVault({
  sentinelUrl: "https://auth.sentinel.hermes-agent.com",
  internalKey: "<INTERNAL_SERVICE_KEY>",
  service: "phoenix",
  configTtlSeconds: 600,
  promptTtlSeconds: 300,
  maxCacheSize: 100,
});
```

### Methods

| Python method | TypeScript method | Sentinel endpoint | Cached? |
|---|---|---|---|
| `get_config(tenant_id)` | `getConfig(tenantId)` | `GET /api/v1/vault/configs/{tenant_id}/{service}` | Yes (10 min TTL) |
| `get_secret(tenant_id, key)` | `getSecret(tenantId, key)` | *(extracts from cached config — no extra HTTP call)* | Yes (10 min TTL) |
| `get_prompt(tenant_id, prompt_key)` | `getPrompt(tenantId, promptKey)` | `GET /api/v1/prompts/{tenant_id}/{service}/{prompt_key}/active` | Yes (5 min TTL) |
| `invalidate(tenant_id)` | `invalidate(tenantId)` | *(local only — clears in-memory cache)* | N/A |

**Design notes:**
- `service` is set in the constructor and implicitly used in every call. Callers never pass it.
- `get_secret` calls `get_config` internally (cache hit) and extracts `secrets[key]`. Raises `VaultNotFoundError` if the key doesn't exist.
- `invalidate(tenant_id)` removes that tenant from both config and prompt caches. Consuming services expose a `POST /internal/cache/invalidate?tenant_id=X` endpoint that calls this method — the dashboard hits that endpoint after saving changes.

---

## Caching Implementation

Both SDKs use an identical caching strategy:

```
TenantCache<T>
  ├── store: OrderedDict / Map  (key → CacheEntry<T>)
  ├── ttl_seconds: int
  └── max_size: int

CacheEntry<T>
  ├── data: T
  └── expires_at: float (unix timestamp)
```

- **Lazy loading**: nothing fetched at startup. First request per tenant triggers a fetch.
- **TTL**: each entry has an `expires_at`. On read, if expired → evict and re-fetch.
- **LRU eviction**: when `store` size exceeds `max_size`, the oldest-accessed entry is evicted.
- **Two separate caches** in the client: one for configs (10 min TTL), one for prompts (5 min TTL).
- **`invalidate(tenant_id)`**: removes that tenant from both caches immediately.

### Cache keys

- Config cache: key = `tenant_id` (one config per tenant since service is fixed in constructor)
- Prompt cache: key = `"{tenant_id}:{prompt_key}"` (a tenant can have multiple prompt keys)

---

## Python SDK — File Details

### `python/pyproject.toml`

```toml
[project]
name = "hermes-vault"
version = "1.0.0"
description = "Hermes Vault SDK — tenant config, secrets, and prompts via Sentinel"
requires-python = ">=3.11"
dependencies = ["httpx>=0.27,<1"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

Single dependency: `httpx`. No pydantic — use dataclasses to keep it lightweight.

### `python/hermes_vault/exceptions.py`

```python
class VaultError(Exception):
    """Base exception for all Vault SDK errors."""

class VaultConnectionError(VaultError):
    """Sentinel is unreachable or request timed out."""

class VaultHTTPError(VaultError):
    """Sentinel returned a non-2xx response."""
    def __init__(self, status_code: int, detail: str): ...

class VaultNotFoundError(VaultHTTPError):
    """404 — requested resource does not exist."""

class VaultAuthError(VaultHTTPError):
    """401/403 — invalid or missing internal key."""
```

### `python/hermes_vault/models.py`

```python
@dataclass
class TenantConfig:
    tenant_id: str
    service: str
    enabled: bool
    config: dict[str, Any]
    secrets: dict[str, Any]

@dataclass
class ActivePrompt:
    prompt_id: str
    tenant_id: str | None
    service: str
    prompt_key: str
    version: int
    version_name: str
    sections: dict[str, Any]
```

### `python/hermes_vault/cache.py`

```python
class TenantCache(Generic[T]):
    """Per-tenant TTL cache with LRU eviction."""

    def __init__(self, ttl_seconds: int, max_size: int): ...
    def get(self, key: str) -> T | None: ...
    def set(self, key: str, value: T) -> None: ...
    def delete(self, key: str) -> None: ...
    def delete_prefix(self, prefix: str) -> None: ...  # for invalidate(tenant_id)
    def clear(self) -> None: ...
```

Uses `OrderedDict` for LRU ordering. On `get`, moves to end. On `set`, if over capacity, pops from front.

### `python/hermes_vault/client.py`

```python
class HermesVault:
    def __init__(
        self,
        sentinel_url: str,
        internal_key: str,
        service: str,
        config_ttl_seconds: int = 600,
        prompt_ttl_seconds: int = 300,
        max_cache_size: int = 100,
    ): ...

    def get_config(self, tenant_id: str) -> TenantConfig: ...
    def get_secret(self, tenant_id: str, key: str) -> str: ...
    def get_prompt(self, tenant_id: str, prompt_key: str) -> ActivePrompt: ...
    def invalidate(self, tenant_id: str) -> None: ...
```

Implementation notes:
- Uses `httpx.Client` (sync) with `base_url=sentinel_url` and default header `X-Internal-Key`.
- All methods are **synchronous**. Phoenix and other Python services use sync endpoints (same pattern as Sentinel itself).
- `get_secret` calls `get_config` internally (cache hit), extracts `secrets[key]`, raises `VaultNotFoundError` if key missing.
- HTTP errors map to exceptions: 401/403 → `VaultAuthError`, 404 → `VaultNotFoundError`, other → `VaultHTTPError`, network/timeout → `VaultConnectionError`.
- `invalidate` clears all cache entries for that tenant from both caches.

### `python/hermes_vault/__init__.py`

```python
from hermes_vault.client import HermesVault
from hermes_vault.models import TenantConfig, ActivePrompt
from hermes_vault.exceptions import (
    VaultError, VaultConnectionError, VaultHTTPError,
    VaultNotFoundError, VaultAuthError,
)

__all__ = [
    "HermesVault",
    "TenantConfig", "ActivePrompt",
    "VaultError", "VaultConnectionError", "VaultHTTPError",
    "VaultNotFoundError", "VaultAuthError",
]
```

---

## TypeScript SDK — File Details

### `typescript/package.json`

```json
{
  "name": "@meridian-ventures/hermes-vault",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {},
  "devDependencies": {
    "typescript": "^5.4"
  }
}
```

Zero runtime dependencies. Uses Node.js built-in `fetch` (Node 18+).

### `typescript/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "dist",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

### `typescript/src/exceptions.ts`

```typescript
export class VaultError extends Error { ... }
export class VaultConnectionError extends VaultError { ... }
export class VaultHttpError extends VaultError {
  constructor(public statusCode: number, public detail: string) { ... }
}
export class VaultNotFoundError extends VaultHttpError { ... }
export class VaultAuthError extends VaultHttpError { ... }
```

### `typescript/src/models.ts`

```typescript
export interface TenantConfig {
  tenantId: string;
  service: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
}

export interface ActivePrompt {
  promptId: string;
  tenantId: string | null;
  service: string;
  promptKey: string;
  version: number;
  versionName: string;
  sections: Record<string, unknown>;
}
```

All fields are camelCased. The client converts Sentinel's snake_case JSON on receipt.

### `typescript/src/cache.ts`

```typescript
export class TenantCache<T> {
  private store: Map<string, CacheEntry<T>>;
  private ttlMs: number;
  private maxSize: number;

  constructor(ttlSeconds: number, maxSize: number);
  get(key: string): T | null;
  set(key: string, value: T): void;
  delete(key: string): void;
  deletePrefix(prefix: string): void;
  clear(): void;
}
```

Uses JavaScript `Map` which preserves insertion order for LRU behavior.

### `typescript/src/client.ts`

```typescript
export interface HermesVaultOptions {
  sentinelUrl: string;
  internalKey: string;
  service: string;
  configTtlSeconds?: number;   // default 600
  promptTtlSeconds?: number;   // default 300
  maxCacheSize?: number;       // default 100
}

export class HermesVault {
  constructor(options: HermesVaultOptions);

  async getConfig(tenantId: string): Promise<TenantConfig>;
  async getSecret(tenantId: string, key: string): Promise<string>;
  async getPrompt(tenantId: string, promptKey: string): Promise<ActivePrompt>;
  invalidate(tenantId: string): void;
}
```

Implementation notes:
- Uses Node.js native `fetch` — zero dependencies.
- All HTTP methods are `async`. `invalidate` is synchronous (local cache only).
- A `snakeToCamel` utility converts JSON response keys, applied once in the base `_request` method.
- Error handling identical to Python: status code → specific exception class.
- `getSecret` calls `getConfig` internally, extracts the key from cached result.

### `typescript/src/index.ts`

```typescript
export { HermesVault, HermesVaultOptions } from "./client";
export { TenantConfig, ActivePrompt } from "./models";
export { VaultError, VaultConnectionError, VaultHttpError, VaultNotFoundError, VaultAuthError } from "./exceptions";
```

---

## JSON Key Convention

| SDK | Strategy |
|---|---|
| Python | No conversion — snake_case is native. Dataclass fields match JSON keys. |
| TypeScript | `snakeToCamel` utility converts all response keys. Applied once in base `_request` method. |

---

## Error Handling (both SDKs)

```
HTTP status → SDK exception:
  401, 403    → VaultAuthError
  404         → VaultNotFoundError
  422         → VaultHTTPError (validation)
  5xx         → VaultHTTPError (server error)
  Network     → VaultConnectionError
  Timeout     → VaultConnectionError
```

All exceptions include status code and Sentinel's `detail` message:

```python
try:
    prompt = vault.get_prompt(tenant_id, "system_prompt")
except VaultNotFoundError:
    prompt = DEFAULT_PROMPT  # no prompt configured — use fallback
except VaultError as e:
    logger.error(f"Vault error: {e}")
    raise
```

---

## Files to Create

### Root level (3 files)
| File | Purpose |
|---|---|
| `README.md` | Overview, install instructions, usage examples for both SDKs |
| `CHANGELOG.md` | Version history (starts at 1.0.0) |
| `CONTRACT.md` | Sentinel API reference (2 SDK endpoints + dashboard endpoints for reference) |

### Python SDK (6 files)
| File | Purpose |
|---|---|
| `python/pyproject.toml` | Package metadata, httpx dependency |
| `python/hermes_vault/__init__.py` | Public API re-exports |
| `python/hermes_vault/client.py` | `HermesVault` class — 3 methods + invalidate |
| `python/hermes_vault/cache.py` | `TenantCache` generic TTL+LRU cache |
| `python/hermes_vault/models.py` | `TenantConfig`, `ActivePrompt` dataclasses |
| `python/hermes_vault/exceptions.py` | Exception hierarchy |

### TypeScript SDK (7 files)
| File | Purpose |
|---|---|
| `typescript/package.json` | Package metadata, zero runtime deps |
| `typescript/tsconfig.json` | TypeScript compiler config |
| `typescript/src/index.ts` | Public API re-exports |
| `typescript/src/client.ts` | `HermesVault` class — 3 async methods + invalidate |
| `typescript/src/cache.ts` | `TenantCache` generic TTL+LRU cache |
| `typescript/src/models.ts` | `TenantConfig`, `ActivePrompt` interfaces |
| `typescript/src/exceptions.ts` | Exception hierarchy |

**Total: 16 files**

---

## Verification

Test end-to-end against local Sentinel (port 8001, already running with test data).

### Python SDK

```python
from hermes_vault import HermesVault

vault = HermesVault(
    sentinel_url="http://localhost:8001",
    internal_key="dev-internal-key-change-in-production",
    service="phoenix",
)

# 1. Config
config = vault.get_config("sae_university")
assert config.enabled is True
assert "voice" in config.config

# 2. Secret (from cached config)
secret = vault.get_secret("sae_university", "twilio_account_sid")
assert isinstance(secret, str)

# 3. Prompt
prompt = vault.get_prompt("sae_university", "system_prompt")
assert "identity" in prompt.sections

# 4. Cache hit (instant, no HTTP)
config2 = vault.get_config("sae_university")

# 5. Invalidate + re-fetch
vault.invalidate("sae_university")
config3 = vault.get_config("sae_university")  # fresh HTTP call

# 6. Error: missing secret key
try:
    vault.get_secret("sae_university", "nonexistent_key")
    assert False
except VaultNotFoundError:
    pass

# 7. Error: wrong internal key
bad_vault = HermesVault(
    sentinel_url="http://localhost:8001",
    internal_key="wrong-key",
    service="phoenix",
)
try:
    bad_vault.get_config("sae_university")
    assert False
except VaultAuthError:
    pass
```

### TypeScript SDK

```typescript
import { HermesVault } from "@meridian-ventures/hermes-vault";

const vault = new HermesVault({
  sentinelUrl: "http://localhost:8001",
  internalKey: "dev-internal-key-change-in-production",
  service: "phoenix",
});

// Same 7 steps as Python, using camelCase
const config = await vault.getConfig("sae_university");
const secret = await vault.getSecret("sae_university", "twilio_account_sid");
const prompt = await vault.getPrompt("sae_university", "system_prompt");
vault.invalidate("sae_university");
```

### What to validate
1. Both SDK endpoints return correct data
2. Config caching works (second call doesn't hit Sentinel)
3. Prompt caching works with correct TTL
4. `invalidate()` clears the cache and next call makes a fresh HTTP request
5. `VaultNotFoundError` for missing config, missing secret key, or missing prompt
6. `VaultAuthError` for wrong/missing `X-Internal-Key`
7. `npm run build` succeeds (TypeScript compiles cleanly)
8. `pip install -e ./python` succeeds (Python installs cleanly)

---

## Local Development Environment

### Sentinel Server

The Sentinel server is **already running locally** on `http://localhost:8001`, connected to a local PostgreSQL database (`hermes-postgres` Docker container, database `hermes_local`). The server has test data loaded (tenants, configs, prompts, service accounts).

- **Base URL:** `http://localhost:8001`
- **Internal Key:** `dev-internal-key-change-in-production`
- **Test tenant:** `sae_university`

If the server is not running, start it from the Sentinel repo:
```bash
cd C:\Dev\Meridian\hermes-sentinel
poetry run uvicorn src.sentinel.main:app --reload --host 0.0.0.0 --port 8001
```

If the database container is not running:
```bash
docker start hermes-postgres
```

### Quick smoke test (PowerShell)
```powershell
# Health check
Invoke-RestMethod -Uri http://localhost:8001/api/v1/health

# Config endpoint (what the SDK calls)
$headers = @{ "X-Internal-Key" = "dev-internal-key-change-in-production" }
Invoke-RestMethod -Uri "http://localhost:8001/api/v1/vault/configs/sae_university/phoenix" -Headers $headers

# Prompt endpoint (what the SDK calls)
Invoke-RestMethod -Uri "http://localhost:8001/api/v1/prompts/sae_university/phoenix/system_prompt/active" -Headers $headers
```

---

## Sentinel Source Reference (for looking at request/response shapes)

The Sentinel codebase is at `C:\Dev\Meridian\hermes-sentinel`. Key files to reference when building the SDK:

### API Endpoints (route definitions + request/response wiring)
| File | What it contains |
|---|---|
| `C:\Dev\Meridian\hermes-sentinel\src\sentinel\api\v1\endpoints\vault_configs.py` | `GET` and `PATCH /api/v1/vault/configs/{tenant_id}/{service}` — the config endpoint the SDK calls |
| `C:\Dev\Meridian\hermes-sentinel\src\sentinel\api\v1\endpoints\prompts.py` | `GET .../active`, `GET .../versions`, `POST .../versions`, `POST /ensure` — the prompt endpoints |
| `C:\Dev\Meridian\hermes-sentinel\src\sentinel\api\router.py` | How all routers are wired together under `/api/v1/` |
| `C:\Dev\Meridian\hermes-sentinel\src\sentinel\main.py` | FastAPI app entry point |

### Pydantic Schemas (exact JSON response shapes)
| File | What it contains |
|---|---|
| `C:\Dev\Meridian\hermes-sentinel\src\sentinel\schemas\internal_config.py` | `ConfigResponse` (tenant_id, service, enabled, config, secrets) and `ConfigUpdateRequest` |
| `C:\Dev\Meridian\hermes-sentinel\src\sentinel\schemas\prompt.py` | `ActivePromptResponse`, `PromptVersionListItem`, `CreatePromptVersionRequest/Response`, `EnsurePromptRequest/Response` |

### Auth Dependencies
| File | What it contains |
|---|---|
| `C:\Dev\Meridian\hermes-sentinel\src\sentinel\api\deps.py` | `require_service_auth` (validates X-Internal-Key) and `require_user_auth` (validates JWT) |

### Service Layer (business logic)
| File | What it contains |
|---|---|
| `C:\Dev\Meridian\hermes-sentinel\src\sentinel\services\tenant_config_service.py` | `get_merged_config()` — merges global + service config, decrypts secrets |
| `C:\Dev\Meridian\hermes-sentinel\src\sentinel\services\prompt_service.py` | `get_active_prompt()` — tenant-specific with fallback to default |

### Database Models
| File | What it contains |
|---|---|
| `C:\Dev\Meridian\hermes-sentinel\src\sentinel\models\tenant_configuration.py` | `TenantConfiguration` SQLAlchemy model |
| `C:\Dev\Meridian\hermes-sentinel\src\sentinel\models\prompt.py` | `Prompt` and `PromptVersion` SQLAlchemy models |

### Config & Encryption
| File | What it contains |
|---|---|
| `C:\Dev\Meridian\hermes-sentinel\src\sentinel\config.py` | `Settings` class — all env vars including `INTERNAL_SERVICE_KEY`, `VAULT_ENCRYPTION_KEY` |
| `C:\Dev\Meridian\hermes-sentinel\src\sentinel\core\security\encryption.py` | AES-GCM encryption/decryption with HKDF per-tenant key derivation |

### LLD (design document)
| File | What it contains |
|---|---|
| `C:\Dev\Meridian\hermes-sentinel\hermes-vault-lld.md` | Full low-level design document for Hermes Vault |
