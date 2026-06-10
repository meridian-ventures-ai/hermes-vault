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

---

## Local Development

### Testing SDK changes in consuming services

When you're modifying the SDK and want to test immediately in a consuming service (e.g. Phoenix, Hermes Core), use editable/linked installs so changes take effect without reinstalling.

#### Python (Phoenix, URAG, Notifications)

Install the SDK in editable mode from the consuming service's environment:

```bash
# From the consuming service's virtualenv / poetry shell:
pip install -e C:\Dev\Meridian\hermes-vault\python
```

Any change you make to `hermes-vault/python/hermes_vault/*.py` is picked up immediately — no reinstall needed. Just restart the consuming service if it's already running.

#### TypeScript (Hermes Core)

Link the SDK locally using `npm link`:

```bash
# Step 1: In the SDK directory, build and create a global link
cd C:\Dev\Meridian\hermes-vault\typescript
npm run build
npm link

# Step 2: In the consuming project, link to the SDK
cd C:\Dev\Meridian\hermes-core
npm link @meridian-ventures/hermes-vault
```

After linking, rebuild the SDK whenever you change `.ts` source files:

```bash
cd C:\Dev\Meridian\hermes-vault\typescript
npm run build
```

The consuming project picks up the new build immediately. To unlink when done:

```bash
cd C:\Dev\Meridian\hermes-core
npm unlink @meridian-ventures/hermes-vault
```

---

## Updating the SDK When Sentinel Changes

When a Sentinel endpoint consumed by the SDK is modified (response shape, new fields, path change, etc.), follow this order:

1. **Update `CONTRACT.md`** — this is the source of truth. Document the new/changed response shape, fields, or endpoint path.

2. **Update `python/hermes_vault/`** — modify `models.py` (add/change dataclass fields), then `client.py` (update field mapping in `get_config` or `get_prompt`).

3. **Update `typescript/src/`** — mirror the same changes: `models.ts` (interface fields), then `client.ts` (field mapping).

4. **Verify both SDKs** — run both against local Sentinel to confirm the changes work end-to-end.

5. **Bump version** — update `python/pyproject.toml` and `typescript/package.json`, add a `CHANGELOG.md` entry.

The rule: CONTRACT.md first, then both SDKs in lockstep, never one without the other.

---

## API Reference

See [CONTRACT.md](CONTRACT.md) for the Sentinel endpoint and response shape reference.

## Cache Behavior

- **Lazy loading**: nothing fetched at startup. First request per tenant triggers a fetch.
- **TTL**: configs default to 10 min, prompts to 5 min.
- **LRU eviction**: when cache exceeds `max_cache_size` (default 100), oldest-accessed entry is evicted.
- **`invalidate(tenant_id)`**: clears all cache entries for that tenant immediately.