import { ActivePrompt, BulkServiceData, CreatedPromptVersion, EnsuredPrompt, PromptListItem, PromptVersion, PromptVersionDetail, TenantConfig } from "./models";
/**
 * Configuration options for the {@link HermesVault} client.
 *
 * Provide exactly one of `internalKey` or `jwtToken`.
 */
export interface HermesVaultOptions {
    /** Base URL of the Sentinel server (e.g. `"http://localhost:8000"`). */
    sentinelUrl: string;
    /** Service name used in all endpoint paths (e.g. `"phoenix"`). */
    service: string;
    /** Value sent as the `X-Internal-Key` header (service auth). */
    internalKey?: string;
    /** Bearer token sent as the `Authorization` header (dashboard auth). */
    jwtToken?: string;
    /** Initial active tenant ID for JWT dashboard auth.
     * Can be changed later via {@link HermesVault.setOperatingTenantId}.
     */
    operatingTenantId?: string;
    /** Cache TTL for config entries in seconds, or `null` for no expiration (default).
     * Entries persist until explicitly invalidated or evicted by LRU. */
    configTtlSeconds?: number | null;
    /** Cache TTL for prompt entries in seconds, or `null` for no expiration (default).
     * Entries persist until explicitly invalidated or evicted by LRU. */
    promptTtlSeconds?: number | null;
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
 * bypass and invalidate the cache automatically. When the operating tenant is
 * set (via constructor or {@link setOperatingTenantId}), prompt cache
 * invalidation is **tenant-scoped** (only the operating tenant's entries are
 * evicted). Without it, write methods fall back to clearing the entire prompt
 * cache.
 *
 * A single client instance is designed to be **long-lived** and shared.
 * When the dashboard user switches tenants, call
 * {@link setOperatingTenantId} rather than creating a new instance — this
 * preserves cached data for all tenants.
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
 * vault.setOperatingTenantId("sae_university");
 * await vault.updateConfig("sae_university", { config: { voice: "nova" } });
 * ```
 */
export declare class HermesVault {
    private readonly baseUrl;
    private authHeaders;
    private readonly service;
    private readonly isJwt;
    private operatingTenantId?;
    private readonly configCache;
    private readonly promptCache;
    constructor(options: HermesVaultOptions);
    /**
     * Set or clear the active tenant for write operations.
     *
     * Call this when the dashboard user switches tenants. The new value
     * is sent as the `X-Operating-Tenant-Id` header on subsequent
     * requests and used for targeted cache invalidation.
     *
     * The cache is **not** cleared — cached data from all tenants remains
     * available.
     *
     * @param tenantId - Tenant identifier to operate as, or `undefined` to clear.
     */
    setOperatingTenantId(tenantId: string | undefined): void;
    /**
     * Update the JWT token used for authentication.
     *
     * Call this when the token is refreshed so the existing instance
     * picks up the new credentials without being recreated.
     *
     * @param token - Fresh JWT token, or `null` to clear.
     */
    setAccessToken(token: string | null): void;
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
     * Invalidate prompt cache entries for the operating tenant.
     *
     * Uses targeted `deletePrefix` when `operatingTenantId` is set,
     * otherwise falls back to clearing the entire prompt cache.
     */
    private invalidatePrompts;
    /**
     * Clear cached entries for a tenant.
     *
     * When `resource` is provided, only the matching cache is cleared.
     * When omitted, both config and prompt caches are cleared.
     *
     * @param tenantId - Tenant identifier to invalidate.
     * @param resource - `"config"` or `"prompt"` to target a single cache,
     *   or `undefined` to clear both (default).
     */
    invalidate(tenantId: string, resource?: "config" | "prompt"): void;
    /**
     * Update config and/or secrets for a tenant/service pair.
     *
     * Sends a `PATCH` to Sentinel. Secrets are encrypted server-side
     * before storage. Invalidates the config cache for this tenant.
     * Sentinel enforces that `tenantId` matches the operating tenant
     * resolved from the JWT / `X-Operating-Tenant-Id` header.
     *
     * @param tenantId - Tenant identifier (e.g. `"sae_university"`).
     * @param updates - Object with optional `config` and/or `secrets` to merge.
     * @returns Updated TenantConfig with merged values.
     * @throws {@link VaultAuthError} JWT is missing or invalid (401/403).
     * @throws {@link VaultNotFoundError} Tenant/service pair does not exist (404).
     * @throws {@link VaultHttpError} Validation error, tenant mismatch (403), or server error.
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
     * By default (`activate=true`), the new version is set as active and the
     * previous active version is deactivated. Pass `activate: false` to create
     * the version as a draft without changing the currently active version. The
     * first version of a prompt is always activated regardless of this flag.
     *
     * Invalidates the prompt cache for the operating tenant. Sentinel
     * enforces that the prompt belongs to the operating tenant resolved
     * from the JWT / `X-Operating-Tenant-Id` header. Default prompts
     * (`tenant_id IS NULL`) can be versioned by any authenticated user.
     *
     * @param promptId - UUID of the parent prompt.
     * @param params - Version details.
     * @returns CreatedPromptVersion with the new version details.
     * @throws {@link VaultAuthError} JWT is missing or invalid (401/403).
     * @throws {@link VaultNotFoundError} Prompt ID does not exist (404).
     * @throws {@link VaultHttpError} Validation error, tenant mismatch (403), or server error.
     */
    createPromptVersion(promptId: string, params: {
        sections: Record<string, unknown>;
        versionName: string;
        versionNote?: string;
        createdBy?: number;
        /** Set the new version as active immediately. Default `true`.
         * Ignored for the first version of a prompt (always activated). */
        activate?: boolean;
    }): Promise<CreatedPromptVersion>;
    /**
     * Idempotently find or create a prompt slot.
     *
     * If a prompt with the given `tenantId`/`service`/`promptKey` already
     * exists, returns it. Otherwise creates a new empty prompt slot.
     * Sentinel enforces that `tenantId` matches the operating tenant
     * resolved from the JWT / `X-Operating-Tenant-Id` header.
     *
     * @param promptKey - Prompt key (e.g. `"system_prompt"`).
     * @param tenantId - Tenant identifier, or `undefined` for a default/fallback prompt.
     * @returns EnsuredPrompt with `.created` indicating if it was newly created.
     * @throws {@link VaultAuthError} JWT is missing or invalid (401/403).
     * @throws {@link VaultHttpError} Validation error, tenant mismatch (403), or server error.
     */
    ensurePrompt(promptKey: string, tenantId?: string): Promise<EnsuredPrompt>;
    /**
     * List prompt slots, optionally scoped to defaults.
     *
     * Without `tenantId`, lists prompts for the caller's operating tenant.
     * Pass `"_default"` to list system-wide default/fallback prompts
     * (`tenant_id IS NULL`).
     *
     * Requires JWT auth.
     *
     * @param options - Optional filters.
     * @param options.service - Filter results to this service name.
     * @param options.tenantId - `"_default"` to list default prompts, an explicit
     *   tenant ID, or `undefined` to use the authenticated user's operating tenant.
     * @returns Array of PromptListItem entries.
     * @throws {@link VaultAuthError} JWT is missing or invalid (401/403).
     */
    listPrompts(options?: {
        service?: string;
        tenantId?: string;
    }): Promise<PromptListItem[]>;
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
     * one. Invalidates the prompt cache for the operating tenant.
     * Requires JWT auth.
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
     * creating a new version. Invalidates the prompt cache for the
     * operating tenant. Requires JWT auth.
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
     * auto-activated. Invalidates the prompt cache for the operating tenant.
     * Requires JWT auth.
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
     * Invalidates the prompt cache for the operating tenant.
     * Requires JWT auth.
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
