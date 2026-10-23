/**
 * Stremio stream-only addon routes, configuration UI routes, landing page,
 * and Render /health JSON endpoint.
 */

import path from "node:path";
import { Router } from "express";
import { config } from "../config.js";
import { originOf } from "../lib/url.js";
import { logger } from "../lib/log.js";
import { createTokenBucket } from "../lib/rateLimit.js";
import { parseStremioId, lookupImdb, metadataEnabled } from "../lib/metadata.js";
import {
  ADDON_VERSION,
  BadConfigError,
  buildManifest,
  decodeAddonConfig,
  defaultAddonConfig,
  timeoutsMsFromConfig,
} from "../lib/addonConfig.js";
import { toStremioStreams } from "../lib/streams.js";
import {
  listProviders,
  resolveCached,
  cacheStats,
} from "../providers/registry.js";

const log = logger("addon");
export const addonRouter = Router();

const PUBLIC_DIR = path.join(process.cwd(), "public");
const allowStreamRequest = createTokenBucket();

/** Encode JSON as pure 7-bit ASCII so Node HTTP headers accept any Unicode title/error. */
const asciiJson = (obj) =>
  JSON.stringify(obj).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

function rateLimitStreams(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const decision = allowStreamRequest(ip);
  if (!decision.ok) {
    res.setHeader("Retry-After", String(decision.retryAfterSec));
    return res.status(429).json({
      error: "Too many stream requests — please wait a few seconds.",
    });
  }
  return next();
}

function resolveUserConfig(encoded, availableIds) {
  if (!encoded) return defaultAddonConfig(availableIds);
  return decodeAddonConfig(encoded, availableIds);
}

/* ------------------------------------------------------------------ */
/* Health + Pages                                                      */
/* ------------------------------------------------------------------ */

addonRouter.get("/health", (req, res) => {
  res.json({
    ok: true,
    name: "priva-stremio",
    version: ADDON_VERSION,
    uptime: Math.round(process.uptime()),
    origin: originOf(req),
    cache: cacheStats(),
    providers: listProviders(),
    capabilities: {
      cinemeta: true,
      tmdb: metadataEnabled(),
      proxy: config.proxyEnabled,
    },
    now: new Date().toISOString(),
  });
});

addonRouter.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

addonRouter.get("/configure", (req, res) => {
  if (typeof req.query.config === "string" && req.query.config.length > 0) {
    decodeAddonConfig(req.query.config);
  }
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(PUBLIC_DIR, "configure.html"));
});

addonRouter.get("/:config/configure", (req, res) => {
  decodeAddonConfig(req.params.config);
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(PUBLIC_DIR, "configure.html"));
});

/* ------------------------------------------------------------------ */
/* Manifest                                                            */
/* ------------------------------------------------------------------ */

addonRouter.get("/manifest.json", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.json(buildManifest());
});

addonRouter.get("/:config/manifest.json", (req, res) => {
  const cfg = decodeAddonConfig(req.params.config);
  res.setHeader("Cache-Control", "no-cache");
  res.json(buildManifest(cfg));
});

/* ------------------------------------------------------------------ */
/* Streams                                                             */
/* ------------------------------------------------------------------ */

async function handleStreamRequest(req, res, encodedConfig) {
  const cfg = resolveUserConfig(encodedConfig);

  const rawId = req.params.id;
  const parsed = parseStremioId(req.params.type, rawId);
  if (!parsed.ok) {
    res.setHeader(
      "X-Priva-Stats",
      JSON.stringify({ elapsedMs: 0, partial: false, answered: 0, timedOut: 0, providers: [] }),
    );
    return res.status(200).json({ streams: [] });
  }

  if (!cfg.p.length) {
    res.setHeader(
      "X-Priva-Stats",
      JSON.stringify({ elapsedMs: 0, partial: false, answered: 0, timedOut: 0, providers: [] }),
    );
    return res.status(200).json({ streams: [] });
  }

  const started = Date.now();
  const origin = originOf(req);
  const meta = await lookupImdb({ imdbId: parsed.imdbId, type: parsed.type });

  // Unknown IMDb IDs (not found in Cinemeta or TMDB) return HTTP 200 { streams: [] }.
  if (!meta) {
    res.setHeader(
      "X-Priva-Stats",
      asciiJson({
        elapsedMs: Date.now() - started,
        partial: false,
        answered: 0,
        timedOut: 0,
        note: "unknown id",
        providers: [],
      }),
    );
    return res.status(200).json({ streams: [] });
  }

  try {
    const timeouts = timeoutsMsFromConfig(cfg);
    const result = await resolveCached({
      id: meta?.tmdbId || parsed.imdbId,
      tmdbId: meta?.tmdbId,
      imdbId: parsed.imdbId,
      type: parsed.type,
      season: parsed.season,
      episode: parsed.episode,
      title: meta?.title,
      year: meta?.year,
      providers: cfg.p,
      timeouts,
      baseUrl: origin,
    });

    const streams = toStremioStreams(result.streams || [], {
      origin,
      includeMkv: cfg.mk,
      includeProxy: cfg.px,
      maxStreams: cfg.max,
    });

    const diag = result.diagnostics || [];
    const answered = diag.filter((d) => !d.pending && !d.timedOut).length;
    const withStreams = diag.filter((d) => d.ok).length;
    const timedOut = diag.filter((d) => d.timedOut || d.pending).length;

    const statsHeader = {
      title: meta?.title || result.meta?.title || null,
      year: meta?.year || result.meta?.year || null,
      elapsedMs: Date.now() - started,
      resolverMs: result.elapsedMs,
      partial: Boolean(result.partial),
      answered,
      withStreams,
      timedOut,
      providers: diag.map((d) => ({
        id: d.provider,
        ok: d.ok,
        timedOut: Boolean(d.timedOut || d.pending),
        pending: Boolean(d.pending),
        ms: d.ms,
        streams: d.streams,
        error: d.error || null,
        matched: d.matched?.title || null,
      })),
    };

    res.setHeader("X-Priva-Stats", asciiJson(statsHeader));
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ streams });
  } catch (err) {
    log.error(`stream error for ${parsed.type}/${parsed.imdbId}: ${err.message}`);
    return res.status(200).json({ streams: [] });
  }
}

addonRouter.get("/stream/:type/:id.json", rateLimitStreams, (req, res, next) => {
  handleStreamRequest(req, res, null).catch(next);
});

addonRouter.get("/:config/stream/:type/:id.json", rateLimitStreams, (req, res, next) => {
  handleStreamRequest(req, res, req.params.config).catch(next);
});

/* Error handler for malformed config tokens -> clean 400 without stack trace */
addonRouter.use((err, req, res, next) => {
  if (err instanceof BadConfigError || err?.status === 400) {
    if (req.accepts("html") && !req.path.endsWith(".json")) {
      return res
        .status(400)
        .type("text/plain; charset=utf-8")
        .send(`400 Bad Request — ${err.message}`);
    }
    return res.status(400).json({ error: err.message });
  }
  return next(err);
});
