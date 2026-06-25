# Hermes Vault SDK

Tenant-scoped configuration, secrets, and prompts for the Hermes ecosystem.

Both SDKs wrap [Hermes Sentinel](../hermes-sentinel)'s `/api/v1/` endpoints with two auth modes:

- **Internal key** (`X-Internal-Key`) — for backend services, read-only.
- **JWT** (`Authorization: Bearer`) — for the dashboard, read + write.

## SDKs

| Package | Runtime | Consumers |
|---|---|---|
| `hermes-vault` (Python) | Python 3.11+ | Phoenix, URAG Indexing, Hermes Notifications |
| `@meridian-ventures/hermes-vault` (TypeScript) | Node.js 18+ | Hermes Core, Hermes Dashboard |

## Python SDK

### Install

```bash
pip install -e ./python
```

### Usage (service mode — internal key)

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

### Usage (dashboard mode — JWT)

```python
vault = HermesVault(
    sentinel_url="https://auth.sentinel.hermes-agent.com",
    jwt_token="<JWT_TOKEN>",
    service="phoenix",
)

# Set the active tenant (call again on tenant switch — cache is preserved)
vault.set_operating_tenant_id("sae_university")

# Update config/secrets
vault.update_config("sae_university", config={"voice": "nova"}, secrets={"api_key": "sk-..."})

# Prompt management
slot = vault.ensure_prompt("system_prompt", tenant_id="sae_university")
version = vault.create_prompt_version(
    prompt_id=slot.id,
    sections={"identity": "...", "guidelines": "..."},
    version_name="v4",
)

# Create a draft version without activating it
draft = vault.create_prompt_version(
    prompt_id=slot.id,
    sections={"identity": "...", "guidelines": "..."},
    version_name="v5 draft",
    activate=False,
)
versions = vault.get_prompt_versions("sae_university", "system_prompt")

# List all prompt slots for the tenant
prompts = vault.list_prompts(service="phoenix")

# Get full version detail (including sections)
detail = vault.get_version_detail(versions[0].id)

# Rollback to a previous version
vault.activate_version(versions[1].id)

# Update version metadata (name/note only)
vault.update_version_metadata(versions[0].id, version_name="v3 — revised")

# Delete a version or an entire prompt
vault.delete_version(versions[0].id)
vault.delete_prompt(slot.id)
```

### Usage (bulk load — service startup)

```python
vault = HermesVault(
    sentinel_url="https://auth.sentinel.hermes-agent.com",
    internal_key="<INTERNAL_SERVICE_KEY>",
    service="phoenix",
)

# Load everything at startup in a single call
bulk = vault.get_bulk_config()
for tenant_id, tenant_data in bulk.tenants.items():
    print(tenant_id, tenant_data.enabled, tenant_data.config)
    for prompt_key, prompt in tenant_data.prompts.items():
        print(f"  {prompt_key}: v{prompt.version} ({prompt.version_name})")
```

## TypeScript SDK

### Install

```bash
cd typescript
yarn install
yarn build
```

### Usage (service mode — internal key)

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

### Usage (dashboard mode — JWT)

```typescript
const vault = new HermesVault({
  sentinelUrl: "https://auth.sentinel.hermes-agent.com",
  jwtToken: "<JWT_TOKEN>",
  service: "phoenix",
});

// Set the active tenant (call again on tenant switch — cache is preserved)
vault.setOperatingTenantId("sae_university");

// Update config/secrets
await vault.updateConfig("sae_university", {
  config: { voice: "nova" },
  secrets: { api_key: "sk-..." },
});

// Prompt management
const slot = await vault.ensurePrompt("system_prompt", "sae_university");
const version = await vault.createPromptVersion(slot.id, {
  sections: { identity: "...", guidelines: "..." },
  versionName: "v4",
});

// Create a draft version without activating it
const draft = await vault.createPromptVersion(slot.id, {
  sections: { identity: "...", guidelines: "..." },
  versionName: "v5 draft",
  activate: false,
});
const versions = await vault.getPromptVersions("sae_university", "system_prompt");

// List all prompt slots for the tenant
const prompts = await vault.listPrompts("phoenix");

// Get full version detail (including sections)
const detail = await vault.getVersionDetail(versions[0].id);

// Rollback to a previous version
await vault.activateVersion(versions[1].id);

// Update version metadata (name/note only)
await vault.updateVersionMetadata(versions[0].id, { versionName: "v3 — revised" });

// Delete a version or an entire prompt
await vault.deleteVersion(versions[0].id);
await vault.deletePrompt(slot.id);
```

### Usage (bulk load — service startup)

```typescript
const vault = new HermesVault({
  sentinelUrl: "https://auth.sentinel.hermes-agent.com",
  internalKey: "<INTERNAL_SERVICE_KEY>",
  service: "phoenix",
});

// Load everything at startup in a single call
const bulk = await vault.getBulkConfig();
for (const [tenantId, tenantData] of Object.entries(bulk.tenants)) {
  console.log(tenantId, tenantData.enabled, tenantData.config);
  for (const [promptKey, prompt] of Object.entries(tenantData.prompts)) {
    console.log(`  ${promptKey}: v${prompt.version} (${prompt.versionName})`);
  }
}
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

Link the SDK locally using `yarn link`:

```bash
# Step 1: In the SDK directory, build and create a global link
cd C:\Dev\Meridian\hermes-vault\typescript
yarn build
yarn link

# Step 2: In the consuming project, link to the SDK
cd C:\Dev\Meridian\hermes-core
yarn link @meridian-ventures/hermes-vault
```

After linking, rebuild the SDK whenever you change `.ts` source files:

```bash
cd C:\Dev\Meridian\hermes-vault\typescript
yarn build
```

(Note: because `dist/` is tracked in git, you will usually want to commit the updated build artifacts too.)

The consuming project picks up the new build immediately. To unlink when done:

```bash
cd C:\Dev\Meridian\hermes-core
yarn unlink @meridian-ventures/hermes-vault
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
- **Targeted invalidation**: when the operating tenant is set (via constructor or `set_operating_tenant_id` / `setOperatingTenantId`), write methods invalidate only that tenant's prompt cache entries. Without it, write methods fall back to clearing the entire prompt cache.
- **Tenant switch**: call `set_operating_tenant_id` / `setOperatingTenantId` instead of creating a new instance — the cache is preserved across switches.
- **`invalidate(tenant_id)`**: clears all cache entries for that tenant immediately.