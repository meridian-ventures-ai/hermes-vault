"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantCache = void 0;
class TenantCache {
    store = new Map();
    ttlMs;
    maxSize;
    constructor(ttlSeconds, maxSize) {
        this.ttlMs = ttlSeconds !== null ? ttlSeconds * 1000 : null;
        this.maxSize = maxSize;
    }
    get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return null;
        if (Date.now() >= entry.expiresAt) {
            this.store.delete(key);
            return null;
        }
        // Move to end for LRU ordering
        this.store.delete(key);
        this.store.set(key, entry);
        return entry.data;
    }
    set(key, value) {
        this.store.delete(key);
        this.store.set(key, {
            data: value,
            expiresAt: this.ttlMs !== null ? Date.now() + this.ttlMs : Infinity,
        });
        // Evict oldest if over capacity
        while (this.store.size > this.maxSize) {
            const oldest = this.store.keys().next().value;
            this.store.delete(oldest);
        }
    }
    delete(key) {
        this.store.delete(key);
    }
    deletePrefix(prefix) {
        for (const key of [...this.store.keys()]) {
            if (key === prefix || key.startsWith(prefix + ":")) {
                this.store.delete(key);
            }
        }
    }
    clear() {
        this.store.clear();
    }
}
exports.TenantCache = TenantCache;
