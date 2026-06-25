export declare class TenantCache<T> {
    private readonly store;
    private readonly ttlMs;
    private readonly maxSize;
    constructor(ttlSeconds: number | null, maxSize: number);
    get(key: string): T | null;
    set(key: string, value: T): void;
    delete(key: string): void;
    deletePrefix(prefix: string): void;
    clear(): void;
}
