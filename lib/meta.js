/**
 * Resolve Stremio IDs (IMDb `tt…`) to the TMDB numeric IDs that the
 * TG HUB embed URL needs.
 *
 * Primary source: Stremio's own metadata addon, Cinemeta, which returns
 * `moviedb_id` on every meta object. No API key needed.
 *
 * Fallback: TMDB's `/find` endpoint, used only when you set TMDB_API_KEY.
 * Handy if Cinemeta is unreachable on your network.
 */

const CINEMETA = 'https://v3-cinemeta.strem.io';
const TMDB = 'https://api.themoviedb.org/3';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const TIMEOUT_MS = 10_000;
const cache = new Map();

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function setCache(key, value) {
  // Cheap bound so a long-running process can't grow without limit.
  if (cache.size > 5000) cache.clear();
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

async function getJson(url) {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Cinemeta: meta.moviedb_id */
async function viaCinemeta(type, imdbId) {
  const body = await getJson(`${CINEMETA}/meta/${type}/${encodeURIComponent(imdbId)}.json`);
  const meta = body && body.meta;
  const id = meta && (meta.moviedb_id ?? meta.moviedbId);
  if (id == null || String(id).trim() === '') return null;
  return { tmdbId: String(id), name: (meta && meta.name) || imdbId, via: 'cinemeta' };
}

/** TMDB /find with external_source=imdb_id */
async function viaTmdb(type, imdbId) {
  const key = process.env.TMDB_API_KEY;
  if (!key) return null;

  const body = await getJson(
    `${TMDB}/find/${encodeURIComponent(imdbId)}?api_key=${encodeURIComponent(key)}&external_source=imdb_id`
  );
  if (!body) return null;

  const hit = type === 'movie'
    ? (body.movie_results || [])[0]
    : (body.tv_results || [])[0];
  if (!hit || hit.id == null) return null;

  return { tmdbId: String(hit.id), name: hit.title || hit.name || imdbId, via: 'tmdb' };
}

/**
 * @param {'movie'|'series'} type
 * @param {string} imdbId  e.g. 'tt0111161'
 * @returns {Promise<{tmdbId: string, name: string, via: string}|null>}
 */
export async function imdbToTmdb(type, imdbId) {
  const key = `${type}:${imdbId}`;
  const cached = getCached(key);
  if (cached !== undefined) return cached;

  const result =
    (await viaCinemeta(type, imdbId)) ||
    (await viaTmdb(type, imdbId)) ||
    null;

  setCache(key, result);
  return result;
}

export function parseStremioId(type, id) {
  const clean = String(id || '').trim();

  if (type === 'movie') {
    return /^tt\d+$/i.test(clean) ? { imdbId: clean } : null;
  }

  // series: tt1234567  or  tt1234567:3:7
  const m = /^(tt\d+)(?::(\d+):(\d+))?$/i.exec(clean);
  if (!m) return null;
  return {
    imdbId: m[1],
    season: m[2] ? Number(m[2]) : undefined,
    episode: m[3] ? Number(m[3]) : undefined,
  };
}
