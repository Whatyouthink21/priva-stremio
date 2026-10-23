import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Support running `node server/index.js` directly as well as `node --env-file-if-exists=.env`.
const envPath = path.join(process.cwd(), ".env");
if (fs.existsSync(envPath)) {
  try {
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      } else {
        val = val.replace(/\s+#.*$/, "").trim();
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* ignore unreadable .env */
  }
}

const bool = (v, d = false) =>
  v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(String(v).trim());

const DEFAULT_TIMEOUTS = {
  castle: 6_000,
  autoEmbed: 8_000,
  movieBoxWeb: 8_000,
  kissKh: 8_000,
  "4khdhub": 10_000,
};

const parsedTimeouts = Object.fromEntries(
  (process.env.VEGA_TIMEOUTS || "")
    .split(",")
    .map((pair) => pair.split("=").map((x) => x.trim()))
    .filter(([id, ms]) => id && Number(ms) > 0)
    .map(([id, ms]) => [id, Number(ms)]),
);

const port = Number(process.env.PORT || 7000);
const rawPublicBase = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
const rawSecret = (process.env.TOKEN_SECRET || "").trim();

export const config = {
  port,
  host: process.env.HOST || "0.0.0.0",
  nodeEnv: process.env.NODE_ENV || "development",
  publicBaseUrl: rawPublicBase || `http://127.0.0.1:${port}`,
  hasExplicitPublicBaseUrl: Boolean(rawPublicBase),

  /** 64-hex HMAC secret for /p/<token> links; ephemeral secret generated if unset. */
  tokenSecret: rawSecret || crypto.randomBytes(32).toString("hex"),
  tokenSecretIsEphemeral: !rawSecret,

  tokenTtlSec: Number(process.env.TOKEN_TTL || 43_200),
  resolveTtlSec: Number(process.env.RESOLVE_TTL || 600),
  resolvePartialTtlSec: Number(process.env.RESOLVE_PARTIAL_TTL || 60),
  resolveGraceMs:
    process.env.RESOLVE_GRACE_MS !== undefined && process.env.RESOLVE_GRACE_MS !== ""
      ? Number(process.env.RESOLVE_GRACE_MS)
      : 1_000,
  providerTimeoutMs: Number(process.env.PROVIDER_TIMEOUT_MS || 8_000),
  resolveBudgetMs: Number(process.env.RESOLVE_BUDGET_MS || 12_000),

  proxyEnabled: bool(process.env.PROXY_ENABLED, true),
  proxyCacheSegmentsSec: Number(process.env.PROXY_CACHE_SEGMENTS || 300),

  vega: {
    enabled: bool(process.env.VEGA_ENABLED, true),
    base:
      process.env.VEGA_CDN_BASE ||
      "https://cdn.jsdelivr.net/gh/Zenda-Cross/vega-providers@main/dist",
    sources: (process.env.VEGA_SOURCES || "castle,4khdhub,autoEmbed,movieBoxWeb")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    linkConcurrency: Number(process.env.VEGA_LINK_CONCURRENCY || 3),
    timeouts: { ...DEFAULT_TIMEOUTS, ...parsedTimeouts },
  },

  tmdbKey: (process.env.TMDB_API_KEY || "").trim(),
};

export const warnings = [];
if (config.tokenSecretIsEphemeral) {
  warnings.push(
    `TOKEN_SECRET is empty — generated ephemeral 64-hex secret (${config.tokenSecret.slice(0, 8)}…). ` +
      "Set TOKEN_SECRET in .env so /p/<token> proxy links survive restarts.",
  );
}
