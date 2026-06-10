# Hermes Vault SDK

Tenant-scoped configuration, secrets, and prompts for the Hermes ecosystem.

Both SDKs are **read-only** wrappers around [Hermes Sentinel](../hermes-sentinel)'s `/api/v1/` endpoints, authenticated via `X-Internal-Key`. Write operations are performed by the dashboard directly via JWT.

## SDKs

| Package | Runtime | Consumers |
|---|---|---|
| `hermes-vault` (Python) | Python 3.11+ | Phoenix, URAG Indexing, Hermes Notifications |
| `@meridian-ventures/hermes-vault` (TypeScript) | Node.js 18+ | Hermes Core |

## Python SDK

### Install

```bash
pip install -e ./python
```

### Usage

```python
from hermes_vault import HermesVault

vault = HermesVault(
    sentinel_url="https://auth.sentinel.hermes-agent.com",
    internal_key="<INTERNAL_SERVICE_KEY>",
    service="phoenix",
)

# Fetch tenant config (cached for 10 min)
config = vault.get_config("sae_university")
print(config.enabled, config.config)

# Extract a single secret (no extra HTTP call — uses cached config)
twilio_sid = vault.get_secret("sae_university", "twilio_account_sid")

# Fetch active prompt (cached for 5 min)
prompt = vault.get_prompt("sae_university", "system_prompt")
print(prompt.sections)

# Invalidate cache for a tenant (e.g. after dashboard update)
vault.invalidate("sae_university")
```

## TypeScript SDK

### Install

```bash
cd typescript
npm install
npm run build
```

### Usage

```typescript
import { HermesVault } from "@meridian-ventures/hermes-vault";

const vault = new HermesVault({
  sentinelUrl: "https://auth.sentinel.hermes-agent.com",
  internalKey: "<INTERNAL_SERVICE_KEY>",
  service: "phoenix",
});

// Fetch tenant config (cached for 10 min)
const config = await vault.getConfig("sae_university");

// Extract a single secret (no extra HTTP call)
const twilioSid = await vault.getSecret("sae_university", "twilio_account_sid");

// Fetch active prompt (cached for 5 min)
const prompt = await vault.getPrompt("sae_university", "system_prompt");

// Invalidate cache
vault.invalidate("sae_university");
```

## API Reference

See [CONTRACT.md](CONTRACT.md) for the Sentinel endpoint and response shape reference.

## Cache Behavior

- **Lazy loading**: nothing fetched at startup. First request per tenant triggers a fetch.
- **TTL**: configs default to 10 min, prompts to 5 min.
- **LRU eviction**: when cache exceeds `max_cache_size` (default 100), oldest-accessed entry is evicted.
- **`invalidate(tenant_id)`**: clears all cache entries for that tenant immediately.