from __future__ import annotations

from typing import Any

import httpx

from hermes_vault.cache import TenantCache
from hermes_vault.exceptions import (
    VaultAuthError,
    VaultConnectionError,
    VaultHTTPError,
    VaultNotFoundError,
)
from hermes_vault.models import (
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
)


class HermesVault:
    """Client for fetching and managing tenant-scoped config, secrets, and prompts via Sentinel.

    Supports two auth modes:

    - **Internal key** (``X-Internal-Key``) — for backend services (read-only).
    - **JWT** (``Authorization: Bearer``) — for the dashboard (read + write).

    Read responses are cached in-memory with TTL + LRU eviction. Write methods
    bypass and invalidate the cache automatically. When the operating tenant is
    set (via constructor or ``set_operating_tenant_id``), prompt cache
    invalidation is **tenant-scoped** (only the operating tenant's entries are
    evicted). Without it, write methods fall back to clearing the entire prompt
    cache.

    A single client instance is designed to be **long-lived** and shared.
    When the dashboard user switches tenants, call
    ``set_operating_tenant_id`` rather than creating a new instance — this
    preserves cached data for all tenants.

    The ``service`` parameter is set once at construction and used implicitly
    in every call.

    Example (service mode)::

        vault = HermesVault(
            sentinel_url="http://localhost:8001",
            internal_key="dev-internal-key-change-in-production",
            service="phoenix",
        )
        config = vault.get_config("sae_university")

    Example (dashboard mode — singleton with per-request credential sync)::

        vault = HermesVault(
            sentinel_url="http://localhost:8001",
            jwt_token="eyJhbGciOi...",
            service="phoenix",
        )

        # Before each request, sync credentials from the session:
        vault.set_access_token(current_jwt_token)
        vault.set_operating_tenant_id("sae_university")
        vault.update_config("sae_university", config={"voice": "nova"})
    """

    def __init__(
        self,
        sentinel_url: str,
        service: str,
        internal_key: str | None = None,
        jwt_token: str | None = None,
        operating_tenant_id: str | None = None,
        config_ttl_seconds: int | None = None,
        prompt_ttl_seconds: int | None = None,
        max_cache_size: int = 100,
    ) -> None:
        """Initialise the Vault client.

        Provide exactly one of ``internal_key`` or ``jwt_token``.

        Args:
            sentinel_url: Base URL of the Sentinel server (e.g. ``"http://localhost:8001"``).
            service: Service name used in all endpoint paths (e.g. ``"phoenix"``).
            internal_key: Value sent as ``X-Internal-Key`` header (service auth).
            jwt_token: Bearer token sent as ``Authorization`` header (dashboard auth).
            operating_tenant_id: Initial active tenant ID for JWT dashboard auth.
                Can be changed later via ``set_operating_tenant_id``.
            config_ttl_seconds: Cache TTL for config entries in seconds, or ``None``
                for no expiration (default). Entries persist until explicitly
                invalidated or evicted by LRU.
            prompt_ttl_seconds: Cache TTL for prompt entries in seconds, or ``None``
                for no expiration (default). Entries persist until explicitly
                invalidated or evicted by LRU.
            max_cache_size: Max tenants kept in each LRU cache. Default ``100``.

        Raises:
            ValueError: If neither or both auth parameters are provided.
        """
        if not internal_key and not jwt_token:
            raise ValueError("Provide either internal_key or jwt_token")
        if internal_key and jwt_token:
            raise ValueError("Provide only one of internal_key or jwt_token, not both")

        self._service = service
        self._operating_tenant_id = operating_tenant_id
        self._is_jwt = jwt_token is not None

        self._auth_headers: dict[str, str] = {}
        if internal_key:
            self._auth_headers["X-Internal-Key"] = internal_key
        else:
            self._auth_headers["Authorization"] = f"Bearer {jwt_token}"

        self._http = httpx.Client(
            base_url=sentinel_url.rstrip("/"),
            timeout=30.0,
        )
        self._config_cache: TenantCache[TenantConfig] = TenantCache(
            config_ttl_seconds, max_cache_size
        )
        self._prompt_cache: TenantCache[ActivePrompt] = TenantCache(
            prompt_ttl_seconds, max_cache_size
        )

    def set_operating_tenant_id(self, tenant_id: str | None) -> None:
        """Set or clear the active tenant for write operations.

        Call this when the dashboard user switches tenants. The new value
        is sent as the ``X-Operating-Tenant-Id`` header on subsequent
        requests and used for targeted cache invalidation.

        The cache is **not** cleared — cached data from all tenants remains
        available.

        Args:
            tenant_id: Tenant identifier to operate as, or ``None`` to clear.
        """
        self._operating_tenant_id = tenant_id

    def set_access_token(self, token: str | None) -> None:
        """Update the JWT token used for authentication.

        Call this when the token is refreshed so the existing instance
        picks up the new credentials without being recreated.

        Args:
            token: Fresh JWT token, or ``None`` to clear.
        """
        if token:
            self._auth_headers = {"Authorization": f"Bearer {token}"}

    def _request(self, method: str, path: str, json: dict | None = None) -> dict:
        headers: dict[str, str] = {**self._auth_headers}
        if self._is_jwt and self._operating_tenant_id:
            headers["X-Operating-Tenant-Id"] = self._operating_tenant_id

        try:
            response = self._http.request(method, path, json=json, headers=headers)
        except httpx.TimeoutException as exc:
            raise VaultConnectionError(f"Request timed out: {exc}") from exc
        except httpx.ConnectError as exc:
            raise VaultConnectionError(f"Connection failed: {exc}") from exc
        except httpx.HTTPError as exc:
            raise VaultConnectionError(str(exc)) from exc

        if response.status_code in (200, 201):
            return response.json()

        detail = ""
        try:
            body = response.json()
            detail = body.get("detail", response.text)
        except Exception:
            detail = response.text

        if response.status_code in (401, 403):
            raise VaultAuthError(response.status_code, detail)
        if response.status_code == 404:
            raise VaultNotFoundError(detail)
        raise VaultHTTPError(response.status_code, detail)

    def get_config(self, tenant_id: str) -> TenantConfig:
        """Fetch merged config and secrets for a tenant.

        Returns a cached result if available and not expired, otherwise
        calls ``GET /api/v1/vault/configs/{tenant_id}/{service}``.

        Args:
            tenant_id: Tenant identifier (e.g. ``"sae_university"``).

        Returns:
            TenantConfig with ``.config`` and ``.secrets`` dicts.

        Raises:
            VaultNotFoundError: Tenant/service pair does not exist (404).
            VaultAuthError: Invalid or missing internal key (401/403).
            VaultConnectionError: Sentinel is unreachable or timed out.
        """
        cached = self._config_cache.get(tenant_id)
        if cached is not None:
            return cached

        data = self._request(
            "GET", f"/api/v1/vault/configs/{tenant_id}/{self._service}"
        )
        config = TenantConfig(
            tenant_id=data["tenant_id"],
            service=data["service"],
            enabled=data["enabled"],
            config=data.get("config", {}),
            secrets=data.get("secrets", {}),
        )
        self._config_cache.set(tenant_id, config)
        return config

    def get_secret(self, tenant_id: str, key: str) -> str:
        """Extract a single secret value from the tenant's cached config.

        Calls ``get_config`` internally (cache hit on subsequent calls) and
        returns ``secrets[key]``. No extra HTTP request is made.

        Args:
            tenant_id: Tenant identifier (e.g. ``"sae_university"``).
            key: Secret key to extract (e.g. ``"twilio_account_sid"``).

        Returns:
            The secret value as a string.

        Raises:
            VaultNotFoundError: The secret key does not exist in the tenant's secrets.
        """
        config = self.get_config(tenant_id)
        if key not in config.secrets:
            raise VaultNotFoundError(f"Secret key '{key}' not found")
        return str(config.secrets[key])

    def get_prompt(self, tenant_id: str, prompt_key: str) -> ActivePrompt:
        """Fetch the active prompt version for a tenant and prompt key.

        Returns a cached result if available and not expired, otherwise
        calls ``GET /api/v1/prompts/{tenant_id}/{service}/{prompt_key}/active``.
        Sentinel tries tenant-specific first, then falls back to the default prompt.

        Args:
            tenant_id: Tenant identifier (e.g. ``"sae_university"``).
            prompt_key: Prompt key (e.g. ``"system_prompt"``, ``"call_summary_prompt"``).

        Returns:
            ActivePrompt with ``.sections`` dict containing prompt content.

        Raises:
            VaultNotFoundError: No active prompt found for this tenant/key (404).
            VaultAuthError: Invalid or missing internal key (401/403).
            VaultConnectionError: Sentinel is unreachable or timed out.
        """
        cache_key = f"{tenant_id}:{prompt_key}"
        cached = self._prompt_cache.get(cache_key)
        if cached is not None:
            return cached

        data = self._request(
            "GET",
            f"/api/v1/prompts/{tenant_id}/{self._service}/{prompt_key}/active",
        )
        prompt = ActivePrompt(
            prompt_id=str(data["prompt_id"]),
            tenant_id=data.get("tenant_id"),
            service=data["service"],
            prompt_key=data["prompt_key"],
            version=data["version"],
            version_name=data["version_name"],
            sections=data.get("sections", {}),
        )
        self._prompt_cache.set(cache_key, prompt)
        return prompt

    def _invalidate_prompts(self) -> None:
        """Invalidate prompt cache entries for the operating tenant.

        Uses targeted ``delete_prefix`` when ``operating_tenant_id`` is set,
        otherwise falls back to clearing the entire prompt cache.
        """
        if self._operating_tenant_id:
            self._prompt_cache.delete_prefix(self._operating_tenant_id)
        else:
            self._prompt_cache.clear()

    def invalidate(
        self, tenant_id: str, resource: str | None = None
    ) -> None:
        """Clear cached entries for a tenant.

        When ``resource`` is provided, only the matching cache is cleared.
        When omitted, both config and prompt caches are cleared.

        Args:
            tenant_id: Tenant identifier to invalidate.
            resource: ``"config"`` or ``"prompt"`` to target a single cache,
                or ``None`` to clear both (default).
        """
        if resource is None or resource == "config":
            self._config_cache.delete(tenant_id)
        if resource is None or resource == "prompt":
            self._prompt_cache.delete_prefix(tenant_id)

    # ------------------------------------------------------------------
    # Write operations (JWT auth only)
    # ------------------------------------------------------------------

    def update_config(
        self,
        tenant_id: str,
        config: dict[str, Any] | None = None,
        secrets: dict[str, str] | None = None,
    ) -> TenantConfig:
        """Update config and/or secrets for a tenant/service pair.

        Sends a ``PATCH`` to Sentinel. Secrets are encrypted server-side
        before storage. Invalidates the config cache for this tenant.
        Sentinel enforces that ``tenant_id`` matches the operating tenant
        resolved from the JWT / ``X-Operating-Tenant-Id`` header.

        Args:
            tenant_id: Tenant identifier (e.g. ``"sae_university"``).
            config: Non-sensitive operational config to merge (or ``None`` to skip).
            secrets: Plaintext secrets to merge (or ``None`` to skip). Encrypted by Sentinel.

        Returns:
            Updated TenantConfig with merged values.

        Raises:
            VaultAuthError: JWT is missing or invalid (401/403).
            VaultNotFoundError: Tenant/service pair does not exist (404).
            VaultHTTPError: Validation error, tenant mismatch (403), or server error.
        """
        body: dict[str, Any] = {}
        if config is not None:
            body["config"] = config
        if secrets is not None:
            body["secrets"] = secrets

        data = self._request(
            "PATCH",
            f"/api/v1/vault/configs/{tenant_id}/{self._service}",
            json=body,
        )
        self._config_cache.delete(tenant_id)

        return TenantConfig(
            tenant_id=data["tenant_id"],
            service=data["service"],
            enabled=data["enabled"],
            config=data.get("config", {}),
            secrets=data.get("secrets", {}),
        )

    def get_prompt_versions(
        self, tenant_id: str, prompt_key: str
    ) -> list[PromptVersion]:
        """Get full version history for a prompt.

        Uses exact ``tenant_id`` match (no fallback). Pass ``"_default"``
        to query default/fallback prompts.

        Args:
            tenant_id: Tenant identifier, or ``"_default"`` for default prompts.
            prompt_key: Prompt key (e.g. ``"system_prompt"``).

        Returns:
            List of PromptVersion entries, most recent first.

        Raises:
            VaultAuthError: JWT is missing or invalid (401/403).
        """
        data = self._request(
            "GET",
            f"/api/v1/prompts/{tenant_id}/{self._service}/{prompt_key}/versions",
        )
        return [
            PromptVersion(
                id=str(v["id"]),
                version=v["version"],
                version_name=v["version_name"],
                version_note=v.get("version_note"),
                is_active=v["is_active"],
                created_by=v.get("created_by"),
                created_at=str(v["created_at"]),
            )
            for v in data
        ]

    def create_prompt_version(
        self,
        prompt_id: str,
        sections: dict[str, Any],
        version_name: str,
        version_note: str | None = None,
        created_by: int | None = None,
        activate: bool = True,
    ) -> CreatedPromptVersion:
        """Create a new prompt version.

        By default (``activate=True``), the new version is set as active and
        the previous active version is deactivated. Pass ``activate=False``
        to create the version as a draft without changing the currently active
        version. The first version of a prompt is always activated regardless
        of this flag.

        Invalidates the prompt cache for the operating tenant. Sentinel
        enforces that the prompt belongs to the operating tenant resolved
        from the JWT / ``X-Operating-Tenant-Id`` header.

        Args:
            prompt_id: UUID of the parent prompt.
            sections: Complete snapshot of all prompt sections.
            version_name: Human-readable version label (1-100 chars).
            version_note: Optional longer description of changes.
            created_by: User ID of the creator (defaults to JWT user if ``None``).
            activate: Set the new version as active immediately. Default ``True``.
                Ignored for the first version of a prompt (always activated).

        Returns:
            CreatedPromptVersion with the new version details.

        Raises:
            VaultAuthError: JWT is missing or invalid (401/403).
            VaultNotFoundError: Prompt ID does not exist (404).
            VaultHTTPError: Validation error, tenant mismatch (403), or server error.
        """
        body: dict[str, Any] = {
            "sections": sections,
            "version_name": version_name,
            "activate": activate,
        }
        if version_note is not None:
            body["version_note"] = version_note
        if created_by is not None:
            body["created_by"] = created_by

        data = self._request(
            "POST",
            f"/api/v1/prompts/{prompt_id}/versions",
            json=body,
        )
        self._invalidate_prompts()

        return CreatedPromptVersion(
            id=str(data["id"]),
            prompt_id=str(data["prompt_id"]),
            version=data["version"],
            version_name=data["version_name"],
            is_active=data["is_active"],
        )

    def ensure_prompt(
        self,
        prompt_key: str,
        tenant_id: str | None = None,
    ) -> EnsuredPrompt:
        """Idempotently find or create a prompt slot.

        If a prompt with the given ``tenant_id``/``service``/``prompt_key``
        already exists, returns it. Otherwise creates a new empty prompt slot.
        Sentinel enforces that ``tenant_id`` matches the operating tenant
        resolved from the JWT / ``X-Operating-Tenant-Id`` header.

        Args:
            prompt_key: Prompt key (e.g. ``"system_prompt"``).
            tenant_id: Tenant identifier, or ``None`` for a default/fallback prompt.

        Returns:
            EnsuredPrompt with ``.created`` indicating if it was newly created.

        Raises:
            VaultAuthError: JWT is missing or invalid (401/403).
            VaultHTTPError: Validation error, tenant mismatch (403), or server error.
        """
        body: dict[str, Any] = {
            "service": self._service,
            "prompt_key": prompt_key,
        }
        if tenant_id is not None:
            body["tenant_id"] = tenant_id

        data = self._request(
            "POST",
            "/api/v1/prompts/ensure",
            json=body,
        )
        return EnsuredPrompt(
            id=str(data["id"]),
            tenant_id=data.get("tenant_id"),
            service=data["service"],
            prompt_key=data["prompt_key"],
            created=data["created"],
        )

    def list_prompts(
        self, service: str | None = None
    ) -> list[PromptListItem]:
        """List all prompt slots for the authenticated user's tenant.

        Requires JWT auth. The tenant is resolved from the JWT token.
        Optionally filter by service name.

        Args:
            service: Filter results to this service name, or ``None`` for all services.

        Returns:
            List of PromptListItem entries.

        Raises:
            VaultAuthError: JWT is missing or invalid (401/403).
        """
        path = "/api/v1/prompts"
        if service is not None:
            path += f"?service={service}"

        data = self._request("GET", path)
        return [
            PromptListItem(
                id=str(item["id"]),
                tenant_id=item.get("tenant_id"),
                service=item["service"],
                prompt_key=item["prompt_key"],
                active_version=item.get("active_version"),
                active_version_name=item.get("active_version_name"),
                version_count=item.get("version_count", 0),
                updated_at=str(item["updated_at"]),
            )
            for item in data
        ]

    def get_version_detail(self, version_id: str) -> PromptVersionDetail:
        """Get full detail (including sections) for a single prompt version.

        Requires JWT auth.

        Args:
            version_id: UUID of the prompt version.

        Returns:
            PromptVersionDetail with ``.sections`` content.

        Raises:
            VaultAuthError: JWT is missing or invalid (401/403).
            VaultNotFoundError: Version does not exist (404).
        """
        data = self._request("GET", f"/api/v1/prompts/versions/{version_id}")
        return PromptVersionDetail(
            id=str(data["id"]),
            prompt_id=str(data["prompt_id"]),
            version=data["version"],
            version_name=data["version_name"],
            version_note=data.get("version_note"),
            sections=data.get("sections", {}),
            is_active=data["is_active"],
            created_by=data.get("created_by"),
            created_at=str(data["created_at"]),
        )

    def activate_version(self, version_id: str) -> PromptVersionDetail:
        """Set a specific version as the active version (rollback/promote).

        Deactivates the current active version and activates the specified
        one. Invalidates the prompt cache for the operating tenant.
        Requires JWT auth.

        Args:
            version_id: UUID of the version to activate.

        Returns:
            PromptVersionDetail of the newly activated version.

        Raises:
            VaultAuthError: JWT is missing or invalid (401/403).
            VaultNotFoundError: Version does not exist (404).
            VaultHTTPError: Validation error or server error.
        """
        data = self._request(
            "PATCH", f"/api/v1/prompts/versions/{version_id}/activate"
        )
        self._invalidate_prompts()

        return PromptVersionDetail(
            id=str(data["id"]),
            prompt_id=str(data["prompt_id"]),
            version=data["version"],
            version_name=data["version_name"],
            version_note=data.get("version_note"),
            sections=data.get("sections", {}),
            is_active=data["is_active"],
            created_by=data.get("created_by"),
            created_at=str(data["created_at"]),
        )

    def update_version_metadata(
        self,
        version_id: str,
        version_name: str | None = None,
        version_note: str | None = None,
    ) -> PromptVersionDetail:
        """Update version_name and/or version_note for a prompt version.

        Does not modify the sections content — content changes require
        creating a new version. Invalidates prompt cache for the operating
        tenant. Requires JWT auth.

        Args:
            version_id: UUID of the version to update.
            version_name: New version label (1-100 chars), or ``None`` to leave unchanged.
            version_note: New description, or ``None`` to leave unchanged.

        Returns:
            PromptVersionDetail with updated metadata.

        Raises:
            VaultAuthError: JWT is missing or invalid (401/403).
            VaultNotFoundError: Version does not exist (404).
            VaultHTTPError: Validation error or server error.
        """
        body: dict[str, Any] = {}
        if version_name is not None:
            body["version_name"] = version_name
        if version_note is not None:
            body["version_note"] = version_note

        data = self._request(
            "PATCH",
            f"/api/v1/prompts/versions/{version_id}",
            json=body,
        )
        self._invalidate_prompts()

        return PromptVersionDetail(
            id=str(data["id"]),
            prompt_id=str(data["prompt_id"]),
            version=data["version"],
            version_name=data["version_name"],
            version_note=data.get("version_note"),
            sections=data.get("sections", {}),
            is_active=data["is_active"],
            created_by=data.get("created_by"),
            created_at=str(data["created_at"]),
        )

    def delete_version(self, version_id: str) -> None:
        """Delete a prompt version.

        Cannot delete the last remaining version — delete the prompt instead.
        If the active version is deleted, the latest remaining version is
        auto-activated. Invalidates the prompt cache for the operating tenant.
        Requires JWT auth.

        Args:
            version_id: UUID of the version to delete.

        Raises:
            VaultAuthError: JWT is missing or invalid (401/403).
            VaultNotFoundError: Version does not exist (404).
            VaultHTTPError: Cannot delete last version, or server error.
        """
        self._request("DELETE", f"/api/v1/prompts/versions/{version_id}")
        self._invalidate_prompts()

    def delete_prompt(self, prompt_id: str) -> None:
        """Delete a prompt slot and all its versions.

        Invalidates the prompt cache for the operating tenant.
        Requires JWT auth.

        Args:
            prompt_id: UUID of the prompt to delete.

        Raises:
            VaultAuthError: JWT is missing or invalid (401/403).
            VaultNotFoundError: Prompt does not exist (404).
            VaultHTTPError: Server error.
        """
        self._request("DELETE", f"/api/v1/prompts/{prompt_id}")
        self._invalidate_prompts()

    # ------------------------------------------------------------------
    # Bulk load (Internal-Key auth, service startup)
    # ------------------------------------------------------------------

    def get_bulk_config(self) -> BulkServiceData:
        """Bulk-load all configs, secrets, and active prompts for this service.

        Returns everything the service needs to operate across all tenants
        in a single HTTP call. Designed for service startup to avoid
        per-tenant round-trips.

        The result is **not cached** — call this once at startup and store
        the result yourself.

        Returns:
            BulkServiceData with per-tenant configs, secrets, and active prompts.

        Raises:
            VaultAuthError: Internal key is missing or invalid (401/403).
            VaultConnectionError: Sentinel is unreachable or timed out.
        """
        data = self._request(
            "GET", f"/api/v1/vault/configs/bulk/{self._service}"
        )
        tenants: dict[str, BulkTenantEntry] = {}
        for tid, tdata in data.get("tenants", {}).items():
            prompts: dict[str, BulkPromptEntry] = {}
            for pkey, pdata in tdata.get("prompts", {}).items():
                prompts[pkey] = BulkPromptEntry(
                    version=pdata["version"],
                    version_name=pdata["version_name"],
                    sections=pdata.get("sections", {}),
                )
            tenants[tid] = BulkTenantEntry(
                enabled=tdata["enabled"],
                config=tdata.get("config", {}),
                secrets=tdata.get("secrets", {}),
                prompts=prompts,
            )
        return BulkServiceData(service=data["service"], tenants=tenants)