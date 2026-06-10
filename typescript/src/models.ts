/** Merged config and decrypted secrets for a tenant/service pair. */
export interface TenantConfig {
  /** Tenant identifier (e.g. `"sae_university"`). */
  tenantId: string;
  /** Service name scoped in the constructor (e.g. `"phoenix"`). */
  service: string;
  /** Whether the tenant/service pair is active. */
  enabled: boolean;
  /** Non-sensitive operational settings (voice, model, thresholds, etc.). */
  config: Record<string, unknown>;
  /** Decrypted secret key-value pairs (API keys, tokens, etc.). */
  secrets: Record<string, unknown>;
}

/** Active prompt version returned by Sentinel. */
export interface ActivePrompt {
  /** Unique prompt identifier (UUID string). */
  promptId: string;
  /** Tenant ID, or `null` for default/fallback prompts. */
  tenantId: string | null;
  /** Service name (e.g. `"phoenix"`). */
  service: string;
  /** Prompt key (e.g. `"system_prompt"`). */
  promptKey: string;
  /** Active version number. */
  version: number;
  /** Human-readable version label. */
  versionName: string;
  /** Prompt content sections (e.g. `{ identity: "...", guidelines: "..." }`). */
  sections: Record<string, unknown>;
}