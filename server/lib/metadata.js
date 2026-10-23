/**
 * Stremio ID parser + Cinemeta metadata resolver (zero API key required,
 * optional TMDB enrichment if TMDB_API_KEY is configured).
 */

import { config } from "../config.js";
import { TtlCache } from "./cache.js";
import { logger } from "./log.js";

const log = logger("meta");
const cache = new TtlCache({ max: 1000, defaultTtlMs: 24 * 60 * 60 * 1000 });
const DAY = 24 * 60 * 60 * 1000;

export const metadataEnabled = () => Boolean(config.tmdbKey);

const cinemetaBase = () =>
  (process.env.CINEMETA_BASE || "https://v3-cinemeta.strem.io").replace(/\/+$/, "");

/**
 * Parse a Stremio stream route request:
 *   movie:  tt0133093
 *   series: tt0944947:1:1   (season 0 = specials, bare tt... -> invalid for series)
 */
export function parseStremioId(type, rawId) {
  const kind = String(type || "").trim().toLowerCase();
  const clean = decodeURIComponent(String(rawId || "").trim()).replace(/\.json$/i, "");

  if (kind !== "movie" && kind !== "series") {
    return { ok: false, reason: `unsupported media type "${kind}"` };
  }

  if (kind === "movie") {
    const m = /^(tt\d{5,12})$/i.exec(clean);
    if (!m) return { ok: false, reason: `invalid movie id "${clean}"` };
    return { ok: true, type: "movie", imdbId: m[1].toLowerCase() };
  }

  // Series requires tt...:season:episode; bare tt... returns { streams: [] }, never 404.
  const m = /^(tt\d{5,12}):(\d+):(\d+)$/i.exec(clean);
  if (!m) {
    return { ok: false, reason: `series id "${clean}" requires tt...:season:episode` };
  }

  const season = Number(m[2]);
  const episode = Number(m[3]);
  if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 0) {
    return { ok: false, reason: `invalid season/episode in "${clean}"` };
  }

  return {
    ok: true,
    type: "series",
    imdbId: m[1].toLowerCase(),
    season,
    episode,
  };
}

function parseYear(raw) {
  const m = /\b(19|20)\d{2}\b/.exec(String(raw || ""));
  return m ? Number(m[0]) : undefined;
}

async function fetchCinemeta(imdbId, type, signal) {
  const url = `${cinemetaBase()}/meta/${type}/${encodeURIComponent(imdbId)}.json`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: signal || AbortSignal.timeout(5_000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const meta = data?.meta;
  if (!meta || !meta.name) return null;

  return {
    imdbId,
    tmdbId: meta.moviedb_id ? String(meta.moviedb_id) : undefined,
    title: String(meta.name).trim(),
    year: parseYear(meta.year) || parseYear(meta.releaseInfo),
    poster: meta.poster || undefined,
    backdrop: meta.background || undefined,
    overview: meta.description || undefined,
  };
}

async function fetchTmdbByImdb(imdbId, type, signal) {
  if (!config.tmdbKey) return null;
  const url =
    `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}` +
    `?api_key=${encodeURIComponent(config.tmdbKey)}&external_source=imdb_id`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: signal || AbortSignal.timeout(5_000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const hit =
    type === "series"
      ? data?.tv_results?.[0] || data?.movie_results?.[0]
      : data?.movie_results?.[0] || data?.tv_results?.[0];
  if (!hit) return null;

  const title = hit.title || hit.name;
  if (!title) return null;
  return {
    imdbId,
    tmdbId: hit.id ? String(hit.id) : undefined,
    title: String(title).trim(),
    year: parseYear(hit.release_date || hit.first_air_date),
    poster: hit.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : undefined,
    backdrop: hit.backdrop_path ? `https://image.tmdb.org/t/p/w1280${hit.backdrop_path}` : undefined,
    overview: hit.overview || undefined,
  };
}

/**
 * Look up { title, year, tmdbId, imdbId } from Cinemeta (primary, keyless) with
 * optional TMDB fallback when TMDB_API_KEY is set.
 */
export async function lookupImdb({ imdbId, type = "movie", signal } = {}) {
  if (!imdbId || !/^tt\d{5,12}$/i.test(String(imdbId))) return null;
  const key = `${type}:${String(imdbId).toLowerCase()}`;

  try {
    return await cache.wrap(
      key,
      async () => {
        const cm = await fetchCinemeta(imdbId, type, signal).catch((err) => {
          log.debug(`cinemeta failed for ${key}: ${err.message}`);
          return null;
        });

        if (cm && (cm.tmdbId || !config.tmdbKey)) return cm;

        const tmdb = await fetchTmdbByImdb(imdbId, type, signal).catch((err) => {
          log.debug(`tmdb fallback failed for ${key}: ${err.message}`);
          return null;
        });

        if (cm && tmdb) {
          return {
            ...tmdb,
            ...cm,
            tmdbId: cm.tmdbId || tmdb.tmdbId,
            year: cm.year || tmdb.year,
          };
        }
        return cm || tmdb || null;
      },
      DAY,
    );
  } catch {
    return null;
  }
}

export function clearMetadataCache() {
  cache.clear();
}
