/**
 * Provider registry + multi-provider resolver with health ordering, per-provider
 * budgets, partial responses, and background cache upgrades.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../lib/log.js";
import { health } from "../lib/health.js";
import { TtlCache } from "../lib/cache.js";
import { describeError } from "../lib/errors.js";
import { createProviderContext } from "./context.js";
import { normalizeStream } from "./types.js";
import { resolveViaVega, loadVegaProvider } from "./vega.js";
import { BLOCKED_PROVIDERS } from "../../scripts/vendor.mjs";

const log = logger("registry");
const cache = new TtlCache({ max: 800, defaultTtlMs: config.resolveTtlSec * 1000 });

const PROVIDER_META = {
  castle: {
    displayName: "Castle TV",
    description: "Fast MP4/HLS streams across a broad movie & TV catalog.",
  },
  "4khdhub": {
    displayName: "4KHDHub",
    description: "High-bitrate multi-quality MKV releases up to 2160p via HubCloud.",
  },
  autoEmbed: {
    displayName: "MultiStream (autoEmbed)",
    description: "Aggregator reaching Cinejoy, Movy and Vidstuck in parallel.",
  },
  movieBoxWeb: {
    displayName: "MovieBox Web",
    description: "HLS/MP4 streams with multi-language captions.",
  },
  kissKh: {
    displayName: "KissKH",
    description: "Anime and Asian drama streams in HLS with real subtitles.",
  },
};

/** @type {Map<string, object>} */
const registry = new Map();

function canonicalId(id) {
  const raw = String(id || "").trim();
  if (registry.has(raw)) return raw;
  const bare = raw.replace(/^vega:/, "");
  if (registry.has(bare)) return bare;
  if (registry.has(`vega:${bare}`)) return `vega:${bare}`;
  return raw;
}

export function registerBuiltin(mod) {
  registry.set(mod.id, {
    id: mod.id,
    label: mod.label || mod.id,
    displayName: mod.displayName || mod.label || mod.id,
    description: mod.description || "",
    kind: "id",
    needsSeason: Boolean(mod.needsSeason),
    origin: "builtin",
    resolve: mod.resolve,
  });
}

export const registerProvider = registerBuiltin;

export function unregisterProvider(id) {
  registry.delete(id);
}

export function clearResolveCache() {
  cache.clear();
}

export async function syncVegaProviders() {
  if (!config.vega.enabled) return { enabled: false, loaded: [] };

  const vendorRoot = path.join(process.cwd(), "server", "providers", "vendor");
  const vendoredDirs = [];
  if (process.env.VEGA_STRICT_SOURCES !== "true") {
    try {
      for (const entry of fs.readdirSync(vendorRoot, { withFileTypes: true })) {
        if (
          entry.isDirectory() &&
          !BLOCKED_PROVIDERS.has(entry.name) &&
          fs.existsSync(path.join(vendorRoot, entry.name, "stream.js"))
        ) {
          vendoredDirs.push(entry.name);
        }
      }
    } catch {
      /* no vendor dir yet */
    }
  }

  const wanted = [];
  for (const name of [...config.vega.sources, ...vendoredDirs]) {
    const clean = String(name || "").trim().replace(/^vega:/, "");
    if (!clean || wanted.includes(clean)) continue;
    wanted.push(clean);
  }

  const loaded = [];
  for (const name of wanted) {
    try {
      const mod = await loadVegaProvider(name);
      const info = PROVIDER_META[name] || {};
      registry.set(name, {
        id: name,
        label: name,
        displayName: info.displayName || name,
        description: info.description || "Vega provider bundle.",
        kind: "vega",
        needsSeason: true,
        origin: "vega",
        mod,
      });
      loaded.push(name);
    } catch (err) {
      log.warn(`could not load vega provider "${name}": ${err.message}`);
    }
  }

  log.info(`vega bridge: ${loaded.length}/${wanted.length} providers ready (${loaded.join(", ")})`);
  return { enabled: true, loaded };
}

export function listProviders() {
  const healthMap = new Map(health.snapshot().map((h) => [h.id, h]));
  return [...registry.values()].map((p) => {
    const h = healthMap.get(p.id) || null;
    const defaultMs =
      config.vega.timeouts?.[p.id] || config.providerTimeoutMs || 8_000;
    return {
      id: p.id,
      label: p.label,
      displayName: p.displayName || p.label,
      description: p.description,
      kind: p.kind,
      origin: p.origin,
      enabledByDefault: config.vega.sources.includes(p.id),
      defaultBudgetSec: Math.round(defaultMs / 1000),
      status: health.status(p.id),
      score: health.score(p.id),
      cooling: health.cooling(p.id),
      latencyMs: h?.lastMs ?? null,
      avgMs: h?.avgMs ?? null,
      health: h,
    };
  });
}

export function getProvider(id) {
  return registry.get(canonicalId(id)) || null;
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

function withTimeout(promise, ms, label, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(
        Object.assign(new Error(`${label} timed out after ${ms}ms`), {
          code: "TIMEOUT",
        }),
      );
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isNoMatch(reason) {
  return /no confident match|no search match|search returned nothing|title required/i.test(
    String(reason || ""),
  );
}

/**
 * Resolve one provider. Never throws — errors and timeouts become structured
 * diagnostics so one dead or slow source never breaks the response.
 */
export async function resolveOne(rawProviderId, params = {}) {
  const providerId = canonicalId(rawProviderId);
  const provider = registry.get(providerId);
  if (!provider) {
    return {
      provider: rawProviderId,
      label: rawProviderId,
      ok: false,
      timedOut: false,
      streams: [],
      meta: null,
      error: "unknown provider",
      ms: 0,
    };
  }

  const started = Date.now();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  params.signal?.addEventListener?.("abort", onAbort, { once: true });

  const bareId = providerId.replace(/^vega:/, "");
  const explicitTimeout =
    params.timeouts?.[providerId] ?? params.timeouts?.[bareId];
  const defaultTimeout =
    config.vega.timeouts?.[providerId] ??
    config.vega.timeouts?.[bareId] ??
    config.providerTimeoutMs;
  const budgetMs =
    explicitTimeout ??
    (params.budgetMs ? Math.min(params.budgetMs, defaultTimeout) : defaultTimeout);

  try {
    const ctx = createProviderContext(providerId);
    const task =
      provider.kind === "vega"
        ? resolveViaVega({
            providerId: provider.mod.id,
            tmdbId: params.tmdbId ?? params.id,
            type: params.type,
            season: params.season ?? 1,
            episode: params.episode ?? 1,
            title: params.title,
            year: params.year,
            imdbId: params.imdbId,
            providerContext: ctx,
            signal: controller.signal,
          })
        : provider.resolve({
            id: params.id,
            tmdbId: params.tmdbId ?? params.id,
            imdbId: params.imdbId ?? params.id,
            type: params.type,
            season: params.season ?? 1,
            episode: params.episode ?? 1,
            providerContext: ctx,
            signal: controller.signal,
            baseUrl: params.baseUrl,
            title: params.title,
            year: params.year,
          });

    const result = await withTimeout(task, budgetMs, providerId, () => controller.abort());
    const rawStreams = Array.isArray(result) ? result : result?.streams || [];
    const streams = rawStreams
      .map((s) => normalizeStream(s, providerId))
      .filter(Boolean)
      .map((s) => ({ ...s, provider: providerId, providerLabel: provider.label }));

    const ms = Date.now() - started;
    if (streams.length) {
      health.recordSuccess(providerId, ms, streams.length);
    } else if (isNoMatch(result?.reason)) {
      health.recordNeutral(providerId, ms);
    } else {
      health.recordFailure(providerId, new Error(result?.reason || "no streams returned"), ms);
    }

    return {
      provider: providerId,
      label: provider.label,
      ok: streams.length > 0,
      timedOut: false,
      streams,
      meta: Array.isArray(result) ? null : result?.meta || null,
      matched: Array.isArray(result) ? null : result?.matched || null,
      nearest: Array.isArray(result) ? null : result?.nearest || null,
      error: streams.length ? null : result?.reason || "no streams returned",
      ms,
    };
  } catch (err) {
    const ms = Date.now() - started;
    const timedOut = err?.code === "TIMEOUT" || /timed out/i.test(String(err?.message || ""));
    health.recordFailure(providerId, err, ms);
    log.warn(`${providerId} failed in ${ms}ms: ${err.message}`);
    return {
      provider: providerId,
      label: provider.label,
      ok: false,
      timedOut,
      streams: [],
      meta: null,
      matched: null,
      nearest: null,
      error: describeError(err),
      ms,
    };
  } finally {
    params.signal?.removeEventListener?.("abort", onAbort);
  }
}

/**
 * Fan out across providers in health order.
 * Fast sources trigger the grace timer so Stremio gets an answer quickly while
 * slower sources keep running in the background to upgrade the cache entry.
 */
export async function resolveAll(params = {}) {
  const all = [...registry.keys()];
  const hasExplicitProviders = Array.isArray(params.providers);
  const requested = hasExplicitProviders ? params.providers : config.vega.sources;
  const resolvedRequested = requested.map((id) => ({ raw: id, canon: canonicalId(id) }));

  if (hasExplicitProviders && requested.length === 0) {
    return buildResult([], Date.now(), 0, []);
  }

  const unknown = hasExplicitProviders
    ? resolvedRequested.filter((x) => !registry.has(x.canon)).map((x) => x.raw)
    : [];
  let targets = resolvedRequested
    .map((x) => x.canon)
    .filter((id, idx, arr) => registry.has(id) && arr.indexOf(id) === idx);

  if (!hasExplicitProviders && !targets.length) {
    targets = all;
  }

  targets = targets
    .map((id) => ({ id, score: health.score(id), cooling: health.cooling(id) }))
    .sort((a, b) => Number(a.cooling) - Number(b.cooling) || b.score - a.score)
    .map((x) => x.id);

  const started = Date.now();
  const GRACE_MS =
    params.graceMs !== undefined
      ? Number(params.graceMs)
      : process.env.RESOLVE_GRACE_MS !== undefined && process.env.RESOLVE_GRACE_MS !== ""
        ? Number(process.env.RESOLVE_GRACE_MS)
        : config.resolveGraceMs;

  const slowestProvider = Math.max(
    0,
    ...targets.map((id) => {
      const bare = id.replace(/^vega:/, "");
      const explicit = params.timeouts?.[id] ?? params.timeouts?.[bare];
      const fallback = config.vega.timeouts?.[id] ?? config.vega.timeouts?.[bare] ?? 0;
      if (explicit !== undefined) return explicit;
      if (params.budgetMs) return Math.min(params.budgetMs, fallback || params.budgetMs);
      return fallback;
    }),
  );

  const budget = params.budgetMs
    ? Math.max(
        params.budgetMs,
        params.timeouts ? slowestProvider + GRACE_MS + 250 : 0,
      )
    : Math.max(config.resolveBudgetMs, slowestProvider ? slowestProvider + GRACE_MS + 500 : 0);

  const unknownResults = unknown.map((id) => ({
    provider: id,
    label: id,
    ok: false,
    timedOut: false,
    streams: [],
    meta: null,
    error: "unknown provider — check /health for registered providers",
    ms: 0,
  }));

  if (!targets.length) {
    return buildResult(unknownResults, started, budget, []);
  }

  let resolveComplete;
  const complete = new Promise((r) => (resolveComplete = r));

  const settled = await new Promise((resolve) => {
    const out = [...unknownResults];
    let remaining = targets.length;
    let done = false;
    let grace = null;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(hardStop);
      clearTimeout(grace);
      resolve(out.slice());
    };

    const hardStop = setTimeout(finish, budget);
    hardStop.unref?.();

    const armGrace = () => {
      if (grace) return;
      grace = setTimeout(finish, GRACE_MS);
      grace.unref?.();
    };

    targets.forEach((id) => {
      resolveOne(id, params)
        .then((r) => {
          out.push(r);
          if (r.ok) armGrace();
        })
        .catch(() => {})
        .finally(() => {
          remaining -= 1;
          if (remaining === 0) {
            resolveComplete(out.slice());
            finish();
          }
        });
    });
  });

  const result = buildResult(settled, started, budget, targets);

  if (result.partial) {
    result.complete = complete.then((all) => buildResult(all, started, budget, targets));
  }

  return result;
}

function buildResult(settled, started, budget, targets) {
  const merged = [];
  const seen = new Set();
  for (const r of settled) {
    for (const s of r.streams) {
      const fingerprint = `${s.type}:${s.quality || ""}:${s.link}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      merged.push(s);
    }
  }

  const meta = settled.map((r) => r.meta).find((m) => m && m.title) || null;
  const answered = new Set(settled.map((r) => r.provider));
  const pending = targets.filter((id) => !answered.has(id));
  const partial = pending.length > 0;

  return {
    streams: merged,
    meta,
    partial,
    pending,
    diagnostics: [
      ...settled.map((r) => ({
        provider: r.provider,
        label: r.label,
        ok: r.ok,
        timedOut: Boolean(r.timedOut),
        ms: r.ms,
        streams: r.streams.length,
        error: r.error,
        matched: r.matched || null,
        nearest: r.nearest || null,
        score: health.score(r.provider),
      })),
      ...pending.map((id) => ({
        provider: id,
        label: id,
        ok: false,
        timedOut: true,
        pending: true,
        ms: Date.now() - started,
        streams: 0,
        error: "still resolving in background (reload stream list to see results)",
        matched: null,
        nearest: null,
        score: health.score(id),
      })),
    ],
    elapsedMs: Date.now() - started,
    budgetMs: budget,
    order: targets,
  };
}

/**
 * Config-scoped cached resolve: partial answers return immediately and upgrade
 * the cache in the background so a reload in Stremio is instant and complete.
 */
export async function resolveCached(params = {}) {
  const timeoutSig = params.timeouts
    ? Object.entries(params.timeouts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(",")
    : "default";

  const key = [
    params.type,
    params.imdbId || params.id,
    params.type === "series" ? params.season ?? 1 : "-",
    params.type === "series" ? params.episode ?? 1 : "-",
    Array.isArray(params.providers) ? params.providers.slice().sort().join(",") : "default",
    timeoutSig,
  ].join("|");

  const PARTIAL_TTL_MS = Number(process.env.RESOLVE_PARTIAL_TTL || config.resolvePartialTtlSec) * 1000;

  return cache
    .wrap(
      key,
      async () => {
        const startedWaiting = Date.now();
        const result = await resolveAll(params);
        if (!result.streams.length && !result.partial) {
          throw Object.assign(new Error("no streams"), {
            retryable: true,
            result,
            elapsedMs: Date.now() - startedWaiting,
          });
        }
        return result;
      },
      config.resolveTtlSec * 1000,
    )
    .then((result) => {
      if (!result?.partial) return result;

      const { complete, ...visible } = result;
      cache.set(key, visible, PARTIAL_TTL_MS);
      complete
        ?.then((full) => {
          if (full) cache.set(key, full, config.resolveTtlSec * 1000);
        })
        .catch(() => {});
      return visible;
    })
    .catch(async (err) => err?.result || resolveAll(params));
}

export const cacheStats = () => cache.stats();
