import { TenantCache } from "./cache";
import {
  VaultAuthError,
  VaultConnectionError,
  VaultHttpError,
  VaultNotFoundError,
} from "./exceptions";
import { ActivePrompt, TenantConfig } from "./models";

/** Configuration options for the {@link HermesVault} client. */
export interface HermesVaultOptions {
  /** Base URL of the Sentinel server (e.g. `"http://localhost:8001"`). */
  sentinelUrl: string;
  /** Value sent as the `X-Internal-Key` header for service auth. */
  internalKey: string;
  /** Service name used in all endpoint paths (e.g. `"phoenix"`). */
  service: string;
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
 * Read-only client for fetching tenant-scoped config, secrets, and prompts from Sentinel.
 *
 * All responses are cached in-memory with TTL + LRU eviction. The `service`
 * parameter is set once at construction and used implicitly in every call.
 *
 * @example
 * ```ts
 * const vault = new HermesVault({
 *   sentinelUrl: "http://localhost:8001",
 *   internalKey: "dev-internal-key-change-in-production",
 *   service: "phoenix",
 * });
 * const config = await vault.getConfig("sae_university");
 * const secret = await vault.getSecret("sae_university", "twilio_account_sid");
 * const prompt = await vault.getPrompt("sae_university", "system_prompt");
 * ```
 */
export class HermesVault {
  private readonly baseUrl: string;
  private readonly internalKey: string;
  private readonly service: string;
  private readonly configCache: TenantCache<TenantConfig>;
  private readonly promptCache: TenantCache<ActivePrompt>;

  constructor(options: HermesVaultOptions) {
    this.baseUrl = options.sentinelUrl.replace(/\/+$/, "");
    this.internalKey = options.internalKey;
    this.service = options.service;

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

  private async request(method: string, path: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { "X-Internal-Key": this.internalKey },
      });
    } catch (err) {
      throw new VaultConnectionError(
        `Connection failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (response.ok) {
      const json = await response.json();
      return snakeToCamelTopLevel(json as Record<string, unknown>);
    }

    let detail: string;
    try {
      const body = await response.json();
      detail = (body as Record<string, string>).detail ?? response.statusText;
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

    const data = await this.request(
      "GET",
      `/api/v1/vault/configs/${tenantId}/${this.service}`
    );
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

    const data = await this.request(
      "GET",
      `/api/v1/prompts/${tenantId}/${this.service}/${promptKey}/active`
    );
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
}