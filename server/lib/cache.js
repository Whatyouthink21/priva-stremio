/**
 * Small TTL cache with single-flight so concurrent requests for the same title
 * share one upstream fan-out instead of stampeding providers.
 */
export class TtlCache {
  constructor({ max = 500, defaultTtlMs = 60_000 } = {}) {
    this.max = max;
    this.defaultTtlMs = defaultTtlMs;
    this.map = new Map();
    this.inflight = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    if (this.map.size >= this.max && !this.map.has(key)) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }

  clear() {
    this.map.clear();
  }

  /** @param {() => Promise<any>} fn */
  async wrap(key, fn, ttlMs = this.defaultTtlMs) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    if (this.inflight.has(key)) return this.inflight.get(key);

    const p = (async () => {
      try {
        const value = await fn();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  stats() {
    return { size: this.map.size, inflight: this.inflight.size };
  }
}
