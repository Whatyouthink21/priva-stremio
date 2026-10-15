/**
 * Config encode / decode for the TG HUB Stremio addon.
 *
 * Stremio lets an addon embed a configuration in the manifest URL path, e.g.
 *   http://localhost:7000/<encodedConfig>/manifest.json
 * We store the config as base64url(JSON) which keeps the URL short-ish and
 * round-trips safely through Stremio's addon installer.
 */

export const LANGUAGES = [
  { code: 'hi', label: 'हिंदी — Hindi' },
  { code: 'eng', label: 'English' },
  { code: 'jap', label: '日本語 — Japanese' },
  { code: 'tam', label: 'தமிழ் — Tamil' },
  { code: 'tel', label: 'తెలుగు — Telugu' },
];

export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code);

export const DEFAULT_CONFIG = {
  /** Origin of the TG HUB embed player. */
  baseUrl: 'https://tgvid.lovable.app',
  /** Accent colour, 6 hex digits, no '#'. Empty = TG HUB default (e11d2e). */
  color: '',
  /** Preferred audio language. Empty = let TG HUB choose. */
  lang: '',
  /** Show the back button. */
  back: 'true',
  /** Show the Episodes button (TV only). */
  episodeSelector: 'true',
  /** Autoplay the next episode (TV only). */
  autoplayNextEp: 'true',
  /** Loading screen style: '1' | '2' | '3'. Empty = 1. */
  loading: '',
  /** Force a specific server, e.g. 'cinemaos'. Empty = first. */
  server: '',
  /** Extra one-click language variants, e.g. ['hi','eng']. */
  languages: [],
  /** Wrap the embed in the local full-screen bridge page (adds cross-session resume). */
  useBridge: false,
};

const HEX = /^[0-9a-fA-F]{6}$/;
const BOOL = ['true', 'false'];
const SERVER = /^[A-Za-z0-9_-]{1,40}$/;

function cleanString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/** Coerce arbitrary input into a valid config object. Never throws. */
export function sanitizeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const d = DEFAULT_CONFIG;

  let baseUrl = cleanString(raw.baseUrl, d.baseUrl);
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'https:') baseUrl = d.baseUrl;
    else baseUrl = u.origin;
  } catch {
    baseUrl = d.baseUrl;
  }

  const color = cleanString(raw.color);
  const loading = cleanString(raw.loading);
  const server = cleanString(raw.server);

  const languages = Array.isArray(raw.languages)
    ? [...new Set(raw.languages.map((c) => cleanString(c)).filter((c) => LANGUAGE_CODES.includes(c)))]
    : [];

  return {
    baseUrl,
    color: HEX.test(color) ? color.toLowerCase() : '',
    lang: LANGUAGE_CODES.includes(cleanString(raw.lang)) ? cleanString(raw.lang) : '',
    back: oneOf(cleanString(raw.back), BOOL, d.back),
    episodeSelector: oneOf(cleanString(raw.episodeSelector), BOOL, d.episodeSelector),
    autoplayNextEp: oneOf(cleanString(raw.autoplayNextEp), BOOL, d.autoplayNextEp),
    loading: ['1', '2', '3'].includes(loading) ? loading : '',
    server: SERVER.test(server) ? server : '',
    languages,
    useBridge: raw.useBridge === true || raw.useBridge === 'true',
  };
}

export function encodeConfig(config) {
  const json = JSON.stringify(sanitizeConfig(config));
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeConfig(encoded) {
  if (!encoded) return { ...DEFAULT_CONFIG };
  try {
    const json = Buffer.from(String(encoded), 'base64url').toString('utf8');
    return sanitizeConfig(JSON.parse(json));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Build the TG HUB embed URL.
 * Movie:  {base}/embed/movie/{tmdbId}
 * TV:     {base}/embed/tv/{tmdbId}/{season}/{episode}
 */
export function buildEmbedUrl(config, target, overrides = {}) {
  const { type, tmdbId, season, episode } = target;
  const cfg = { ...config, ...overrides };
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const path =
    type === 'movie'
      ? `/embed/movie/${encodeURIComponent(tmdbId)}`
      : `/embed/tv/${encodeURIComponent(tmdbId)}/${encodeURIComponent(season)}/${encodeURIComponent(episode)}`;

  const params = new URLSearchParams();
  if (cfg.color) params.set('color', cfg.color);
  if (cfg.lang) params.set('lang', cfg.lang);
  if (cfg.back && cfg.back !== DEFAULT_CONFIG.back) params.set('back', cfg.back);
  if (cfg.episodeSelector && cfg.episodeSelector !== DEFAULT_CONFIG.episodeSelector) {
    params.set('episodeSelector', cfg.episodeSelector);
  }
  if (cfg.autoplayNextEp && cfg.autoplayNextEp !== DEFAULT_CONFIG.autoplayNextEp) {
    params.set('autoplayNextEp', cfg.autoplayNextEp);
  }
  if (cfg.loading) params.set('loading', cfg.loading);
  if (cfg.server) params.set('server', cfg.server);

  const qs = params.toString();
  return qs ? `${base}${path}?${qs}` : `${base}${path}`;
}
