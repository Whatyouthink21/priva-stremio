/**
 * Provider contract — server-side port of `providers/types.ts` from
 * Zenda-Cross/vega-providers.
 */

export const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
};

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const gb = n / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 1 : 1)} GB`;
  const mb = n / (1024 * 1024);
  return `${Math.round(mb)} MB`;
}

export function extractSizeLabel(rawSize, fallbackText = "") {
  if (typeof rawSize === "number" && rawSize > 0) return formatBytes(rawSize);
  if (typeof rawSize === "string" && rawSize.trim()) {
    const clean = rawSize.trim();
    if (/^\d+$/.test(clean)) return formatBytes(Number(clean));
    const m = /(\d+(?:\.\d+)?)\s*(GB|GiB|MB|MiB|TB)/i.exec(clean);
    if (m) return `${m[1]} ${m[2].toUpperCase().replace("IB", "B")}`;
    return clean;
  }
  const m = /\b(\d+(?:\.\d+)?)\s*(GB|GiB|MB|MiB)\b/i.exec(String(fallbackText || ""));
  if (m) return `${m[1]} ${m[2].toUpperCase().replace("IB", "B")}`;
  return undefined;
}

export function extractReleaseDetail(text = "") {
  const s = String(text || "");
  if (!s) return undefined;
  const tags = [];
  if (/\bremux\b/i.test(s)) tags.push("Remux");
  else if (/\bblu[\s._-]*ray\b|\bbrrip\b|\bbdrip\b/i.test(s)) tags.push("BluRay");
  else if (/\bweb[\s._-]*dl\b/i.test(s)) tags.push("WEB-DL");
  else if (/\bweb[\s._-]*rip\b/i.test(s)) tags.push("WEBRip");
  else if (/\bhdrip\b/i.test(s)) tags.push("HDRip");

  if (/\bdovi\b|\bdolby[\s._-]*vision\b/i.test(s)) tags.push("DV");
  else if (/\bhdr10\+?\b|\bhdr\b/i.test(s)) tags.push("HDR");

  if (/\bhevc\b|\bx265\b|\bh\.?265\b/i.test(s)) tags.push("HEVC");
  if (/\batmos\b/i.test(s)) tags.push("Atmos");
  if (/\bdual[\s._-]*audio\b/i.test(s)) tags.push("Dual Audio");

  return tags.length ? tags.join(" · ") : undefined;
}

/**
 * Normalise whatever a provider returned into the internal Stream shape:
 *   type -> "hls" | "dash" | "mp4" | "mkv"
 *
 * @param {object} raw
 * @param {string} providerId
 */
export function normalizeStream(raw, providerId) {
  if (!raw || typeof raw.link !== "string" || !raw.link) return null;
  const link = raw.link.trim();
  if (!link) return null;

  const declared = String(raw.type || "").toLowerCase();
  const lower = link.toLowerCase().split("?")[0];

  let type;
  if (declared.includes("dash") || declared.includes("mpd") || lower.endsWith(".mpd")) {
    type = "dash";
  } else if (
    declared.includes("hls") ||
    declared.includes("m3u8") ||
    lower.endsWith(".m3u8") ||
    lower.includes(".m3u8")
  ) {
    type = "hls";
  } else if (declared.includes("mkv") || lower.endsWith(".mkv")) {
    type = "mkv";
  } else if (declared.includes("mp4") || lower.endsWith(".mp4")) {
    type = "mp4";
  } else if (link.includes("/hls/") || link.includes("playlist")) {
    type = "hls";
  } else {
    type = "mp4";
  }

  const subs = Array.isArray(raw.subtitles)
    ? raw.subtitles
        .filter((s) => s && typeof s.uri === "string")
        .map((s) => ({
          title: String(s.title || s.language || "Subtitle"),
          language: String(s.language || "und").slice(0, 12).toLowerCase(),
          type: String(s.type || "text/vtt"),
          uri: s.uri,
        }))
    : [];

  let quality = raw.quality ? String(raw.quality).replace(/[^\d]/g, "") : "";
  if (!quality) {
    const qMatch = /(?:^|[\s._[\](-])(2160|1440|1080|720|576|540|480|360)p?(?=$|[\s._[\])-])/i.exec(
      `${raw.title || ""} ${raw.server || ""} ${lower}`,
    );
    if (qMatch) quality = qMatch[1];
  }

  const size = extractSizeLabel(raw.size, raw.title || raw.server || "");
  const detail =
    raw.detail || extractReleaseDetail(raw.title || "") || undefined;

  return {
    server: String(raw.server || providerId),
    link,
    type,
    quality: quality || undefined,
    size,
    detail,
    subtitles: subs,
    headers: raw.headers && typeof raw.headers === "object" ? raw.headers : undefined,
    skip: Array.isArray(raw.skip) ? raw.skip : undefined,
    corsOk: raw.corsOk === true ? true : undefined,
    proxy: raw.proxy === false ? false : raw.proxy === true ? true : undefined,
  };
}
