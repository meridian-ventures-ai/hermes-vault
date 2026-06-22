/** Base exception for all Vault SDK errors. */
export declare class VaultError extends Error {
    constructor(message: string);
}
/** Sentinel is unreachable or the request timed out. */
export declare class VaultConnectionError extends VaultError {
    constructor(message: string);
}
/** Sentinel returned a non-2xx response. */
export declare class VaultHttpError extends VaultError {
    /** HTTP status code from Sentinel. */
    readonly statusCode: number;
    /** Error detail message from Sentinel's response body. */
    readonly detail: string;
    constructor(statusCode: number, detail: string);
}
/** 404 — requested resource does not exist. */
export declare class VaultNotFoundError extends VaultHttpError {
    constructor(detail?: string);
}
/** 401/403 — invalid or missing internal key. */
export declare class VaultAuthError extends VaultHttpError {
    constructor(statusCode: number, detail?: string);
}
