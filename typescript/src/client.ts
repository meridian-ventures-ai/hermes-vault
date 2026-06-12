import { TenantCache } from "./cache";
import {
  VaultAuthError,
  VaultConnectionError,
  VaultHttpError,
  VaultNotFoundError,
} from "./exceptions";
import {
  ActivePrompt,
  CreatedPromptVersion,
  EnsuredPrompt,
  PromptVersion,
  TenantConfig,
} from "./models";

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
export class HermesVault {
  private readonly baseUrl: string;
  private readonly authHeaders: Record<string, string>;
  private readonly service: string;
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

    if (options.internalKey) {
      this.authHeaders = { "X-Internal-Key": options.internalKey };
    } else {
      this.authHeaders = { Authorization: `Bearer ${options.jwtToken}` };
    }

    const maxCacheSize = options.maxCacheSize ?? 100;
    this.configCache = new TenantCache<TenantConfig>(
      options.configTtlSeconds ?? 600,
      maxCacheSize
    );
    this.promptCache = new TenantCache<ActivePrompt>(
      options.promptTtlSeconds ?? 300,
      maxCacheSize
    );
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers: { ...this.authHeaders },
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
   * Clear all cached config and prompt entries for a tenant.
   *
   * Call this when the dashboard updates a tenant's config or prompts.
   * The next {@link getConfig} / {@link getPrompt} call will re-fetch from Sentinel.
   *
   * @param tenantId - Tenant identifier to invalidate.
   */
  invalidate(tenantId: string): void {
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
  async createPromptVersion(
    promptId: string,
    params: {
      sections: Record<string, unknown>;
      versionName: string;
      versionNote?: string;
      createdBy?: number;
    },
  ): Promise<CreatedPromptVersion> {
    const body: Record<string, unknown> = {
      sections: params.sections,
      version_name: params.versionName,
    };
    if (params.versionNote !== undefined) body.version_note = params.versionNote;
    if (params.createdBy !== undefined) body.created_by = params.createdBy;

    const raw = await this.request(
      "POST",
      `/api/v1/prompts/${promptId}/versions`,
      body,
    );
    this.promptCache.clear();

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
   *
   * @param promptKey - Prompt key (e.g. `"system_prompt"`).
   * @param tenantId - Tenant identifier, or `undefined` for a default/fallback prompt.
   * @returns EnsuredPrompt with `.created` indicating if it was newly created.
   * @throws {@link VaultAuthError} JWT is missing or invalid (401/403).
   * @throws {@link VaultHttpError} Validation error or server error.
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
}