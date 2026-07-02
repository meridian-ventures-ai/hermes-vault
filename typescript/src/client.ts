import { TenantCache } from "./cache";
import {
  VaultAuthError,
  VaultConnectionError,
  VaultHttpError,
  VaultNotFoundError,
} from "./exceptions";
import {
  ActivePrompt,
  BulkPromptEntry,
  BulkServiceData,
  BulkTenantEntry,
  CreatedPromptVersion,
  EnsuredPrompt,
  PromptListItem,
  PromptVersion,
  PromptVersionDetail,
  TenantConfig,
} from "./models";

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

function snakeToCamelTopLevel(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
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
export class HermesVault {
  private readonly baseUrl: string;
  private authHeaders: Record<string, string>;
  private readonly service: string;
  private readonly isJwt: boolean;
  private operatingTenantId?: string;
  private readonly configCache: TenantCache<TenantConfig>;
  private readonly promptCache: TenantCache<ActivePrompt>;

  constructor(options: HermesVaultOptions) {
    if (!options.internalKey && !options.jwtToken) {
      throw new Error("Provide either internalKey or jwtToken");
    }
    if (options.internalKey && options.jwtToken) {
      throw new Error("Provide only one of internalKey or jwtToken, not both");
    }

    this.baseUrl = options.sentinelUrl.replace(/\/+$/, "");
    this.service = options.service;
    this.operatingTenantId = options.operatingTenantId;
    this.isJwt = !!options.jwtToken;

    if (options.internalKey) {
      this.authHeaders = { "X-Internal-Key": options.internalKey };
    } else {
      this.authHeaders = { Authorization: `Bearer ${options.jwtToken}` };
    }

    const maxCacheSize = options.maxCacheSize ?? 100;
    this.configCache = new TenantCache<TenantConfig>(
      options.configTtlSeconds ?? null,
      maxCacheSize
    );
    this.promptCache = new TenantCache<ActivePrompt>(
      options.promptTtlSeconds ?? null,
      maxCacheSize
    );
  }

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
  setOperatingTenantId(tenantId: string | undefined): void {
    this.operatingTenantId = tenantId;
  }

  /**
   * Update the JWT token used for authentication.
   *
   * Call this when the token is refreshed so the existing instance
   * picks up the new credentials without being recreated.
   *
   * @param token - Fresh JWT token, or `null` to clear.
   */
  setAccessToken(token: string | null): void {
    if (token) {
      this.authHeaders = { Authorization: `Bearer ${token}` };
    }
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    let response: Response;
    try {
      const headers: Record<string, string> = { ...this.authHeaders };
      if (this.isJwt && this.operatingTenantId) {
        headers["X-Operating-Tenant-Id"] = this.operatingTenantId;
      }
      const init: RequestInit = {
        method,
        headers,
      };
      if (body !== undefined) {
        (init.headers as Record<string, string>)["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch (err) {
      throw new VaultConnectionError(
        `Connection failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (response.ok) {
      return await response.json();
    }

    let detail: string;
    try {
      const errBody = await response.json();
      detail = (errBody as Record<string, string>).detail ?? response.statusText;
    } catch {
      detail = response.statusText;
    }

    if (response.status === 401 || response.status === 403) {
      throw new VaultAuthError(response.status, detail);
    }
    if (response.status === 404) {
      throw new VaultNotFoundError(detail);
    }
    throw new VaultHttpError(response.status, detail);
  }

  private convertTopLevel(obj: unknown): Record<string, unknown> {
    return snakeToCamelTopLevel(obj as Record<string, unknown>);
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
  async getConfig(tenantId: string): Promise<TenantConfig> {
    const cached = this.configCache.get(tenantId);
    if (cached !== null) return cached;

    const raw = await this.request(
      "GET",
      `/api/v1/vault/configs/${tenantId}/${this.service}`
    );
    const data = this.convertTopLevel(raw);
    const config: TenantConfig = {
      tenantId: data.tenantId as string,
      service: data.service as string,
      enabled: data.enabled as boolean,
      config: (data.config as Record<string, unknown>) ?? {},
      secrets: (data.secrets as Record<string, unknown>) ?? {},
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
  async getSecret(tenantId: string, key: string): Promise<string> {
    const config = await this.getConfig(tenantId);
    if (!(key in config.secrets)) {
      throw new VaultNotFoundError(`Secret key '${key}' not found`);
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
  async getPrompt(tenantId: string, promptKey: string): Promise<ActivePrompt> {
    const cacheKey = `${tenantId}:${promptKey}`;
    const cached = this.promptCache.get(cacheKey);
    if (cached !== null) return cached;

    const raw = await this.request(
      "GET",
      `/api/v1/prompts/${tenantId}/${this.service}/${promptKey}/active`
    );
    const data = this.convertTopLevel(raw);
    const prompt: ActivePrompt = {
      promptId: data.promptId as string,
      tenantId: (data.tenantId as string | null) ?? null,
      service: data.service as string,
      promptKey: data.promptKey as string,
      version: data.version as number,
      versionName: data.versionName as string,
      sections: (data.sections as Record<string, unknown>) ?? {},
    };
    this.promptCache.set(cacheKey, prompt);
    return prompt;
  }

  /**
   * Invalidate prompt cache entries for the operating tenant.
   *
   * Uses targeted `deletePrefix` when `operatingTenantId` is set,
   * otherwise falls back to clearing the entire prompt cache.
   */
  private invalidatePrompts(): void {
    if (this.operatingTenantId) {
      this.promptCache.deletePrefix(this.operatingTenantId);
    } else {
      this.promptCache.clear();
    }
  }

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
  invalidate(tenantId: string, resource?: "config" | "prompt"): void {
    if (resource === undefined || resource === "config") {
      this.configCache.delete(tenantId);
    }
    if (resource === undefined || resource === "prompt") {
      this.promptCache.deletePrefix(tenantId);
    }
  }

  // ------------------------------------------------------------------
  // Write operations (JWT auth only)
  // ------------------------------------------------------------------

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
  async updateConfig(
    tenantId: string,
    updates: {
      config?: Record<string, unknown>;
      secrets?: Record<string, string>;
    },
  ): Promise<TenantConfig> {
    const raw = await this.request(
      "PATCH",
      `/api/v1/vault/configs/${tenantId}/${this.service}`,
      updates,
    );
    this.configCache.delete(tenantId);

    const data = this.convertTopLevel(raw);
    return {
      tenantId: data.tenantId as string,
      service: data.service as string,
      enabled: data.enabled as boolean,
      config: (data.config as Record<string, unknown>) ?? {},
      secrets: (data.secrets as Record<string, unknown>) ?? {},
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
  async getPromptVersions(
    tenantId: string,
    promptKey: string,
  ): Promise<PromptVersion[]> {
    const raw = await this.request(
      "GET",
      `/api/v1/prompts/${tenantId}/${this.service}/${promptKey}/versions`,
    );
    return (raw as Record<string, unknown>[]).map((v) => {
      const d = this.convertTopLevel(v);
      return {
        id: String(d.id),
        version: d.version as number,
        versionName: d.versionName as string,
        versionNote: (d.versionNote as string | null) ?? null,
        isActive: d.isActive as boolean,
        createdBy: (d.createdBy as number | null) ?? null,
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
  async createPromptVersion(
    promptId: string,
    params: {
      sections: Record<string, unknown>;
      versionName: string;
      versionNote?: string;
      createdBy?: number;
      /** Set the new version as active immediately. Default `true`.
       * Ignored for the first version of a prompt (always activated). */
      activate?: boolean;
    },
  ): Promise<CreatedPromptVersion> {
    const body: Record<string, unknown> = {
      sections: params.sections,
      version_name: params.versionName,
      activate: params.activate ?? true,
    };
    if (params.versionNote !== undefined) body.version_note = params.versionNote;
    if (params.createdBy !== undefined) body.created_by = params.createdBy;

    const raw = await this.request(
      "POST",
      `/api/v1/prompts/${promptId}/versions`,
      body,
    );
    this.invalidatePrompts();

    const data = this.convertTopLevel(raw);
    return {
      id: String(data.id),
      promptId: String(data.promptId),
      version: data.version as number,
      versionName: data.versionName as string,
      isActive: data.isActive as boolean,
    };
  }

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
  async ensurePrompt(
    promptKey: string,
    tenantId?: string,
  ): Promise<EnsuredPrompt> {
    const body: Record<string, unknown> = {
      service: this.service,
      prompt_key: promptKey,
    };
    if (tenantId !== undefined) body.tenant_id = tenantId;

    const raw = await this.request("POST", "/api/v1/prompts/ensure", body);
    const data = this.convertTopLevel(raw);
    return {
      id: String(data.id),
      tenantId: (data.tenantId as string | null) ?? null,
      service: data.service as string,
      promptKey: data.promptKey as string,
      created: data.created as boolean,
    };
  }

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
  async listPrompts(options?: {
    service?: string;
    tenantId?: string;
  }): Promise<PromptListItem[]> {
    const params: string[] = [];
    if (options?.service !== undefined)
      params.push(`service=${encodeURIComponent(options.service)}`);
    if (options?.tenantId !== undefined)
      params.push(`tenant_id=${encodeURIComponent(options.tenantId)}`);
    let path = "/api/v1/prompts";
    if (params.length > 0) path += `?${params.join("&")}`;

    const raw = await this.request("GET", path);
    return (raw as Record<string, unknown>[]).map((v) => {
      const d = this.convertTopLevel(v);
      return {
        id: String(d.id),
        tenantId: (d.tenantId as string | null) ?? null,
        service: d.service as string,
        promptKey: d.promptKey as string,
        activeVersion: (d.activeVersion as number | null) ?? null,
        activeVersionName: (d.activeVersionName as string | null) ?? null,
        versionCount: (d.versionCount as number) ?? 0,
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
  async getVersionDetail(versionId: string): Promise<PromptVersionDetail> {
    const raw = await this.request(
      "GET",
      `/api/v1/prompts/versions/${versionId}`,
    );
    const data = this.convertTopLevel(raw);
    return {
      id: String(data.id),
      promptId: String(data.promptId),
      version: data.version as number,
      versionName: data.versionName as string,
      versionNote: (data.versionNote as string | null) ?? null,
      sections: (data.sections as Record<string, unknown>) ?? {},
      isActive: data.isActive as boolean,
      createdBy: (data.createdBy as number | null) ?? null,
      createdAt: String(data.createdAt),
    };
  }

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
  async activateVersion(versionId: string): Promise<PromptVersionDetail> {
    const raw = await this.request(
      "PATCH",
      `/api/v1/prompts/versions/${versionId}/activate`,
    );
    this.invalidatePrompts();

    const data = this.convertTopLevel(raw);
    return {
      id: String(data.id),
      promptId: String(data.promptId),
      version: data.version as number,
      versionName: data.versionName as string,
      versionNote: (data.versionNote as string | null) ?? null,
      sections: (data.sections as Record<string, unknown>) ?? {},
      isActive: data.isActive as boolean,
      createdBy: (data.createdBy as number | null) ?? null,
      createdAt: String(data.createdAt),
    };
  }

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
  async updateVersionMetadata(
    versionId: string,
    updates: {
      versionName?: string;
      versionNote?: string;
    },
  ): Promise<PromptVersionDetail> {
    const body: Record<string, unknown> = {};
    if (updates.versionName !== undefined) body.version_name = updates.versionName;
    if (updates.versionNote !== undefined) body.version_note = updates.versionNote;

    const raw = await this.request(
      "PATCH",
      `/api/v1/prompts/versions/${versionId}`,
      body,
    );
    this.invalidatePrompts();

    const data = this.convertTopLevel(raw);
    return {
      id: String(data.id),
      promptId: String(data.promptId),
      version: data.version as number,
      versionName: data.versionName as string,
      versionNote: (data.versionNote as string | null) ?? null,
      sections: (data.sections as Record<string, unknown>) ?? {},
      isActive: data.isActive as boolean,
      createdBy: (data.createdBy as number | null) ?? null,
      createdAt: String(data.createdAt),
    };
  }

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
  async deleteVersion(versionId: string): Promise<void> {
    await this.request("DELETE", `/api/v1/prompts/versions/${versionId}`);
    this.invalidatePrompts();
  }

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
  async deletePrompt(promptId: string): Promise<void> {
    await this.request("DELETE", `/api/v1/prompts/${promptId}`);
    this.invalidatePrompts();
  }

  // ------------------------------------------------------------------
  // Bulk preload (Internal-Key auth, service startup)
  // ------------------------------------------------------------------

  /**
   * Preload all tenant configs, secrets, and active prompts into cache.
   *
   * Fetches everything the service needs across all tenants in a single
   * HTTP call and populates the config and prompt caches. Designed for
   * service startup — call once, then use {@link getConfig},
   * {@link getSecret}, and {@link getPrompt} afterward (all cache hits,
   * zero round-trips).
   *
   * Returns the bulk data for logging or inspection (e.g. to check which
   * tenants were loaded). Use {@link BulkServiceData.tenantIds} on the
   * result to get the set of pre-warmed tenant IDs.
   *
   * @returns BulkServiceData with per-tenant configs, secrets, and active prompts.
   * @throws {@link VaultAuthError} Internal key is missing or invalid (401/403).
   * @throws {@link VaultConnectionError} Sentinel is unreachable or timed out.
   */
  async preload(): Promise<BulkServiceData> {
    const raw = await this.request(
      "GET",
      `/api/v1/vault/configs/bulk/${this.service}`,
    );
    const data = raw as Record<string, unknown>;
    const rawTenants = (data.tenants ?? {}) as Record<string, Record<string, unknown>>;
    const serviceName = data.service as string;
    const bulkTenants: Record<string, BulkTenantEntry> = {};

    for (const [tid, tdata] of Object.entries(rawTenants)) {
      const config: TenantConfig = {
        tenantId: tid,
        service: serviceName,
        enabled: tdata.enabled as boolean,
        config: (tdata.config as Record<string, unknown>) ?? {},
        secrets: (tdata.secrets as Record<string, unknown>) ?? {},
      };
      this.configCache.set(tid, config);

      const rawPrompts = (tdata.prompts ?? {}) as Record<string, Record<string, unknown>>;
      const prompts: Record<string, BulkPromptEntry> = {};
      for (const [pkey, pdata] of Object.entries(rawPrompts)) {
        const pd = this.convertTopLevel(pdata);
        const prompt: ActivePrompt = {
          promptId: "",
          tenantId: tid,
          service: serviceName,
          promptKey: pkey,
          version: pd.version as number,
          versionName: pd.versionName as string,
          sections: (pd.sections as Record<string, unknown>) ?? {},
        };
        this.promptCache.set(`${tid}:${pkey}`, prompt);
        prompts[pkey] = {
          version: pd.version as number,
          versionName: pd.versionName as string,
          sections: (pd.sections as Record<string, unknown>) ?? {},
        };
      }

      bulkTenants[tid] = {
        enabled: tdata.enabled as boolean,
        config: (tdata.config as Record<string, unknown>) ?? {},
        secrets: (tdata.secrets as Record<string, unknown>) ?? {},
        prompts,
      };
    }

    return new BulkServiceData(serviceName, bulkTenants);
  }
}