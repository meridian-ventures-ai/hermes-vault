from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class TenantConfig:
    """Merged config and decrypted secrets for a tenant/service pair.

    Attributes:
        tenant_id: Tenant identifier (e.g. ``"sae_university"``).
        service: Service name scoped in the constructor (e.g. ``"phoenix"``).
        enabled: Whether the tenant/service pair is active.
        config: Non-sensitive operational settings (voice, model, thresholds, etc.).
        secrets: Decrypted secret key-value pairs (API keys, tokens, etc.).
    """

    tenant_id: str
    service: str
    enabled: bool
    config: dict[str, Any] = field(default_factory=dict)
    secrets: dict[str, Any] = field(default_factory=dict)


@dataclass
class ActivePrompt:
    """Active prompt version returned by Sentinel.

    Attributes:
        prompt_id: Unique prompt identifier (UUID string).
        tenant_id: Tenant ID, or ``None`` for default/fallback prompts.
        service: Service name (e.g. ``"phoenix"``).
        prompt_key: Prompt key (e.g. ``"system_prompt"``).
        version: Active version number.
        version_name: Human-readable version label.
        sections: Prompt content sections (e.g. ``{"identity": "...", "guidelines": "..."}``).
    """

    prompt_id: str
    tenant_id: str | None
    service: str
    prompt_key: str
    version: int
    version_name: str
    sections: dict[str, Any] = field(default_factory=dict)