"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HermesVault = void 0;
const cache_1 = require("./cache");
const exceptions_1 = require("./exceptions");
function snakeToCamelTopLevel(obj) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        result[camelKey] = value;
    }
    return result;
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
class HermesVault {
    baseUrl;
    authHeaders;
    service;
    operatingTenantId;
    configCache;
    promptCache;
    constructor(options) {
        if (!options.internalKey && !options.jwtToken) {
            throw new Error("Provide either internalKey or jwtToken");
        }
        if (options.internalKey && options.jwtToken) {
            throw new Error("Provide only one of internalKey or jwtToken, not both");
        }
        this.baseUrl = options.sentinelUrl.replace(/\/+$/, "");
        this.service = options.service;
        this.operatingTenantId = options.operatingTenantId;
        if (options.internalKey) {
            this.authHeaders = { "X-Internal-Key": options.internalKey };
        }
        else {
            this.authHeaders = { Authorization: `Bearer ${options.jwtToken}` };
        }
        const maxCacheSize = options.maxCacheSize ?? 100;
        this.configCache = new cache_1.TenantCache(options.configTtlSeconds ?? 600, maxCacheSize);
        this.promptCache = new cache_1.TenantCache(options.promptTtlSeconds ?? 300, maxCacheSize);
    }
    async request(method, path, body) {
        let response;
        try {
            const headers = { ...this.authHeaders };
            if (this.operatingTenantId && "Authorization" in headers) {
                headers["X-Operating-Tenant-Id"] = this.operatingTenantId;
            }
            const init = {
                method,
                headers,
            };
            if (body !== undefined) {
                init.headers["Content-Type"] = "application/json";
                init.body = JSON.stringify(body);
            }
            response = await fetch(`${this.baseUrl}${path}`, init);
        }
        catch (err) {
            throw new exceptions_1.VaultConnectionError(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (response.ok) {
            return await response.json();
        }
        let detail;
        try {
            const errBody = await response.json();
            detail = errBody.detail ?? response.statusText;
        }
        catch {
            detail = response.statusText;
        }
        if (response.status === 401 || response.status === 403) {
            throw new exceptions_1.VaultAuthError(response.status, detail);
        }
        if (response.status === 404) {
            throw new exceptions_1.VaultNotFoundError(detail);
        }
        throw new exceptions_1.VaultHttpError(response.status, detail);
    }
    convertTopLevel(obj) {
        return snakeToCamelTopLevel(obj);
    }
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
    async getConfig(tenantId) {
        const cached = this.configCache.get(tenantId);
        if (cached !== null)
            return cached;
        const raw = await this.request("GET", `/api/v1/vault/configs/${tenantId}/${this.service}`);
        const data = this.convertTopLevel(raw);
        const config = {
            tenantId: data.tenantId,
            service: data.service,
            enabled: data.enabled,
            config: data.config ?? {},
            secrets: data.secrets ?? {},
        };
        this.configCache.set(tenantId, config);
        return config;
    }
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
    async getSecret(tenantId, key) {
        const config = await this.getConfig(tenantId);
        if (!(key in config.secrets)) {
            throw new exceptions_1.VaultNotFoundError(`Secret key '${key}' not found`);
        }
        return String(config.secrets[key]);
    }
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
    async getPrompt(tenantId, promptKey) {
        const cacheKey = `${tenantId}:${promptKey}`;
        const cached = this.promptCache.get(cacheKey);
        if (cached !== null)
            return cached;
        const raw = await this.request("GET", `/api/v1/prompts/${tenantId}/${this.service}/${promptKey}/active`);
        const data = this.convertTopLevel(raw);
        const prompt = {
            promptId: data.promptId,
            tenantId: data.tenantId ?? null,
            service: data.service,
            promptKey: data.promptKey,
            version: data.version,
            versionName: data.versionName,
            sections: data.sections ?? {},
        };
        this.promptCache.set(cacheKey, prompt);
        return prompt;
    }
    /**
     * Clear all cached config and prompt entries for a tenant.
     *
     * Call this when the dashboard updates a tenant's config or prompts.
     * The next {@link getConfig} / {@link getPrompt} call will re-fetch from Sentinel.
     *
     * @param tenantId - Tenant identifier to invalidate.
     */
    invalidate(tenantId) {
        this.configCache.delete(tenantId);
        this.promptCache.deletePrefix(tenantId);
    }
    // ------------------------------------------------------------------
    // Write operations (JWT auth only)
    // ------------------------------------------------------------------
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
    async updateConfig(tenantId, updates) {
        const raw = await this.request("PATCH", `/api/v1/vault/configs/${tenantId}/${this.service}`, updates);
        this.configCache.delete(tenantId);
        const data = this.convertTopLevel(raw);
        return {
            tenantId: data.tenantId,
            service: data.service,
            enabled: data.enabled,
            config: data.config ?? {},
            secrets: data.secrets ?? {},
        };
    }
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
    async getPromptVersions(tenantId, promptKey) {
        const raw = await this.request("GET", `/api/v1/prompts/${tenantId}/${this.service}/${promptKey}/versions`);
        return raw.map((v) => {
            const d = this.convertTopLevel(v);
            return {
                id: String(d.id),
                version: d.version,
                versionName: d.versionName,
                versionNote: d.versionNote ?? null,
                isActive: d.isActive,
                createdBy: d.createdBy ?? null,
                createdAt: String(d.createdAt),
            };
        });
    }
    /**
     * Create a new prompt version.
     *
     * By default (`activate=true`), the new version is set as active and the
     * previous active version is deactivated. Pass `activate: false` to create
     * the version as a draft without changing the currently active version. The
     * first version of a prompt is always activated regardless of this flag.
     *
     * Clears all prompt caches.
     *
     * @param promptId - UUID of the parent prompt.
     * @param params - Version details.
     * @returns CreatedPromptVersion with the new version details.
     * @throws {@link VaultAuthError} JWT is missing or invalid (401/403).
     * @throws {@link VaultNotFoundError} Prompt ID does not exist (404).
     * @throws {@link VaultHttpError} Validation error or server error.
     */
    async createPromptVersion(promptId, params) {
        const body = {
            sections: params.sections,
            version_name: params.versionName,
            activate: params.activate ?? true,
        };
        if (params.versionNote !== undefined)
            body.version_note = params.versionNote;
        if (params.createdBy !== undefined)
            body.created_by = params.createdBy;
        const raw = await this.request("POST", `/api/v1/prompts/${promptId}/versions`, body);
        this.promptCache.clear();
        const data = this.convertTopLevel(raw);
        return {
            id: String(data.id),
            promptId: String(data.promptId),
            version: data.version,
            versionName: data.versionName,
            isActive: data.isActive,
        };
    }
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
    async ensurePrompt(promptKey, tenantId) {
        const body = {
            service: this.service,
            prompt_key: promptKey,
        };
        if (tenantId !== undefined)
            body.tenant_id = tenantId;
        const raw = await this.request("POST", "/api/v1/prompts/ensure", body);
        const data = this.convertTopLevel(raw);
        return {
            id: String(data.id),
            tenantId: data.tenantId ?? null,
            service: data.service,
            promptKey: data.promptKey,
            created: data.created,
        };
    }
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
    async listPrompts(service) {
        let path = "/api/v1/prompts";
        if (service !== undefined)
            path += `?service=${encodeURIComponent(service)}`;
        const raw = await this.request("GET", path);
        return raw.map((v) => {
            const d = this.convertTopLevel(v);
            return {
                id: String(d.id),
                tenantId: d.tenantId ?? null,
                service: d.service,
                promptKey: d.promptKey,
                activeVersion: d.activeVersion ?? null,
                activeVersionName: d.activeVersionName ?? null,
                versionCount: d.versionCount ?? 0,
                updatedAt: String(d.updatedAt),
            };
        });
    }
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
    async getVersionDetail(versionId) {
        const raw = await this.request("GET", `/api/v1/prompts/versions/${versionId}`);
        const data = this.convertTopLevel(raw);
        return {
            id: String(data.id),
            promptId: String(data.promptId),
            version: data.version,
            versionName: data.versionName,
            versionNote: data.versionNote ?? null,
            sections: data.sections ?? {},
            isActive: data.isActive,
            createdBy: data.createdBy ?? null,
            createdAt: String(data.createdAt),
        };
    }
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
    async activateVersion(versionId) {
        const raw = await this.request("PATCH", `/api/v1/prompts/versions/${versionId}/activate`);
        this.promptCache.clear();
        const data = this.convertTopLevel(raw);
        return {
            id: String(data.id),
            promptId: String(data.promptId),
            version: data.version,
            versionName: data.versionName,
            versionNote: data.versionNote ?? null,
            sections: data.sections ?? {},
            isActive: data.isActive,
            createdBy: data.createdBy ?? null,
            createdAt: String(data.createdAt),
        };
    }
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
    async updateVersionMetadata(versionId, updates) {
        const body = {};
        if (updates.versionName !== undefined)
            body.version_name = updates.versionName;
        if (updates.versionNote !== undefined)
            body.version_note = updates.versionNote;
        const raw = await this.request("PATCH", `/api/v1/prompts/versions/${versionId}`, body);
        const data = this.convertTopLevel(raw);
        return {
            id: String(data.id),
            promptId: String(data.promptId),
            version: data.version,
            versionName: data.versionName,
            versionNote: data.versionNote ?? null,
            sections: data.sections ?? {},
            isActive: data.isActive,
            createdBy: data.createdBy ?? null,
            createdAt: String(data.createdAt),
        };
    }
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
    async deleteVersion(versionId) {
        await this.request("DELETE", `/api/v1/prompts/versions/${versionId}`);
        this.promptCache.clear();
    }
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
    async deletePrompt(promptId) {
        await this.request("DELETE", `/api/v1/prompts/${promptId}`);
        this.promptCache.clear();
    }
    // ------------------------------------------------------------------
    // Bulk load (Internal-Key auth, service startup)
    // ------------------------------------------------------------------
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
    async getBulkConfig() {
        const raw = await this.request("GET", `/api/v1/vault/configs/bulk/${this.service}`);
        const data = raw;
        const rawTenants = (data.tenants ?? {});
        const tenants = {};
        for (const [tid, tdata] of Object.entries(rawTenants)) {
            const rawPrompts = (tdata.prompts ?? {});
            const prompts = {};
            for (const [pkey, pdata] of Object.entries(rawPrompts)) {
                const pd = this.convertTopLevel(pdata);
                prompts[pkey] = {
                    version: pd.version,
                    versionName: pd.versionName,
                    sections: pd.sections ?? {},
                };
            }
            tenants[tid] = {
                enabled: tdata.enabled,
                config: tdata.config ?? {},
                secrets: tdata.secrets ?? {},
                prompts,
            };
        }
        return { service: data.service, tenants };
    }
}
exports.HermesVault = HermesVault;
