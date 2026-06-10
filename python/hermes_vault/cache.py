from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Generic, TypeVar

T = TypeVar("T")


@dataclass
class CacheEntry(Generic[T]):
    data: T
    expires_at: float


class TenantCache(Generic[T]):
    """Per-tenant TTL cache with LRU eviction."""

    def __init__(self, ttl_seconds: int, max_size: int) -> None:
        self._store: OrderedDict[str, CacheEntry[T]] = OrderedDict()
        self._ttl_seconds = ttl_seconds
        self._max_size = max_size

    def get(self, key: str) -> T | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        if time.monotonic() >= entry.expires_at:
            del self._store[key]
            return None
        self._store.move_to_end(key)
        return entry.data

    def set(self, key: str, value: T) -> None:
        if key in self._store:
            del self._store[key]
        self._store[key] = CacheEntry(
            data=value,
            expires_at=time.monotonic() + self._ttl_seconds,
        )
        while len(self._store) > self._max_size:
            self._store.popitem(last=False)

    def delete(self, key: str) -> None:
        self._store.pop(key, None)

    def delete_prefix(self, prefix: str) -> None:
        keys = [k for k in self._store if k == prefix or k.startswith(prefix + ":")]
        for k in keys:
            del self._store[k]

    def clear(self) -> None:
        self._store.clear()