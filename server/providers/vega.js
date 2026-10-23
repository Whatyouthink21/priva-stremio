/**
 * Vega provider bridge.
 *
 * Evaluates pre-bundled CommonJS provider modules (`dist/<provider>/*.js`)
 * from disk (`server/providers/vendor/<provider>/`) or jsDelivr CDN at runtime,
 * and reads mirror base URLs dynamically from upstream `urls.json` (never hardcoded).
 */

import vm from "node:vm";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../lib/log.js";
import { describeError } from "../lib/errors.js";
import {
  normalizeStream,
  extractSizeLabel,
  extractReleaseDetail,
  DEFAULT_HEADERS,
} from "./types.js";
import { BLOCKED_PROVIDERS } from "../../scripts/vendor.mjs";

const log = logger("vega");
const bundleCache = new Map();

const VENDOR_DIR = path.join(process.cwd(), "server", "providers", "vendor");
const JSDELIVR_URLS_JSON =
  "https://cdn.jsdelivr.net/gh/Zenda-Cross/vega-providers@main/urls.json";

export const vendorPathFor = (providerId, module) =>
  path.join(VENDOR_DIR, providerId, `${module}.js`);

let urlsCache = { text: null, expiresAt: 0 };

/**
 * Upstream bundles fetch raw.githubusercontent.com/.../urls.json inside getBaseUrl().
 * Raw GitHub is blocked on several Indian ISPs (Jio/Airtel), so try jsDelivr first,
 * then the bundle's URL, and finally the vendored snapshot when completely offline.
 */
async function resolveUrlsJsonResponse(originalInput, init, headers) {
  if (urlsCache.text && Date.now() < urlsCache.expiresAt) {
    return new Response(urlsCache.text, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const candidates = [JSDELIVR_URLS_JSON, String(originalInput)];
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, {
        ...init,
        headers,
        signal: init.signal || AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const text = await res.text();
        JSON.parse(text);
        urlsCache = { text, expiresAt: Date.now() + 30 * 60_000 };
        return new Response(text, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    } catch {
      /* try next candidate */
    }
  }

  try {
    const fallback = await fs.readFile(path.join(VENDOR_DIR, "urls.json"), "utf8");
    return new Response(fallback, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    throw new Error("unable to fetch vega urls.json from CDN or local cache");
  }
}

function makeSandbox(pc) {
  const noop = () => {};
  return {
    exports: {},
    module: { exports: {} },
    require: (name) => {
      throw new Error(`provider tried to require("${name}") — sandbox forbids modules`);
    },
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    process: { env: {}, nextTick: (fn, ...a) => setTimeout(fn, 0, ...a) },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Buffer,
    atob,
    btoa,
    AbortController,
    AbortSignal,
    crypto: globalThis.crypto,
    structuredClone,
    fetch: (input, init = {}) => {
      const headers = new Headers(DEFAULT_HEADERS);
      try {
        new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value));
      } catch {
        /* malformed headers: fall back to defaults */
      }
      const urlStr = typeof input === "string" ? input : input?.url || "";
      if (/vega-providers.*\/urls\.json(?:\?|$)/i.test(urlStr)) {
        return resolveUrlsJsonResponse(input, init, headers);
      }
      return fetch(input, {
        ...init,
        headers,
        signal: init.signal || AbortSignal.timeout(8_000),
      });
    },
    __providerContext: pc,
  };
}

const vendoredCache = new Map();

async function isVendored(providerId) {
  if (vendoredCache.has(providerId)) return vendoredCache.get(providerId);
  let vendored = false;
  try {
    const st = await fs.stat(path.join(VENDOR_DIR, providerId));
    vendored = st.isDirectory();
  } catch {
    vendored = false;
  }
  vendoredCache.set(providerId, vendored);
  if (vendored) log.debug(`provider "${providerId}" is vendored (offline)`);
  return vendored;
}

async function fetchBundle(providerId, module) {
  const key = `${providerId}/${module}`;
  if (bundleCache.has(key)) return bundleCache.get(key);

  if (await isVendored(providerId)) {
    try {
      const code = await fs.readFile(vendorPathFor(providerId, module), "utf8");
      bundleCache.set(key, code);
      return code;
    } catch {
      return null;
    }
  }

  const base = (process.env.VEGA_CDN_BASE || config.vega.base).replace(/\/+$/, "");
  const url = `${base}/${providerId}/${module}.js`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const code = await res.text();
    bundleCache.set(key, code);
    return code;
  } catch (err) {
    log.warn(`bundle fetch failed for ${providerId}/${module}: ${err.message}`);
    return null;
  }
}

/**
 * Load one Vega provider bundle (vendored first, jsDelivr second).
 */
export async function loadVegaProvider(providerId) {
  const cleanId = String(providerId || "").replace(/^vega:/, "");
  if (BLOCKED_PROVIDERS.has(cleanId)) {
    throw new Error(`provider "${cleanId}" is disabled: ${BLOCKED_PROVIDERS.get(cleanId)}`);
  }

  if (bundleCache.has(`__mod__${cleanId}`)) return bundleCache.get(`__mod__${cleanId}`);

  const exportsObj = {};
  const found = {};

  for (const moduleName of ["catalog", "posts", "meta", "episodes", "stream", "settings"]) {
    const code = await fetchBundle(cleanId, moduleName).catch(() => null);
    if (!code) continue;
    found[moduleName] = true;

    const sandbox = makeSandbox();
    sandbox.exports = exportsObj;
    sandbox.module = { exports: exportsObj };
    try {
      vm.runInNewContext(code, vm.createContext(sandbox), {
        timeout: 8_000,
        filename: `${cleanId}/${moduleName}.js`,
      });
    } catch (err) {
      log.warn(`failed to evaluate ${cleanId}/${moduleName}: ${err.message}`);
    }
  }

  if (!found.stream) throw new Error(`vega provider "${cleanId}" has no stream.js bundle`);

  const mod = {
    id: cleanId,
    label: cleanId,
    exports: exportsObj,
    getStream: exportsObj.getStream,
    getMeta: exportsObj.getMeta,
    getPosts: exportsObj.getPosts,
    getSearchPosts: exportsObj.getSearchPosts,
    getEpisodes: exportsObj.getEpisodes,
    catalog: exportsObj.catalog,
    genres: exportsObj.genres,
  };

  bundleCache.set(`__mod__${cleanId}`, mod);
  return mod;
}

/* ------------------------------------------------------------------ */
/* Title matching                                                      */
/* ------------------------------------------------------------------ */

const RELEASE_NOISE = new Set([
  "144p", "240p", "360p", "480p", "540p", "576p", "720p", "1080p", "1440p", "2160p", "4k", "8k",
  "uhd", "hd", "sd", "fhd", "qhd", "fullhd", "webhd", "4kuhd", "480i", "1080i",
  "hdtv", "hdrip", "webrip", "webdl", "bluray", "brrip", "bdrip", "dvdrip", "dl",
  "dvd", "dvdscr", "hdcam", "cam", "camrip", "ts", "tc", "ppv", "print", "pre", "predvd", "remux",
  "proper", "repack", "internal", "limited", "extended", "uncut", "unrated", "theatrical", "directors",
  "imax", "criterion",
  "x264", "x265", "h264", "h265", "hevc", "avc", "xvid", "divx", "aac", "ac3", "eac3", "dts", "dd",
  "ddp", "dd5", "dd2", "ddp5", "atmos", "truehd", "flac", "mp3", "opus", "10bit", "8bit", "hdr", "hdr10", "sdr", "dovi",
  "dolby", "vision", "dual", "multi", "audio", "org", "esub", "esubs", "sub", "subs", "subtitles",
  "hindi", "english", "tamil", "telugu", "malayalam", "kannada", "marathi", "bengali", "punjabi",
  "gujarati", "urdu", "nepali", "sinhala", "dubbed", "dub", "voiceover", "original",
  "mkv", "mp4", "avi", "webm", "zip", "rar",
  "nf", "amzn", "dsnp", "hmax", "atvp", "pc", "rip", "encoded", "encode",
  "yify", "yts", "ytsmx", "evo", "galaxy", "galaxyrg", "psa", "rarbg", "ntb", "qxr", "tigole",
  "anoxmous", "framestor", "utopia", "ctrlhd", "wiki", "fgt", "ion10", "megusta", "eros",
  "vegamovies", "moviesflix", "hdhub4u", "katmoviehd", "mkvcinemas", "9xmovies", "filmyzilla",
  "bolly4u", "worldfree4u", "downloadhub", "300mbmovies", "filmywap", "movierulz", "tamilblasters",
  "tamilrockers", "kuttymovies", "isaimini", "jiorockers", "ibomma", "hotstar", "zee5", "sonyliv",
  "primevideo", "netflix", "mxplayer", "jiocinema", "aha",
]);

const SEQUEL_WORDS = new Set([
  "rises", "risen", "rising", "returns", "return", "reloaded", "revolutions", "resurrection",
  "legacy", "origins", "origin", "begins", "beginning", "forever", "awakening", "evolution",
  "empire", "reborn", "relaunch", "again", "continued", "finale", "conclusion",
  "revenge", "judgment", "judgement", "salvation", "uprising", "revelations", "ascension",
]);

const EPISODE_MARKER = /^(?:s\d{1,3}(?:e\d{1,4})?|e\d{1,4}|\d{1,2}x\d{1,4}|season\d+|ep\d+)$/;

const DESCRIPTORS = new Set([
  "movie", "movies", "film", "films", "series", "season", "seasons", "complete", "download",
  "downloads", "watch", "online", "free", "full", "pack", "episode", "episodes", "quality",
  "hq", "print", "prints", "new", "latest",
]);

const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "to", "in", "on", "at", "for", "with", "vol", "part", "chapter", "pt",
]);

export function titleTokens(value, { keepNoise = false } = {}) {
  const cleaned = String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/blu[\s._-]*ray/g, " bluray ")
    .replace(/web[\s._-]*(?:dl|rip)/g, " webrip ")
    .replace(/hd[\s._-]*rip/g, " hdrip ")
    .replace(/\b[0-9]\.[0-9]\b/g, " ")
    .replace(/[._+]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const split = (text) => (text ? text.split(" ").filter(Boolean) : []);
  const words = split(cleaned.replace(/\b(19|20)\d{2}\b/g, " "));

  const pick = (list) => {
    const tokens = [];
    for (const w of list) {
      if (EPISODE_MARKER.test(w)) continue;
      if (!keepNoise && (RELEASE_NOISE.has(w) || STOPWORDS.has(w))) continue;
      if (tokens.includes(w)) continue;
      tokens.push(w);
    }
    return tokens;
  };

  const tokens = pick(words);
  if (tokens.length) return tokens;
  return pick(split(cleaned));
}

export function yearOf(value) {
  const m = String(value || "").match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

export function yearsIn(value) {
  return [...String(value || "").matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
}

export function providerPayload({ tmdbId, imdbId, title, year, type, season, episode }) {
  const payload = { type };
  let resolvedImdb = imdbId ? String(imdbId) : "";
  let resolvedTmdb = tmdbId !== undefined && tmdbId !== null ? String(tmdbId) : "";
  if (/^tt\d+/i.test(resolvedTmdb)) {
    if (!resolvedImdb) resolvedImdb = resolvedTmdb;
    resolvedTmdb = "";
  }
  if (title) payload.title = String(title);
  if (resolvedTmdb) payload.tmdbId = resolvedTmdb;
  if (resolvedImdb) payload.imdbId = resolvedImdb;
  if (year) payload.year = String(year).slice(0, 4);
  if (type === "series") {
    payload.season = season !== undefined && season !== null ? Number(season) : 1;
    payload.episode = episode !== undefined && episode !== null ? Number(episode) : 1;
  }
  if (!payload.tmdbId && !payload.imdbId) return null;
  return JSON.stringify(payload);
}

export function seasonOf(value) {
  const s = String(value || "");
  const m =
    s.match(/\bS(\d{1,2})(?:E\d{1,3})?\b/i) ||
    s.match(/\bSeason\s*(\d{1,2})\b/i) ||
    s.match(/\b(\d{1,2})x\d{1,3}\b/);
  return m ? Number(m[1]) : null;
}

export function matchPost(want, postTitle) {
  const title = want?.title;
  const qTokens = titleTokens(title);
  const pTokens = titleTokens(postTitle);
  const postYears = yearsIn(postTitle);
  const wantYearRaw = Number(want?.year) || null;
  const wanted = wantYearRaw ? postYears.find((y) => Math.abs(y - wantYearRaw) <= 1) : undefined;
  const postYear = wanted ?? postYears[0] ?? null;
  const postSeason = seasonOf(postTitle);

  const base = { score: 0, postYear, postSeason };

  if (!qTokens.length) return { ...base, ok: false, reason: "empty title" };
  if (!pTokens.length) return { ...base, ok: false, reason: "empty post title" };

  const Q = new Set(qTokens);
  const P = new Set(pTokens);

  const coreQ = qTokens.filter((t) => !DESCRIPTORS.has(t));
  const coreP = pTokens.filter((t) => !DESCRIPTORS.has(t));
  const required = coreQ.length ? coreQ : qTokens;
  const offered = coreP.length ? coreP : pTokens;

  const missing = required.filter((t) => !P.has(t));
  const extra = offered.filter((t) => !Q.has(t));

  const droppedNumber = missing.some((t) => /^\d+$/.test(t));
  const containsQuery = missing.length === 0;
  const queryContainsPost = extra.length === 0 && P.size >= 2 && !droppedNumber;

  if (!containsQuery && !queryContainsPost) {
    return {
      ...base,
      ok: false,
      reason: missing.length
        ? `does not name "${missing.join(" ")}"`
        : `adds "${extra.join(" ")}"`,
    };
  }

  const wantYear = Number(want?.year) || null;
  const enforceYear = want?.enforceYear !== false;
  const yearMatch = wantYear ? postYears.find((y) => Math.abs(y - wantYear) <= 1) : undefined;
  if (enforceYear && wantYear && postYears.length && yearMatch === undefined) {
    return { ...base, ok: false, reason: `year ${postYears.join("/")} != ${wantYear}` };
  }

  const isPrefix =
    pTokens.length > qTokens.length &&
    pTokens.slice(0, qTokens.length).join(" ") === qTokens.join(" ");
  const yearMatches = yearMatch !== undefined;

  if (isPrefix && !yearMatches) {
    const tail = pTokens.slice(qTokens.length);
    const sequelTail = tail.filter((t) => SEQUEL_WORDS.has(t));
    if (sequelTail.length) {
      return { ...base, ok: false, reason: `sequel — "${sequelTail.join(" ")}"` };
    }
    const titleLike = tail.filter((t) => !/^\d+$/.test(t) && t.length > 2 && !DESCRIPTORS.has(t));
    if (titleLike.length) {
      return { ...base, ok: false, reason: `longer title — "${titleLike.join(" ")}"` };
    }
  }

  const inter = [...Q].filter((t) => P.has(t)).length;
  const union = new Set([...Q, ...P]).size;
  let score = 0.6 * (containsQuery ? 1 : 0.5) + 0.4 * (inter / union);
  if (qTokens.length === pTokens.length && qTokens.join(" ") === pTokens.join(" ")) score = 1;
  if (yearMatches) score = Math.min(1, score + 0.1);

  const wantSeason =
    want?.season !== undefined && want?.season !== null && want?.season !== ""
      ? Number(want.season)
      : null;
  if (wantSeason !== null && postSeason !== null) {
    if (postSeason === wantSeason) score = Math.min(1, score + 0.08);
    else score = Math.max(0, score - 0.08);
  }

  return { ...base, ok: true, score };
}

export function choosePost(want, posts) {
  const scored = (posts || [])
    .map((p, i) => ({ p, i, ...matchPost(want, p.title) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);

  const passing = scored.filter((s) => s.ok);
  if (passing.length) return { chosen: passing[0].p, ranked: passing, nearest: null };

  const soft = (posts || [])
    .map((p) => {
      const q = new Set(titleTokens(want?.title));
      const pt = new Set(titleTokens(p.title));
      if (!q.size || !pt.size) return { p, s: 0 };
      const inter = [...q].filter((t) => pt.has(t)).length;
      return { p, s: inter / new Set([...q, ...pt]).size };
    })
    .sort((a, b) => b.s - a.s);

  return {
    chosen: null,
    ranked: [],
    nearest: soft[0]?.s > 0 ? soft[0] : null,
    reason:
      soft[0]?.s > 0
        ? `no confident match — closest was "${soft[0].p.title}"`
        : (posts || []).length
          ? "no search match"
          : `search returned nothing for "${want?.title || ""}"`,
  };
}

const firstNumber = (m) => {
  const v = Number(m);
  return Number.isFinite(v) ? v : NaN;
};

export function seasonNumberOf(title) {
  const t = String(title || "");
  if (/\bspecials?\b/i.test(t) && !/\d/.test(t)) return 0;
  const se = t.match(/s(\d{1,2})\s*e\d{1,3}/i) || t.match(/(\d{1,2})\s*[xX]\s*\d{1,3}/);
  if (se) return firstNumber(se[1]);
  const sOnly = t.match(/season\s*(\d{1,2})/i);
  if (sOnly) return firstNumber(sOnly[1]);
  const any = t.match(/(\d+)/);
  return any ? firstNumber(any[1]) : NaN;
}

export function episodeNumberOf(title) {
  const t = String(title || "");
  const se = t.match(/s\d{1,2}\s*e(\d{1,3})/i) || t.match(/\d{1,2}\s*[xX]\s*(\d{1,3})/);
  if (se) return firstNumber(se[1]);
  const e = t.match(/episode\s*(\d{1,3})/i) || t.match(/\bep\s*\.?\s*(\d{1,3})/i);
  if (e) return firstNumber(e[1]);
  const any = t.match(/(\d+)/);
  return any ? firstNumber(any[1]) : NaN;
}

export function pickMediaLinks(info, season, episode) {
  const list = Array.isArray(info?.linkList) ? info.linkList : [];
  if (!list.length) return [];

  const isSeries = String(info?.type || "").toLowerCase() === "series";

  if (!isSeries) {
    return list.flatMap((entry) => {
      if (Array.isArray(entry?.directLinks) && entry.directLinks.length) {
        return entry.directLinks
          .filter((d) => d && d.link)
          .map((d) => ({
            ...d,
            ...(d.quality || entry.quality ? { quality: d.quality || entry.quality } : {}),
            title:
              entry.title && d.title && d.title !== entry.title
                ? `${entry.title} · ${d.title}`
                : d.title || entry.title || "",
          }));
      }
      if (entry?.episodesLink) return [{ episodesLink: entry.episodesLink }];
      return [];
    });
  }

  const targetSeason = Number(season);
  const seasonEntry = list.find((l) => seasonNumberOf(l.title) === targetSeason) || list[0];

  if (Array.isArray(seasonEntry?.directLinks) && seasonEntry.directLinks.length) {
    const eps = seasonEntry.directLinks
      .filter((d) => d && d.link)
      .map((d) => ({
        ...d,
        ...(d.quality || seasonEntry.quality ? { quality: d.quality || seasonEntry.quality } : {}),
      }));
    const matches = eps.filter((d) => episodeNumberOf(d.title) === Number(episode));
    return matches.length ? matches : [eps[0]].filter(Boolean);
  }
  if (seasonEntry?.episodesLink) return [{ episodesLink: seasonEntry.episodesLink }];
  return [];
}

/**
 * Best chance of instant playback first:
 *   hls -> mp4 -> dash -> mkv, descending quality within each group.
 */
export function rankStreams(streams) {
  const typeRank = (t) =>
    t === "hls" ? 0 : t === "mp4" ? 1 : t === "dash" ? 2 : t === "mkv" ? 3 : 4;
  return streams.slice().sort(
    (a, b) =>
      typeRank(a.type) - typeRank(b.type) ||
      Number(b.quality || 0) - Number(a.quality || 0),
  );
}

export async function streamHeaders(pc, link) {
  const out = {};
  const common = pc?.commonHeaders || {};

  const ua = common["User-Agent"] || common["user-agent"];
  if (ua) out["user-agent"] = String(ua);

  let jarCookies = {};
  if (typeof pc?.getCookies === "function") {
    try {
      jarCookies = (await pc.getCookies(link)) || {};
    } catch {
      jarCookies = {};
    }
  }

  const parts = [];
  const commonCookie = common.Cookie || common.cookie;
  if (commonCookie) parts.push(String(commonCookie));

  if (jarCookies && typeof jarCookies === "object") {
    const present = () => `; ${parts.join("; ")};`;
    const escape = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const extra = Object.entries(jarCookies)
      .filter(([k, v]) => v && !new RegExp(`[;\\s]${escape(k)}=`).test(present()))
      .map(([k, v]) => `${k}=${v}`);
    if (extra.length) parts.push(extra.join("; "));
  }
  if (parts.length) out.cookie = parts.join("; ");

  let origin = "";
  try {
    origin = new URL(link).origin + "/";
  } catch {
    /* ignore */
  }
  out.referer = common.Referer || common.referer || origin || undefined;
  if (!out.referer) delete out.referer;

  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}

/**
 * Run a Vega provider through its chain:
 *   - Direct ID payload fast-path for ID-native aggregators (e.g. autoEmbed)
 *   - Search -> Meta -> (Episodes) -> Stream chain for link-native providers
 */
export async function resolveViaVega({
  providerId,
  tmdbId,
  type,
  season = 1,
  episode = 1,
  title,
  year,
  imdbId,
  providerContext,
  signal,
}) {
  const mod = await loadVegaProvider(providerId);
  const pc = providerContext;
  const isMovie = type === "movie";

  // 1. Direct JSON payload fast path when a provider is purely ID-native (no getMeta)
  //    OR is autoEmbed (which otherwise makes 3 redundant Cinemeta HTTP hops before getStream).
  if (
    typeof mod.getStream === "function" &&
    (!mod.getMeta || mod.id === "autoEmbed")
  ) {
    const payload = providerPayload({ tmdbId, imdbId, title, year, type, season, episode });
    if (payload) {
      try {
        const raw = await mod.getStream({ link: payload, type, signal, providerContext: pc });
        const streams = [];
        for (const item of raw || []) {
          const s = normalizeStream(item, providerId);
          if (!s) continue;
          s.headers = { ...(await streamHeaders(pc, s.link)), ...(s.headers || {}) };
          streams.push(s);
        }
        if (streams.length) {
          return {
            streams: rankStreams(streams),
            meta: title ? { title, year } : null,
            matched: title ? { title, score: 1 } : null,
          };
        }
      } catch {
        /* fall through to search path if present */
      }
    }
  }

  // 2. Search-based chain
  if (!title && typeof mod.getSearchPosts === "function") {
    return {
      streams: [],
      meta: null,
      reason: "title required — Cinemeta/TMDB had no title for this id",
    };
  }

  if (typeof mod.getSearchPosts === "function" && title) {
    const search = async (page) =>
      (await mod.getSearchPosts({
        searchQuery: title,
        page,
        providerValue: mod.id,
        signal,
        providerContext: pc,
      })) || [];

    let posts = await search(1);
    const want = {
      title,
      year,
      season: isMovie ? undefined : season,
      enforceYear: isMovie,
    };
    let pick = choosePost(want, posts);

    if (!pick.chosen && !pick.nearest && posts.length >= 5) {
      try {
        const more = await search(2);
        if (more.length) {
          posts = posts.concat(more);
          pick = choosePost(want, posts);
        }
      } catch {
        /* page 2 is best-effort */
      }
    }

    if (!pick.chosen) {
      return {
        streams: [],
        meta: null,
        reason: pick.reason || "no search match",
        nearest: pick.nearest
          ? { title: pick.nearest.p.title, score: Number(pick.nearest.s.toFixed(2)) }
          : null,
      };
    }

    const chosen = pick.chosen;
    const matched = {
      title: chosen.title,
      score: Number((pick.ranked[0]?.score || 0).toFixed(2)),
    };

    const info = await mod.getMeta({
      link: chosen.link,
      provider: mod.id,
      providerContext: pc,
    });

    let media = pickMediaLinks(info, season, episode);

    if (media.length === 1 && media[0].episodesLink && typeof mod.getEpisodes === "function") {
      const eps = (await mod.getEpisodes({ url: media[0].episodesLink, providerContext: pc })) || [];
      const wantsSeason = Number.isFinite(Number(season)) ? Number(season) : 1;
      const wantsEpisode = Number.isFinite(Number(episode)) ? Number(episode) : 1;
      const scored = eps.filter((e) => episodeNumberOf(e.title) === wantsEpisode);
      const sameSeason = scored.find((e) => {
        const s = seasonNumberOf(e.title);
        return !Number.isFinite(s) || s === wantsSeason;
      });
      const ep = sameSeason || scored[0] || eps[0];
      media = ep ? [{ link: ep.link, title: ep.title }] : [];
    }

    media = media.filter((m) => m && m.link);

    const linkList = Array.isArray(info?.linkList) ? info.linkList : [];
    const declaredLinks = linkList.reduce(
      (n, e) =>
        n + (Array.isArray(e?.directLinks) ? e.directLinks.length : 0) + (e?.episodesLink ? 1 : 0),
      0,
    );
    const emptyParse =
      declaredLinks === 0
        ? `matched "${chosen.title}" but its metadata step returned 0 download links — the site layout or its metadata API may have changed`
        : null;

    if (!media.length) {
      const payload = providerPayload({
        tmdbId,
        imdbId: imdbId || /tt\d{6,}/.exec(chosen.link || "")?.[0],
        title,
        year,
        type,
        season,
        episode,
      });
      media = [
        ...(payload ? [{ link: payload, title: chosen.title }] : []),
        { link: chosen.link, title: chosen.title },
      ];
    }

    const streams = [];
    const seen = new Set();
    const failures = [];

    const CONCURRENCY = Number(process.env.VEGA_LINK_CONCURRENCY || config.vega.linkConcurrency || 3);
    for (let i = 0; i < media.length; i += CONCURRENCY) {
      const batch = media.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((m) =>
          mod.getStream({
            link: m.link,
            type: isMovie ? "movie" : "series",
            signal,
            providerContext: pc,
          }),
        ),
      );

      for (let j = 0; j < settled.length; j++) {
        const r = settled[j];
        if (r.status !== "fulfilled") {
          const reason = describeError(r.reason);
          if (!failures.includes(reason)) failures.push(reason);
          continue;
        }
        const entryMeta = batch[j] || {};
        for (const raw of r.value || []) {
          const stream = normalizeStream(raw, mod.id);
          if (!stream) continue;
          const fingerprint = `${stream.type}:${stream.link}`;
          if (seen.has(fingerprint)) continue;
          seen.add(fingerprint);

          if (!stream.quality && entryMeta.quality) {
            const q = String(entryMeta.quality).replace(/[^\d]/g, "");
            if (q) stream.quality = q;
          }
          if (!stream.quality && entryMeta.title) {
            const qm = /\b(2160|1440|1080|720|576|540|480|360)p\b/i.exec(entryMeta.title);
            if (qm) stream.quality = qm[1];
          }
          if (!stream.size && entryMeta.title) {
            stream.size = extractSizeLabel(null, entryMeta.title);
          }
          if (!stream.detail) {
            const rel = extractReleaseDetail(entryMeta.title || chosen.title || "");
            if (rel && stream.server && stream.server.toLowerCase() !== mod.id.toLowerCase()) {
              stream.detail = `${rel} · ${stream.server}`;
            } else if (rel) {
              stream.detail = rel;
            }
          }
          stream.headers = { ...(await streamHeaders(pc, stream.link)), ...(stream.headers || {}) };
          streams.push(stream);
        }
      }
    }

    if (!streams.length) {
      const reason = [
        emptyParse,
        failures.length ? `extractor failed: ${failures.slice(0, 2).join(" · ")}` : null,
      ]
        .filter(Boolean)
        .join(" — ");
      if (reason) return { streams: [], meta: null, matched, reason, nearest: null };
    }

    return {
      streams: rankStreams(streams),
      matched,
      meta: {
        title: info?.title || chosen.title,
        year: info?.year || yearOf(chosen.title) || undefined,
        overview: info?.synopsis,
        poster: info?.image,
        backdrop: info?.poster || info?.image,
        genres: info?.tags || [],
        imdbId: info?.imdbId,
      },
    };
  }

  return { streams: [], meta: null, reason: "provider exposes no resolvable path" };
}
