from __future__ import annotations

import httpx

from hermes_vault.cache import TenantCache
from hermes_vault.exceptions import (
    VaultAuthError,
    VaultConnectionError,
    VaultHTTPError,
    VaultNotFoundError,
)
from hermes_vault.models import ActivePrompt, TenantConfig


class HermesVault:
    """Read-only client for fetching tenant-scoped config, secrets, and prompts from Sentinel.

    All responses are cached in-memory with TTL + LRU eviction. The ``service``
    parameter is set once at construction and used implicitly in every call.

    Example::

        vault = HermesVault(
            sentinel_url="http://localhost:8001",
            internal_key="dev-internal-key-change-in-production",
            service="phoenix",
        )
        config = vault.get_config("sae_university")
        secret = vault.get_secret("sae_university", "twilio_account_sid")
        prompt = vault.get_prompt("sae_university", "system_prompt")
    """

    def __init__(
        self,
        sentinel_url: str,
        internal_key: str,
        service: str,
        config_ttl_seconds: int = 600,
        prompt_ttl_seconds: int = 300,
        max_cache_size: int = 100,
    ) -> None:
        """Initialise the Vault client.

        Args:
            sentinel_url: Base URL of the Sentinel server (e.g. ``"http://localhost:8001"``).
            internal_key: Value sent as the ``X-Internal-Key`` header for service auth.
            service: Service name used in all endpoint paths (e.g. ``"phoenix"``).
            config_ttl_seconds: Cache TTL for config entries. Default ``600`` (10 min).
            prompt_ttl_seconds: Cache TTL for prompt entries. Default ``300`` (5 min).
            max_cache_size: Max tenants kept in each LRU cache. Default ``100``.
        """
        self._service = service
        self._http = httpx.Client(
            base_url=sentinel_url.rstrip("/"),
            headers={"X-Internal-Key": internal_key},
            timeout=30.0,
        )
        self._config_cache: TenantCache[TenantConfig] = TenantCache(
            config_ttl_seconds, max_cache_size
        )
        self._prompt_cache: TenantCache[ActivePrompt] = TenantCache(
            prompt_ttl_seconds, max_cache_size
        )

    def _request(self, method: str, path: str) -> dict:
        try:
            response = self._http.request(method, path)
        except httpx.TimeoutException as exc:
            raise VaultConnectionError(f"Request timed out: {exc}") from exc
        except httpx.ConnectError as exc:
            raise VaultConnectionError(f"Connection failed: {exc}") from exc
        except httpx.HTTPError as exc:
            raise VaultConnectionError(str(exc)) from exc

        if response.status_code == 200:
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

    def invalidate(self, tenant_id: str) -> None:
        """Clear all cached config and prompt entries for a tenant.

        Call this when the dashboard updates a tenant's config or prompts.
        The next ``get_config`` / ``get_prompt`` call will re-fetch from Sentinel.

        Args:
            tenant_id: Tenant identifier to invalidate.
        """
        self._config_cache.delete(tenant_id)
        self._prompt_cache.delete_prefix(tenant_id)