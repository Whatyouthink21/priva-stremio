/**
 * Stream responses for the TG HUB addon.
 *
 * IMPORTANT — the shape of these objects is dictated by Stremio:
 *   • `url` must be a DIRECT video stream (mp4 / m3u8 / mpd / …).
 *     The TG HUB embed is an HTML page, so putting it in `url` makes
 *     Stremio's internal player fail.
 *   • `externalUrl` is the SDK field for "open this in a browser".
 *     Official Stremio clients (desktop, Android, Stremio Web) honour it.
 * So every stream here is an `externalUrl` stream.
 *
 * Ref: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md
 */

import { buildEmbedUrl, LANGUAGES, DEFAULT_CONFIG } from './config.js';
import { imdbToTmdb, parseStremioId } from './meta.js';

function languageLabel(code) {
  const found = LANGUAGES.find((l) => l.code === code);
  return found ? found.label : code.toUpperCase();
}

/**
 * Build one stream object.
 * @param {object} cfg
 * @param {string} origin  public origin of this addon (needed for the bridge page)
 * @param {string} configParam  encoded config, or '' when defaults are in use
 * @param {{type:string, tmdbId:string, season?:number, episode?:number}} target
 * @param {{code:string, label:string}|null} language
 */
function makeStream(cfg, origin, configParam, target, language) {
  const overrides = language ? { lang: language.code } : {};
  const embedUrl = buildEmbedUrl(cfg, target, overrides);

  let externalUrl = embedUrl;
  if (cfg.useBridge) {
    const prefix = configParam ? `/${configParam}` : '';
    const params = new URLSearchParams({
      type: target.type,
      id: String(target.tmdbId),
      ...(target.type === 'series'
        ? { s: String(target.season), e: String(target.episode) }
        : {}),
      ...(language ? { lang: language.code } : {}),
    });
    externalUrl = `${origin}${prefix}/play.html?${params.toString()}`;
  }

  const suffix = language ? ` · ${languageLabel(language.code)}` : '';
  const where = target.type === 'series' ? `S${target.season}E${target.episode}` : 'Movie';

  return {
    name: `TG HUB${suffix}`,
    description: `${where} · TMDB ${target.tmdbId}\nOpens the TG HUB player in your browser.`,
    externalUrl,
    behaviorHints: {
      notWebReady: false,
      bingeGroup: `tghub-${language ? language.code : cfg.lang || 'default'}`,
    },
  };
}

/**
 * @param {object} cfg
 * @param {'movie'|'series'} type
 * @param {string} id  Stremio id (tt… or tt…:s:e)
 * @param {string} origin
 * @param {string} configParam
 * @returns {Promise<{streams: object[]}>}
 */
export async function getStreams(cfg, type, id, origin, configParam) {
  const parsed = parseStremioId(type, id);
  if (!parsed) return { streams: [] };

  // A series request without season/episode has nothing to open.
  if (type === 'series' && (parsed.season == null || parsed.episode == null)) {
    return { streams: [] };
  }

  const meta = await imdbToTmdb(type, parsed.imdbId);
  if (!meta) return { streams: [] };

  const target = {
    type,
    tmdbId: meta.tmdbId,
    season: parsed.season,
    episode: parsed.episode,
  };

  const streams = [];

  // Primary stream, using whichever language the user picked (or none).
  const primary = cfg.lang ? { code: cfg.lang } : null;
  streams.push(makeStream(cfg, origin, configParam, target, primary));

  // Extra one-click variants for the other configured languages.
  for (const code of cfg.languages) {
    if (code === cfg.lang) continue;
    streams.push(makeStream(cfg, origin, configParam, target, { code }));
  }

  return { streams };
}

export { DEFAULT_CONFIG };
