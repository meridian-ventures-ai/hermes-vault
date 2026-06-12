// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Write models
// ---------------------------------------------------------------------------

/** Single entry in a prompt's version history. */
export interface PromptVersion {
  /** Version UUID. */
  id: string;
  /** Version number. */
  version: number;
  /** Human-readable version label. */
  versionName: string;
  /** Optional longer description of changes. */
  versionNote: string | null;
  /** Whether this version is currently active. */
  isActive: boolean;
  /** User ID of the creator, or `null`. */
  createdBy: number | null;
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
}

/** Response after creating a new prompt version. */
export interface CreatedPromptVersion {
  /** New version UUID. */
  id: string;
  /** Parent prompt UUID. */
  promptId: string;
  /** Assigned version number. */
  version: number;
  /** Human-readable version label. */
  versionName: string;
  /** Always `true` — new versions are automatically activated. */
  isActive: boolean;
}

/** Response from idempotent find-or-create of a prompt slot. */
export interface EnsuredPrompt {
  /** Prompt UUID. */
  id: string;
  /** Tenant ID, or `null` for default/fallback prompts. */
  tenantId: string | null;
  /** Service name. */
  service: string;
  /** Prompt key. */
  promptKey: string;
  /** `true` if a new prompt was created, `false` if it already existed. */
  created: boolean;
}