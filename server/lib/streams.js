/**
 * Stremio stream formatting, deduplication, direct + proxy row expansion,
 * header forwarding, and cap enforcement.
 */

import crypto from "node:crypto";
import { verify } from "./token.js";
import { rankStreams } from "../providers/vega.js";
import { makeProxyUrl } from "../routes/proxy.js";

const MAX_STREMIO_NAME = 14;

const HEADER_CASE = {
  referer: "Referer",
  origin: "Origin",
  "user-agent": "User-Agent",
  cookie: "Cookie",
  authorization: "Authorization",
  "accept-language": "Accept-Language",
};

const PROXY_TOKEN_RE = /\/p\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?:[/?#]|$)/;

/**
 * Unwrap a signed `/p/<token>` URL back to its underlying target URL so a link
 * re-signed at a new timestamp still hashes to the exact same stream identity.
 */
export function unwrapStreamUrl(rawUrl) {
  const str = String(rawUrl || "").trim();
  const m = PROXY_TOKEN_RE.exec(str);
  if (m) {
    const decoded = verify(m[1]);
    if (decoded?.u) return String(decoded.u).trim();
  }
  return str;
}

/**
 * Stable identity for a playable stream across responses and re-signatures.
 */
export function streamKey(stream) {
  const rawUrl = stream?.link || stream?.url || "";
  const canonicalUrl = unwrapStreamUrl(rawUrl);
  const kind = String(stream?.container || stream?.type || "").toLowerCase();
  const identity = kind ? `${kind}:${canonicalUrl}` : canonicalUrl;
  return crypto.createHash("sha1").update(identity).digest("base64url").slice(0, 12);
}

/**
 * Deduplicate an array of internal streams or Stremio stream rows by canonical target URL.
 */
export function dedupeStreams(streams) {
  const out = [];
  const seen = new Set();
  for (const s of streams || []) {
    if (!s) continue;
    const key = streamKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export function cleanProviderId(providerId) {
  return String(providerId || "source").replace(/^vega:/, "").trim() || "source";
}

/**
 * Enforce Stremio's narrow left-column width (`name <= 14` chars).
 */
export function formatStreamName(providerId, isProxy = false) {
  const base = cleanProviderId(providerId);
  if (!isProxy) return base.slice(0, MAX_STREMIO_NAME);
  if (base.length <= 6) return `${base} · proxy`;
  if (base.length <= 10) return `${base} [P]`;
  return `${base.slice(0, 10)} [P]`;
}

export function normalizeProxyHeaders(headers) {
  if (!headers || typeof headers !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!v || /[\r\n]/.test(String(v))) continue;
    const canonical = HEADER_CASE[k.toLowerCase()] || k;
    out[canonical] = String(v);
  }
  return Object.keys(out).length ? out : null;
}

function shouldEmitProxyRow(stream, reqHeaders) {
  if (stream.proxy === false || stream.corsOk === true) return false;
  if (reqHeaders && Object.keys(reqHeaders).length > 0) return true;
  if (stream.type === "hls" || stream.type === "dash") return true;
  return Boolean(stream.proxy);
}

function formatTitle(stream, { isProxy = false } = {}) {
  const qNum = String(stream.quality || "").replace(/[^\d]/g, "");
  const qLabel = qNum ? `${qNum}p` : "";
  const containerLabel = String(stream.type || "mp4").toUpperCase();
  const sizeLabel = stream.size ? String(stream.size).trim() : "";

  const topLine = [qLabel, containerLabel, sizeLabel].filter(Boolean).join(" · ");

  const cleanProv = cleanProviderId(stream.provider || stream.server);
  const detailParts = [];
  if (stream.detail) {
    detailParts.push(String(stream.detail).trim());
  } else if (stream.server && stream.server.toLowerCase() !== cleanProv.toLowerCase()) {
    detailParts.push(String(stream.server).trim());
  }
  if (Array.isArray(stream.subtitles) && stream.subtitles.length > 0) {
    detailParts.push(`${stream.subtitles.length} sub${stream.subtitles.length > 1 ? "s" : ""}`);
  }
  if (isProxy) detailParts.push("Proxy");

  const secondLine = detailParts.join(" · ");
  return secondLine ? `${topLine}\n${secondLine}` : topLine;
}

function formatSubtitles(subtitles, key, origin, headers, useProxy) {
  if (!Array.isArray(subtitles) || !subtitles.length) return undefined;
  return subtitles
    .filter((s) => s && typeof s.uri === "string" && s.uri)
    .map((s, idx) => ({
      id: `${key}-${useProxy ? "p" : "d"}sub-${idx}`,
      url: useProxy ? `${origin}${makeProxyUrl(s.uri, headers || {})}` : s.uri,
      lang: s.language || s.title || "eng",
    }));
}

/**
 * Convert normalized resolver streams into ranked, deduplicated Stremio rows:
 *   1. Direct row: upstream URL + behaviorHints.proxyHeaders.request (zero server bandwidth)
 *   2. Proxy row:  https://<host>/p/<token> (when includeProxy is on and stream needs headers/CORS)
 */
export function toStremioStreams(
  rawStreams,
  {
    origin,
    includeMkv = true,
    includeProxy = true,
    maxStreams = 20,
  } = {},
) {
  const unique = dedupeStreams(rawStreams).filter((s) => includeMkv || s.type !== "mkv");
  const ranked = rankStreams(unique);
  const rows = [];

  for (const stream of ranked) {
    if (rows.length >= maxStreams) break;

    const provider = cleanProviderId(stream.provider || stream.server);
    const key = streamKey(stream);
    const reqHeaders = normalizeProxyHeaders(stream.headers);
    const bingeGroup = `priva-${provider}`;

    const directHints = { bingeGroup };
    if (reqHeaders) directHints.proxyHeaders = { request: reqHeaders };
    if (stream.type === "mkv" || reqHeaders) directHints.notWebReady = true;

    const directRow = {
      name: formatStreamName(provider, false),
      title: formatTitle(stream, { isProxy: false }),
      url: stream.link,
      behaviorHints: directHints,
    };
    const directSubs = formatSubtitles(stream.subtitles, key, origin, stream.headers, false);
    if (directSubs) directRow.subtitles = directSubs;
    rows.push(directRow);

    if (
      rows.length < maxStreams &&
      includeProxy &&
      origin &&
      shouldEmitProxyRow(stream, reqHeaders)
    ) {
      const proxyHints = { bingeGroup };
      if (stream.type === "mkv") proxyHints.notWebReady = true;

      const proxyRow = {
        name: formatStreamName(provider, true),
        title: formatTitle(stream, { isProxy: true }),
        url: `${origin}${makeProxyUrl(stream.link, stream.headers || {})}`,
        behaviorHints: proxyHints,
      };
      const proxySubs = formatSubtitles(stream.subtitles, key, origin, stream.headers, true);
      if (proxySubs) proxyRow.subtitles = proxySubs;
      rows.push(proxyRow);
    }
  }

  return rows.slice(0, maxStreams);
}
