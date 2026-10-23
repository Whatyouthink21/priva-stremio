import fs from "node:fs";
import path from "node:path";

/**
 * Per-provider health ledger with rolling latency, score, and automatic
 * 2-minute cooldown after five straight failures.
 */
const FILE = path.join(process.cwd(), "data", "health.json");
const WINDOW = 40;
const SLOW_THRESHOLD_MS = 5_000;

class HealthLedger {
  constructor() {
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    } catch {
      this.data = {};
    }
    this.dirty = false;
    this.timer = setInterval(() => this.flush(), 15_000).unref?.();
  }

  entry(id) {
    if (!this.data[id]) {
      this.data[id] = {
        attempts: [],
        ok: 0,
        fail: 0,
        lastMs: null,
        lastSuccess: 0,
        lastError: null,
        cooldownUntil: 0,
      };
    }
    return this.data[id];
  }

  recordSuccess(id, latencyMs, streams = 0) {
    const e = this.entry(id);
    e.attempts.push({ ok: true, ms: latencyMs, n: streams, t: Date.now() });
    if (e.attempts.length > WINDOW) e.attempts.shift();
    e.ok += 1;
    e.lastMs = Math.round(latencyMs);
    e.lastSuccess = Date.now();
    e.lastError = null;
    e.cooldownUntil = 0;
    this.dirty = true;
  }

  recordFailure(id, error, latencyMs = null) {
    const e = this.entry(id);
    e.attempts.push({ ok: false, ms: latencyMs, t: Date.now() });
    if (e.attempts.length > WINDOW) e.attempts.shift();
    e.fail += 1;
    if (typeof latencyMs === "number") e.lastMs = Math.round(latencyMs);
    e.lastError = String(error?.message || error).slice(0, 300);
    const recent = e.attempts.slice(-5);
    if (recent.length === 5 && recent.every((a) => a.ok === false)) {
      e.cooldownUntil = Date.now() + 120_000;
    }
    this.dirty = true;
  }

  recordNeutral(id, latencyMs = null) {
    const e = this.entry(id);
    e.attempts.push({ ok: null, ms: latencyMs, t: Date.now() });
    if (e.attempts.length > WINDOW) e.attempts.shift();
    if (typeof latencyMs === "number") e.lastMs = Math.round(latencyMs);
    this.dirty = true;
  }

  score(id) {
    const e = this.data[id];
    if (!e || !e.attempts.length) return 0.55;
    const recent = e.attempts.slice(-20);
    const scored = recent.filter((a) => a.ok !== null);
    if (!scored.length) return 0.55;
    const ok = scored.filter((a) => a.ok);
    const rate = ok.length / scored.length;
    const avgMs = ok.length ? ok.reduce((s, a) => s + (a.ms || 0), 0) / ok.length : 20_000;
    const speed = 1 - Math.min(avgMs / 15_000, 1);
    return Math.round((rate * 0.8 + speed * 0.2) * 1000) / 1000;
  }

  cooling(id) {
    const e = this.data[id];
    return Boolean(e && e.cooldownUntil > Date.now());
  }

  status(id) {
    if (this.cooling(id)) return "cooling";
    const e = this.data[id];
    if (!e) return "ok";
    const okAttempts = e.attempts.filter((a) => a.ok);
    const avgMs = okAttempts.length
      ? okAttempts.reduce((s, a) => s + (a.ms || 0), 0) / okAttempts.length
      : null;
    const probeMs = e.lastMs ?? avgMs;
    if (typeof probeMs === "number" && probeMs >= SLOW_THRESHOLD_MS) return "slow";
    return "ok";
  }

  snapshot() {
    return Object.entries(this.data).map(([id, e]) => {
      const okAttempts = e.attempts.filter((a) => a.ok);
      const avgMs = okAttempts.length
        ? Math.round(okAttempts.reduce((s, a) => s + (a.ms || 0), 0) / okAttempts.length)
        : null;
      return {
        id,
        status: this.status(id),
        score: this.score(id),
        ok: e.ok,
        fail: e.fail,
        lastMs: e.lastMs ?? avgMs,
        avgMs,
        lastSuccess: e.lastSuccess,
        lastError: e.lastError,
        cooling: this.cooling(id),
      };
    });
  }

  flush() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(this.data, null, 2));
      this.dirty = false;
    } catch {
      /* ignore */
    }
  }
}

export const health = new HealthLedger();
