/** Base exception for all Vault SDK errors. */
export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

/** Sentinel is unreachable or the request timed out. */
export class VaultConnectionError extends VaultError {
  constructor(message: string) {
    super(message);
    this.name = "VaultConnectionError";
  }
}

/** Sentinel returned a non-2xx response. */
export class VaultHttpError extends VaultError {
  /** HTTP status code from Sentinel. */
  public readonly statusCode: number;
  /** Error detail message from Sentinel's response body. */
  public readonly detail: string;

  constructor(statusCode: number, detail: string) {
    super(`HTTP ${statusCode}: ${detail}`);
    this.name = "VaultHttpError";
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

/** 404 — requested resource does not exist. */
export class VaultNotFoundError extends VaultHttpError {
  constructor(detail: string = "Not found") {
    super(404, detail);
    this.name = "VaultNotFoundError";
  }
}

/** 401/403 — invalid or missing internal key. */
export class VaultAuthError extends VaultHttpError {
  constructor(statusCode: number, detail: string = "Unauthorized") {
    super(statusCode, detail);
    this.name = "VaultAuthError";
  }
}