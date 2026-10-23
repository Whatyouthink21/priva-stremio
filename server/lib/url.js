import { config } from "../config.js";

/**
 * Public base origin for proxy links and Stremio manifest URLs.
 *
 * Precedence:
 *   1. Explicit PUBLIC_BASE_URL env var (e.g. Cloudflare Tunnel or custom domain)
 *   2. Reverse-proxy forwarded headers (x-forwarded-proto / x-forwarded-host on Render)
 *   3. Request Host header when present, otherwise config.publicBaseUrl (http://127.0.0.1:$PORT)
 */
export function originOf(req) {
  const envBase = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (envBase) return envBase;

  if (req?.headers) {
    const fwdHost = req.headers["x-forwarded-host"];
    const hostHeader = (fwdHost || req.headers.host || "").toString().split(",")[0].trim();
    if (hostHeader) {
      const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http")
        .toString()
        .split(",")[0]
        .trim();
      return `${proto}://${hostHeader}`;
    }
  }

  return config.publicBaseUrl;
}

export function isSameOrigin(req, url) {
  try {
    return new URL(url, originOf(req)).host === new URL(originOf(req)).host;
  } catch {
    return false;
  }
}
