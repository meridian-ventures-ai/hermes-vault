"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VaultAuthError = exports.VaultNotFoundError = exports.VaultHttpError = exports.VaultConnectionError = exports.VaultError = void 0;
/** Base exception for all Vault SDK errors. */
class VaultError extends Error {
    constructor(message) {
        super(message);
        this.name = "VaultError";
    }
}
exports.VaultError = VaultError;
/** Sentinel is unreachable or the request timed out. */
class VaultConnectionError extends VaultError {
    constructor(message) {
        super(message);
        this.name = "VaultConnectionError";
    }
}
exports.VaultConnectionError = VaultConnectionError;
/** Sentinel returned a non-2xx response. */
class VaultHttpError extends VaultError {
    /** HTTP status code from Sentinel. */
    statusCode;
    /** Error detail message from Sentinel's response body. */
    detail;
    constructor(statusCode, detail) {
        super(`HTTP ${statusCode}: ${detail}`);
        this.name = "VaultHttpError";
        this.statusCode = statusCode;
        this.detail = detail;
    }
}
exports.VaultHttpError = VaultHttpError;
/** 404 — requested resource does not exist. */
class VaultNotFoundError extends VaultHttpError {
    constructor(detail = "Not found") {
        super(404, detail);
        this.name = "VaultNotFoundError";
    }
}
exports.VaultNotFoundError = VaultNotFoundError;
/** 401/403 — invalid or missing internal key. */
class VaultAuthError extends VaultHttpError {
    constructor(statusCode, detail = "Unauthorized") {
        super(statusCode, detail);
        this.name = "VaultAuthError";
    }
}
exports.VaultAuthError = VaultAuthError;
