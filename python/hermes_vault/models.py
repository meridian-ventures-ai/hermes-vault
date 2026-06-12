from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# ---------------------------------------------------------------------------
# Read models
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Write models
# ---------------------------------------------------------------------------


@dataclass
class PromptVersion:
    """Single entry in a prompt's version history.

    Attributes:
        id: Version UUID.
        version: Version number.
        version_name: Human-readable version label.
        version_note: Optional longer description of changes.
        is_active: Whether this version is currently active.
        created_by: User ID of the creator, or ``None``.
        created_at: ISO-8601 timestamp of creation.
    """

    id: str
    version: int
    version_name: str
    version_note: str | None
    is_active: bool
    created_by: int | None
    created_at: str


@dataclass
class CreatedPromptVersion:
    """Response after creating a new prompt version.

    Attributes:
        id: New version UUID.
        prompt_id: Parent prompt UUID.
        version: Assigned version number.
        version_name: Human-readable version label.
        is_active: Always ``True`` — new versions are automatically activated.
    """

    id: str
    prompt_id: str
    version: int
    version_name: str
    is_active: bool


@dataclass
class EnsuredPrompt:
    """Response from idempotent find-or-create of a prompt slot.

    Attributes:
        id: Prompt UUID.
        tenant_id: Tenant ID, or ``None`` for default/fallback prompts.
        service: Service name.
        prompt_key: Prompt key.
        created: ``True`` if a new prompt was created, ``False`` if it already existed.
    """

    id: str
    tenant_id: str | None
    service: str
    prompt_key: str
    created: bool