# Changelog

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