class VaultError(Exception):
    """Base exception for all Vault SDK errors."""


class VaultConnectionError(VaultError):
    """Sentinel is unreachable or request timed out."""


class VaultHTTPError(VaultError):
    """Sentinel returned a non-2xx response."""

    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"HTTP {status_code}: {detail}")


class VaultNotFoundError(VaultHTTPError):
    """404 — requested resource does not exist."""

    def __init__(self, detail: str = "Not found"):
        super().__init__(404, detail)


class VaultAuthError(VaultHTTPError):
    """401/403 — invalid or missing internal key."""

    def __init__(self, status_code: int, detail: str = "Unauthorized"):
        super().__init__(status_code, detail)