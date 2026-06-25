interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class TenantCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number | null;
  private readonly maxSize: number;

  constructor(ttlSeconds: number | null, maxSize: number) {
    this.ttlMs = ttlSeconds !== null ? ttlSeconds * 1000 : null;
    this.maxSize = maxSize;
  }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    // Move to end for LRU ordering
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.data;
  }

  set(key: string, value: T): void {
    this.store.delete(key);
    this.store.set(key, {
      data: value,
      expiresAt: this.ttlMs !== null ? Date.now() + this.ttlMs : Infinity,
    });

    // Evict oldest if over capacity
    while (this.store.size > this.maxSize) {
      const oldest = this.store.keys().next().value!;
      this.store.delete(oldest);
    }
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  deletePrefix(prefix: string): void {
    for (const key of [...this.store.keys()]) {
      if (key === prefix || key.startsWith(prefix + ":")) {
        this.store.delete(key);
      }
    }
  }

  clear(): void {
    this.store.clear();
  }
}