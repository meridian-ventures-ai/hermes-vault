import { ActivePrompt, BulkServiceData, CreatedPromptVersion, EnsuredPrompt, PromptListItem, PromptVersion, PromptVersionDetail, TenantConfig } from "./models";
/**
 * Configuration options for the {@link HermesVault} client.
 *
 * Provide exactly one of `internalKey` or `jwtToken`.
 */
export interface HermesVaultOptions {
    /** Base URL of the Sentinel server (e.g. `"http://localhost:8001"`). */
    sentinelUrl: string;
    /** Service name used in all endpoint paths (e.g. `"phoenix"`). */
    service: string;
    /** Value sent as the `X-Internal-Key` header (service auth). */
    internalKey?: string;
    /** Bearer token sent as the `Authorization` header (dashboard auth). */
    jwtToken?: string;
    /** Cache TTL for config entries in seconds. Default `600` (10 min). */
    configTtlSeconds?: number;
    /** Cache TTL for prompt entries in seconds. Default `300` (5 min). */
    promptTtlSeconds?: number;
    /** Max tenants kept in each LRU cache. Default `100`. */
    maxCacheSize?: number;
}
/**
 * Client for fetching and managing tenant-scoped config, secrets, and prompts via Sentinel.
 *
 * Supports two auth modes:
 * - **Internal key** (`X-Internal-Key`) — for backend services (read-only).
 * - **JWT** (`Authorization: Bearer`) — for the dashboard (read + write).
 *
 * Read responses are cached in-memory with TTL + LRU eviction. Write methods
 * bypass and invalidate the cache automatically.
 *
 * @example Service mode
 * ```ts
 * const vault = new HermesVault({
 *   sentinelUrl: "http://localhost:8001",
 *   internalKey: "dev-internal-key-change-in-production",
 *   service: "phoenix",
 * });
 * const config = await vault.getConfig("sae_university");
 * ```
 *
 * @example Dashboard mode
 * ```ts
 * const vault = new HermesVault({
 *   sentinelUrl: "http://localhost:8001",
 *   jwtToken: "eyJhbGciOi...",
 *   service: "phoenix",
 * });
 * await vault.updateConfig("sae_university", { config: { voice: "nova" } });
 * ```
 */
export declare class HermesVault {
    private readonly baseUrl;
    private readonly authHeaders;
    private readonly service;
    private readonly configCache;
    private readonly promptCache;
    constructor(options: HermesVaultOptions);
    private request;
    private convertTopLevel;
    /**
     * Fetch merged config and secrets for a tenant.
     *
     * Returns a cached result if available and not expired, otherwise
     * calls `GET /api/v1/vault/configs/{tenantId}/{service}`.
     *
     * @param tenantId - Tenant identifier (e.g. `"sae_university"`).
     * @returns TenantConfig with `.config` and `.secrets` dicts.
     * @throws {@link VaultNotFoundError} Tenant/service pair does not exist (404).
     * @throws {@link VaultAuthError} Invalid or missing internal key (401/403).
     * @throws {@link VaultConnectionError} Sentinel is unreachable or timed out.
     */
    getConfig(tenantId: string): Promise<TenantConfig>;
    /**
     * Extract a single secret value from the tenant's cached config.
     *
     * Calls {@link getConfig} internally (cache hit on subsequent calls)
     * and returns `secrets[key]`. No extra HTTP request is made.
     *
     * @param tenantId - Tenant identifier (e.g. `"sae_university"`).
     * @param key - Secret key to extract (e.g. `"twilio_account_sid"`).
     * @returns The secret value as a string.
     * @throws {@link VaultNotFoundError} The secret key does not exist in the tenant's secrets.
     */
    getSecret(tenantId: string, key: string): Promise<string>;
    /**
     * Fetch the active prompt version for a tenant and prompt key.
     *
     * Returns a cached result if available and not expired, otherwise
     * calls `GET /api/v1/prompts/{tenantId}/{service}/{promptKey}/active`.
     * Sentinel tries tenant-specific first, then falls back to the default prompt.
     *
     * @param tenantId - Tenant identifier (e.g. `"sae_university"`).
     * @param promptKey - Prompt key (e.g. `"system_prompt"`, `"call_summary_prompt"`).
     * @returns ActivePrompt with `.sections` dict containing prompt content.
     * @throws {@link VaultNotFoundError} No active prompt found for this tenant/key (404).
     * @throws {@link VaultAuthError} Invalid or missing internal key (401/403).
     * @throws {@link VaultConnectionError} Sentinel is unreachable or timed out.
     */
    getPrompt(tenantId: string, promptKey: string): Promise<ActivePrompt>;
    /**
     * Clear all cached config and prompt entries for a tenant.
     *
     * Call this when the dashboard updates a tenant's config or prompts.
     * The next {@link getConfig} / {@link getPrompt} call will re-fetch from Sentinel.
     *
     * @param tenantId - Tenant identifier to invalidate.
     */
    invalidate(tenantId: string): void;
    /**
     * Update config and/or secrets for a tenant/service pair.
     *
     * Sends a `PATCH` to Sentinel. Secrets are encrypted server-side
     * before storage. Invalidates the config cache for this tenant.
     *
     * @param tenantId - Tenant identifier (e.g. `"sae_university"`).
     * @param updates - Object with optional `config` and/or `secrets` to merge.
     * @returns Updated TenantConfig with merged values.
     * @throws {@link VaultAuthError} JWT is missing or invalid (401/403).
     * @throws {@link VaultNotFoundError} Tenant/service pair does not exist (404).
     * @throws {@link VaultHttpError} Validation error or server error.
     */
    updateConfig(tenantId: string, updates: {
        config?: Record<string, unknown>;
        secrets?: Record<string, string>;
    }): Promise<TenantConfig>;
    /**
     * Get full version history for a prompt.
     *
     * Uses exact `tenantId` match (no fallback). Pass `"_default"`
     * to query default/fallback prompts.
     *
     * @param tenantId - Tenant identifier, or `"_default"` for default prompts.
     * @param promptKey - Prompt key (e.g. `"system_prompt"`).
     * @returns Array of PromptVersion entries.
     * @throws {@link VaultAuthError} JWT is missing or invalid (401/403).
     */
    getPromptVersions(tenantId: string, promptKey: string): Promise<PromptVersion[]>;
    /**
     * Create a new prompt version.
     *
     * The new version is automatically set as active. The previous active
     * version is deactivated. Clears all prompt caches.
     *
     * @param promptId - UUID of the parent prompt.
     * @param params - Version details.
     * @returns CreatedPromptVersion with the new version details.
     * @throws {@link VaultAuthError} JWT is missing or invalid (401/403).
     * @throws {@link VaultNotFoundError} Prompt ID does not exist (404).
     * @throws {@link VaultHttpError} Validation error or server error.
     */
    createPromptVersion(promptId: string, params: {
        sections: Record<string, unknown>;
        versionName: string;
        versionNote?: string;
        createdBy?: number;
    }): Promise<CreatedPromptVersion>;
    /**
     * Idempotently find or create a prompt slot.
     *
     * If a prompt with the given `tenantId`/`service`/`promptKey` already
     * exists, returns it. Otherwise creates a new empty prompt slot.
     *
     * @param promptKey - Prompt key (e.g. `"system_prompt"`).
     * @param tenantId - Tenant identifier, or `undefined` for a default/fallback prompt.
     * @returns EnsuredPrompt with `.created` indicating if it was newly created.
     * @throws {@link VaultAuthError} JWT is missing or invalid (401/403).
     * @throws {@link VaultHttpError} Validation error or server error.
     */
    ensurePrompt(promptKey: string, tenantId?: string): Promise<EnsuredPrompt>;
    /**
     * List all prompt slots for the authenticated user's tenant.
     *
     * Requires JWT auth. The tenant is resolved from the JWT token.
     * Optionally filter by service name.
     *
     * @param service - Filter results to this service name, or `undefined` for all services.
     * @returns Array of PromptListItem entries.
     * @throws {@link VaultAuthError} JWT is missing or invalid (401/403).
     */
    listPrompts(service?: string): Promise<PromptListItem[]>;
    /**
     * Get full detail (including sections) for a single prompt version.
     *
     * Requires JWT auth.
     *
     * @param versionId - UUID of the prompt version.
     * @returns PromptVersionDetail with `.sections` content.
     * @throws {@link VaultAuthError} JWT is missing or invalid (401/403).
     * @throws {@link VaultNotFoundError} Version does not exist (404).
     */
    getVersionDetail(versionId: string): Promise<PromptVersionDetail>;
    /**
     * Set a specific version as the active version (rollback/promote).
     *
     * Deactivates the current active version and activates the specified
     * one. Clears all prompt caches. Requires JWT auth.
     *
     * @param versionId - UUID of the version to activate.
     * @returns PromptVersionDetail of the newly activated version.
     * @throws {@link VaultAuthError} JWT is missing or invalid (401/403).
     * @throws {@link VaultNotFoundError} Version does not exist (404).
     * @throws {@link VaultHttpError} Validation error or server error.
     */
    activateVersion(versionId: string): Promise<PromptVersionDetail>;
    /**
     * Update version_name and/or version_note for a prompt version.
     *
     * Does not modify the sections content — content changes require
     * creating a new version. Requires JWT auth.
     *
     * @param versionId - UUID of the version to update.
     * @param updates - Object with optional `versionName` and/or `versionNote`.
     * @returns PromptVersionDetail with updated metadata.
     * @throws {@link VaultAuthError} JWT is missing or invalid (401/403).
     * @throws {@link VaultNotFoundError} Version does not exist (404).
     * @throws {@link VaultHttpError} Validation error or server error.
     */
    updateVersionMetadata(versionId: string, updates: {
        versionName?: string;
        versionNote?: string;
    }): Promise<PromptVersionDetail>;
    /**
     * Delete a prompt version.
     *
     * Cannot delete the last remaining version — delete the prompt instead.
     * If the active version is deleted, the latest remaining version is
     * auto-activated. Clears all prompt caches. Requires JWT auth.
     *
     * @param versionId - UUID of the version to delete.
     * @throws {@link VaultAuthError} JWT is missing or invalid (401/403).
     * @throws {@link VaultNotFoundError} Version does not exist (404).
     * @throws {@link VaultHttpError} Cannot delete last version, or server error.
     */
    deleteVersion(versionId: string): Promise<void>;
    /**
     * Delete a prompt slot and all its versions.
     *
     * Clears all prompt caches. Requires JWT auth.
     *
     * @param promptId - UUID of the prompt to delete.
     * @throws {@link VaultAuthError} JWT is missing or invalid (401/403).
     * @throws {@link VaultNotFoundError} Prompt does not exist (404).
     * @throws {@link VaultHttpError} Server error.
     */
    deletePrompt(promptId: string): Promise<void>;
    /**
     * Bulk-load all configs, secrets, and active prompts for this service.
     *
     * Returns everything the service needs to operate across all tenants
     * in a single HTTP call. Designed for service startup to avoid
     * per-tenant round-trips.
     *
     * The result is **not cached** — call this once at startup and store
     * the result yourself.
     *
     * @returns BulkServiceData with per-tenant configs, secrets, and active prompts.
     * @throws {@link VaultAuthError} Internal key is missing or invalid (401/403).
     * @throws {@link VaultConnectionError} Sentinel is unreachable or timed out.
     */
    getBulkConfig(): Promise<BulkServiceData>;
}
