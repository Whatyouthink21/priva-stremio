/**
 * Stateless URL configuration codec + Stremio manifest builder.
 *
 * URL config payload uses compact keys encoded as base64url JSON:
 *   { n, p, b, mk, px, max }
 *
 *   n   — addon name (<= 18 chars, default "Priva")
 *   p   — enabled provider ids (e.g. ["castle","4khdhub","autoEmbed","movieBoxWeb"])
 *   b   — per-provider budget in seconds (4..15)
 *   mk  — include MKV streams (boolean, default true)
 *   px  — include /p/<token> proxy rows (boolean, default true)
 *   max — max streams returned (10..30, default 20)
 */

import { config } from "../config.js";
import { BLOCKED_PROVIDERS } from "../../scripts/vendor.mjs";

export const ADDON_ID = "community.priva.streams";
export const ADDON_VERSION = "1.0.0";
export const DEFAULT_NAME = "Priva";
export const MAX_NAME_LEN = 18;
export const MIN_BUDGET_SEC = 4;
export const MAX_BUDGET_SEC = 15;
export const MIN_STREAMS = 10;
export const MAX_STREAMS = 30;
export const DEFAULT_MAX_STREAMS = 20;

export const DEFAULT_BUDGETS_SEC = {
  castle: 6,
  autoEmbed: 10,
  movieBoxWeb: 10,
  kissKh: 10,
  "4khdhub": 15,
};

export class BadConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "BadConfigError";
    this.status = 400;
  }
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function defaultBudgetsSec() {
  const out = { ...DEFAULT_BUDGETS_SEC };
  for (const [id, ms] of Object.entries(config.vega.timeouts || {})) {
    const sec = Math.round(Number(ms) / 1000);
    if (Number.isFinite(sec) && sec > 0) {
      out[id] = clamp(sec, MIN_BUDGET_SEC, MAX_BUDGET_SEC);
    }
  }
  return out;
}

export function defaultAddonConfig(availableProviders) {
  const baseList =
    Array.isArray(availableProviders) && availableProviders.length
      ? availableProviders
      : config.vega.sources;
  const providers = baseList.filter((id) => id && !BLOCKED_PROVIDERS.has(id));
  const budgets = {};
  const defaults = defaultBudgetsSec();
  for (const id of providers) {
    budgets[id] = defaults[id] ?? 8;
  }
  return {
    n: DEFAULT_NAME,
    p: providers,
    b: budgets,
    mk: true,
    px: true,
    max: DEFAULT_MAX_STREAMS,
  };
}

/**
 * Normalize an untrusted config object, ignoring unknown keys.
 */
export function normalizeAddonConfig(raw, availableProviders) {
  const base = defaultAddonConfig(availableProviders);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;

  const name =
    typeof raw.n === "string" && raw.n.trim()
      ? raw.n.trim().slice(0, MAX_NAME_LEN)
      : base.n;

  let providers = base.p;
  if (Array.isArray(raw.p)) {
    const cleaned = [];
    for (const item of raw.p) {
      const id = String(item || "").trim();
      if (!id || BLOCKED_PROVIDERS.has(id) || cleaned.includes(id)) continue;
      cleaned.push(id);
    }
    providers = cleaned;
  }

  const defaults = defaultBudgetsSec();
  const budgets = {};
  for (const id of providers) {
    budgets[id] = defaults[id] ?? 8;
  }

  if (typeof raw.b === "number" && Number.isFinite(raw.b)) {
    const v = raw.b >= 100 ? Math.round(raw.b / 1000) : Math.round(raw.b);
    for (const id of providers) budgets[id] = clamp(v, MIN_BUDGET_SEC, MAX_BUDGET_SEC);
  } else if (raw.b && typeof raw.b === "object" && !Array.isArray(raw.b)) {
    for (const [k, val] of Object.entries(raw.b)) {
      const id = String(k || "").trim();
      if (!id || BLOCKED_PROVIDERS.has(id)) continue;
      const num = Number(val);
      if (!Number.isFinite(num)) continue;
      const sec = num >= 100 ? Math.round(num / 1000) : Math.round(num);
      budgets[id] = clamp(sec, MIN_BUDGET_SEC, MAX_BUDGET_SEC);
    }
  }

  const mk = raw.mk === undefined ? base.mk : Boolean(raw.mk);
  const px = raw.px === undefined ? base.px : Boolean(raw.px);
  const maxNum = Number(raw.max);
  const max = Number.isFinite(maxNum)
    ? clamp(Math.round(maxNum), MIN_STREAMS, MAX_STREAMS)
    : base.max;

  return { n: name, p: providers, b: budgets, mk, px, max };
}

export function encodeAddonConfig(cfg, availableProviders) {
  const norm = normalizeAddonConfig(cfg, availableProviders);
  return Buffer.from(JSON.stringify(norm), "utf8").toString("base64url");
}

/**
 * Strictly validate base64url + UTF-8 JSON object; unknown keys ignored.
 * Throws BadConfigError (HTTP 400) on malformed input.
 */
export function decodeAddonConfig(encoded, availableProviders) {
  if (typeof encoded !== "string" || !encoded.trim()) {
    throw new BadConfigError("Invalid config parameter: empty configuration token.");
  }

  const clean = encoded.trim();
  if (clean.length > 4096 || !/^[A-Za-z0-9_-]+={0,2}$/.test(clean)) {
    throw new BadConfigError(
      "Invalid config parameter: expected a base64url-encoded JSON object.",
    );
  }

  let text;
  try {
    const bytes = Buffer.from(clean, "base64url");
    if (!bytes.length) throw new Error("empty");
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BadConfigError(
      "Invalid config parameter: malformed base64url encoding.",
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadConfigError(
      "Invalid config parameter: decoded payload is not valid JSON.",
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BadConfigError(
      "Invalid config parameter: configuration payload must be a JSON object.",
    );
  }

  return normalizeAddonConfig(parsed, availableProviders);
}

export function timeoutsMsFromConfig(cfg) {
  const out = {};
  for (const [id, sec] of Object.entries(cfg?.b || {})) {
    const n = Number(sec);
    if (Number.isFinite(n) && n > 0) out[id] = Math.round(n * 1000);
  }
  return out;
}

function formatProviderList(list) {
  if (!list || !list.length) return "no active sources";
  if (list.length === 1) return `Sources from ${list[0]}`;
  return `Sources from ${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

export function buildManifest(cfg) {
  const norm = cfg ? normalizeAddonConfig(cfg) : defaultAddonConfig();
  return {
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: norm.n,
    description: formatProviderList(norm.p),
    types: ["movie", "series"],
    resources: ["stream"],
    idPrefixes: ["tt"],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  };
}
