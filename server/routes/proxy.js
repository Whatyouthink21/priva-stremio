/**
 * Signed stream proxy (`/p/<token>`).
 *
 * Forwards `Range` and exposes `206 Partial Content` + `Content-Range` for native
 * Stremio seeking, rewrites HLS master/media playlists + AES keys to `/p/<token>`,
 * guards against private-network SSRF, and enforces per-IP rate limiting.
 */

import { Router } from "express";
import { sign, verify } from "../lib/token.js";
import { assertPublicUrl } from "../lib/guard.js";
import { logger } from "../lib/log.js";
import { config } from "../config.js";

const log = logger("proxy");
export const proxyRouter = Router();

const FORWARD_REQUEST_HEADERS = [
  "referer",
  "origin",
  "user-agent",
  "cookie",
  "authorization",
  "accept-language",
];

/* ------------------------------------------------------------------ */
/* Rate limiting (per IP, per minute)                                  */
/* ------------------------------------------------------------------ */

const buckets = new Map();
const RATE = { windowMs: 60_000, max: Number(process.env.PROXY_RATE_PER_MIN || 1200) };

function rateLimited(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || b.reset < now) {
    b = { count: 0, reset: now + RATE.windowMs };
    buckets.set(ip, b);
  }
  b.count += 1;
  return b.count > RATE.max;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (b.reset < now) buckets.delete(ip);
}, 60_000).unref?.();

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

export function makeProxyUrl(url, headers = {}, ttlSec) {
  const clean = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!v) continue;
    const key = k.toLowerCase();
    if (!FORWARD_REQUEST_HEADERS.includes(key) && !key.startsWith("x-")) continue;
    if (/[\r\n]/.test(String(v))) continue;
    clean[key] = String(v);
  }
  return `/p/${sign({ u: url, h: clean }, ttlSec)}`;
}

export function proxyUrlFor(origin, url, headers) {
  return `${origin}${makeProxyUrl(url, headers)}`;
}

/* ------------------------------------------------------------------ */
/* HLS rewriting                                                       */
/* ------------------------------------------------------------------ */

const URI_ATTR = /URI="([^"]*)"/i;

function contentTypeFor(url, upstreamType) {
  const pathname = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (pathname.endsWith(".m3u8") || /mpegurl/i.test(upstreamType || "")) {
    return "application/vnd.apple.mpegurl";
  }
  if (pathname.endsWith(".ts")) return "video/mp2t";
  if (pathname.endsWith(".mkv")) return "video/x-matroska";
  if (pathname.endsWith(".m4s") || pathname.endsWith(".mp4") || pathname.endsWith(".m4v")) {
    return "video/mp4";
  }
  if (pathname.endsWith(".vtt")) return "text/vtt";
  if (pathname.endsWith(".srt")) return "application/x-subrip";
  if (pathname.endsWith(".mpd")) return "application/dash+xml";
  if (pathname.endsWith(".aac")) return "audio/aac";
  if (pathname.endsWith(".key") || pathname.endsWith(".bin")) return "application/octet-stream";
  return upstreamType || "application/octet-stream";
}

export function rewritePlaylist(body, playlistUrl, headers, origin = "") {
  let basePlaylist;
  try {
    basePlaylist = new URL(playlistUrl);
  } catch {
    return body;
  }

  const resolveRef = (ref) => {
    const trimmed = String(ref || "").trim();
    if (!trimmed || trimmed.startsWith("data:")) return trimmed;
    try {
      return new URL(trimmed, basePlaylist).toString();
    } catch {
      return trimmed;
    }
  };

  const wrap = (ref) => {
    const abs = resolveRef(ref);
    if (!/^https?:/i.test(abs)) return ref;
    const rel = makeProxyUrl(abs, headers);
    return origin ? `${origin}${rel}` : rel;
  };

  const out = [];
  const lines = String(body).split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      out.push(line);
      continue;
    }

    if (trimmed.startsWith("#")) {
      const upper = trimmed.toUpperCase();
      if (
        upper.startsWith("#EXT-X-KEY") ||
        upper.startsWith("#EXT-X-SESSION-KEY") ||
        upper.startsWith("#EXT-X-MAP") ||
        upper.startsWith("#EXT-X-MEDIA:") ||
        upper.startsWith("#EXT-X-I-FRAME-STREAM-INF") ||
        upper.startsWith("#EXT-X-PART:") ||
        upper.startsWith("#EXT-X-PRELOAD-HINT") ||
        upper.startsWith("#EXT-X-RENDITION-REPORT") ||
        upper.startsWith("#EXT-X-SESSION-DATA")
      ) {
        out.push(line.replace(URI_ATTR, (_, uri) => `URI="${wrap(uri)}"`));
        continue;
      }
      out.push(line);
      continue;
    }

    out.push(wrap(trimmed));
  }

  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* Upstream fetch + streaming passthrough                              */
/* ------------------------------------------------------------------ */

async function* readChunks(reader, firstChunk, fallbackBody) {
  if (reader) {
    if (firstChunk && firstChunk.length) yield Buffer.from(firstChunk);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) yield Buffer.from(value);
    }
    return;
  }
  if (fallbackBody) {
    for await (const chunk of fallbackBody) yield chunk;
  }
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

export function classifyFetchError(err, targetUrl) {
  const cause = err?.cause || {};
  const code = String(cause.code || err?.code || "").toUpperCase();
  const message = String(cause.message || err?.message || "");

  let kind = "network";
  if (/ENOTFOUND|EAI_AGAIN|DNS/.test(code) || /getaddrinfo|dns/i.test(message)) kind = "dns";
  else if (/ECONNREFUSED/.test(code)) kind = "refused";
  else if (
    /ECONNRESET|EPIPE|ECONNABORTED|UND_ERR_SOCKET|SOCKET/.test(code) ||
    /ECONNRESET|socket hang up/i.test(message)
  ) {
    kind = "reset";
  } else if (
    /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code) ||
    /certificate|ssl|tls/i.test(message)
  ) {
    kind = "tls";
  } else if (/ETIMEDOUT|TIMEOUT|ABORT_ERR/.test(code) || /timed? ?out/i.test(message)) {
    kind = "timeout";
  }

  let host = "";
  try {
    host = new URL(targetUrl).host;
  } catch {}

  return {
    kind,
    code: code || null,
    host,
    detail: code && message ? `${code}: ${message}` : message || String(err?.message || "fetch failed"),
  };
}

const RETRYABLE = new Set(["reset", "timeout", "network"]);

export async function fetchUpstream(targetUrl, forward, { method, signal }) {
  const attempt = (hdrs) =>
    fetch(targetUrl, {
      method,
      headers: hdrs,
      redirect: "follow",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });

  const started = Date.now();
  try {
    return { upstream: await attempt(forward), retried: false, elapsed: Date.now() - started };
  } catch (err) {
    const info = classifyFetchError(err, targetUrl);
    if (!RETRYABLE.has(info.kind) || signal.aborted) {
      throw Object.assign(err, { privaInfo: info });
    }

    const browserish = { ...forward };
    if (!browserish["user-agent"] && !browserish["User-Agent"]) {
      browserish["user-agent"] = BROWSER_UA;
    }
    if (!browserish["accept"] && !browserish["Accept"]) browserish.accept = "*/*";
    if (!browserish["accept-language"] && !browserish["Accept-Language"]) {
      browserish["accept-language"] = "en-US,en;q=0.9";
    }
    if (!browserish["accept-encoding"] && !browserish["Accept-Encoding"]) {
      browserish["accept-encoding"] = "identity";
    }

    await new Promise((r) => setTimeout(r, 250));
    try {
      return {
        upstream: await attempt(browserish),
        retried: true,
        elapsed: Date.now() - started,
        firstError: info,
      };
    } catch (err2) {
      throw Object.assign(err2, {
        privaInfo: classifyFetchError(err2, targetUrl),
        firstError: info,
        retried: true,
      });
    }
  }
}

async function pipeUpstream({ targetUrl, headers, req, res }) {
  const selfHost = (req.headers["x-forwarded-host"] || req.headers.host || "")
    .toString()
    .split(",")[0]
    .trim();
  const extraAllowed = (process.env.PROXY_ALLOW_HOSTS || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  await assertPublicUrl(targetUrl, { allowHosts: [selfHost, ...extraAllowed] });

  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.on("close", onClose);

  const forward = {
    ...headers,
    ...(req.headers.range ? { range: req.headers.range } : {}),
  };

  let upstream;
  try {
    const out = await fetchUpstream(targetUrl, forward, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      signal: controller.signal,
    });
    upstream = out.upstream;
    if (out.retried) log.warn(`upstream recovered on retry: ${targetUrl}`);
  } catch (err) {
    res.off("close", onClose);
    if (!res.headersSent) {
      const info = err.privaInfo || classifyFetchError(err, targetUrl);
      log.warn(`upstream failed (${info.kind}) ${info.host}: ${info.detail}`);
      res.status(502).json({
        error: "upstream fetch failed",
        kind: info.kind,
        code: info.code,
        host: info.host,
        detail: info.detail,
        retried: Boolean(err.retried),
      });
    }
    return;
  }

  const ctype = upstream.headers.get("content-type") || "";
  const declaredHls = /mpegurl/i.test(ctype) || /\.m3u8(\?|$)/i.test(targetUrl);

  let firstChunk = null;
  let sniffIsHls = false;
  if (upstream.ok && upstream.body && !declaredHls && upstream.status !== 206) {
    const reader = upstream.body.getReader();
    const { value } = await reader.read();
    firstChunk = value || new Uint8Array();
    const head = Buffer.from(firstChunk.slice(0, 64)).toString("latin1");
    sniffIsHls = head.trimStart().startsWith("#EXTM3U");
    upstream.__reader = reader;
  }

  const isPlaylist = upstream.ok && (declaredHls || sniffIsHls);

  res.status(upstream.status);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");

  if (isPlaylist) {
    let text;
    if (firstChunk) {
      const parts = [firstChunk];
      const reader = upstream.__reader;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(Buffer.from(value));
      }
      text = Buffer.concat(parts).toString("utf8");
    } else {
      text = await upstream.text();
    }
    const rewritten = rewritePlaylist(text, targetUrl, headers);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Length", Buffer.byteLength(rewritten));
    res.end(rewritten);
    res.off("close", onClose);
    return;
  }

  for (const h of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  res.setHeader("Content-Type", contentTypeFor(targetUrl, ctype));
  res.setHeader("Cache-Control", `public, max-age=${config.proxyCacheSegmentsSec}, immutable`);

  if (req.method === "HEAD" || !upstream.body) {
    res.end();
    res.off("close", onClose);
    return;
  }

  try {
    for await (const chunk of readChunks(upstream.__reader, firstChunk, upstream.body)) {
      if (!res.write(chunk)) {
        await new Promise((r) => res.once("drain", r));
      }
      if (controller.signal.aborted) break;
    }
    res.end();
  } catch (err) {
    log.debug(`stream aborted: ${err.message}`);
    res.destroy();
  } finally {
    res.off("close", onClose);
  }
}

proxyRouter.get("/p/:token", async (req, res) => {
  if (!config.proxyEnabled) return res.status(503).json({ error: "proxy disabled" });

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (rateLimited(ip)) return res.status(429).json({ error: "rate limited" });

  const payload = verify(req.params.token);
  if (!payload) return res.status(403).json({ error: "invalid or expired token" });

  try {
    await pipeUpstream({
      targetUrl: payload.u,
      headers: payload.h || {},
      req,
      res,
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(err.status || 500).json({ error: err.message, code: err.code });
    }
  }
});

proxyRouter.options("/p/:token", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  res.sendStatus(204);
});
