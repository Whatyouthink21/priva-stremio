/**
 * Zero-dependency in-memory token bucket rate limiter (per IP).
 */
export function createTokenBucket({
  capacity = Number(process.env.STREAM_RATE_BURST || 60),
  refillPerSec = Number(process.env.STREAM_RATE_PER_SEC || 2),
} = {}) {
  const buckets = new Map();

  const timer = setInterval(() => {
    const staleBefore = Date.now() - 10 * 60_000;
    for (const [ip, b] of buckets) {
      if (b.updatedAt < staleBefore) buckets.delete(ip);
    }
  }, 60_000);
  timer.unref?.();

  return function allow(ip) {
    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket) {
      bucket = { tokens: capacity, updatedAt: now };
      buckets.set(ip, bucket);
    } else {
      const elapsedSec = Math.max(0, (now - bucket.updatedAt) / 1000);
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
      bucket.updatedAt = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true, remaining: Math.floor(bucket.tokens), retryAfterSec: 0 };
    }

    const retryAfterSec = Math.max(1, Math.ceil((1 - bucket.tokens) / Math.max(refillPerSec, 0.01)));
    return { ok: false, remaining: 0, retryAfterSec };
  };
}
