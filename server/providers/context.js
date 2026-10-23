/**
 * Builds a live `providerContext` for a provider — the object Vega injects
 * into its sandbox, implemented for real on a server.
 */

import axios from "axios";
import * as cheerio from "cheerio";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_HEADERS } from "./types.js";

const DATA_DIR = path.join(process.cwd(), "data");
const JAR_DIR = path.join(DATA_DIR, "cookies");
const KV_DIR = path.join(DATA_DIR, "kv");

for (const dir of [JAR_DIR, KV_DIR]) fs.mkdirSync(dir, { recursive: true });

/* ------------------------------------------------------------------ */
/* Cookie jar                                                          */
/* ------------------------------------------------------------------ */

class CookieJar {
  constructor(file) {
    this.file = file;
    try {
      this.data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      this.data = {};
    }
  }

  #save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch {
      /* read-only fs — keep in memory only */
    }
  }

  setFromResponse(url, setCookie) {
    if (!setCookie) return;
    let host;
    try {
      host = new URL(url).host;
    } catch {
      return;
    }
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const raw of list) {
      const [pair] = String(raw).split(";");
      const idx = pair.indexOf("=");
      if (idx < 1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!name) continue;
      (this.data[host] ||= {})[name] = value;
    }
    this.#save();
  }

  header(url) {
    let host;
    try {
      host = new URL(url).host;
    } catch {
      return "";
    }
    const jar = this.data[host];
    if (!jar || !Object.keys(jar).length) return "";
    return Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  map(url) {
    try {
      return { ...(this.data[new URL(url).host] || {}) };
    } catch {
      return {};
    }
  }

  clear() {
    this.data = {};
    this.#save();
  }
}

const jars = new Map();
export function jarFor(id) {
  if (!jars.has(id)) jars.set(id, new CookieJar(path.join(JAR_DIR, `${id}.json`)));
  return jars.get(id);
}

/* ------------------------------------------------------------------ */
/* kvStore (file backed)                                               */
/* ------------------------------------------------------------------ */

function fileKvStore(providerId) {
  const file = path.join(KV_DIR, `${providerId}.json`);
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return {};
    }
  };
  const write = (obj) => {
    try {
      fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    } catch {
      /* ignore */
    }
  };
  return {
    async get(key) {
      return read()[key];
    },
    async set(key, value) {
      const data = read();
      data[key] = value;
      write(data);
    },
    async delete(key) {
      const data = read();
      const had = key in data;
      delete data[key];
      write(data);
      return had;
    },
    async keys() {
      return Object.keys(read());
    },
    async clear() {
      write({});
    },
  };
}

/* ------------------------------------------------------------------ */
/* stale Cloudflare cookies                                            */
/* ------------------------------------------------------------------ */

const CF_CLEARANCE_MAX_AGE_S = 45 * 60;

function isStaleCookie(name, value, nowMs) {
  if (name !== "cf_clearance") return false;
  const m = /-(\d{9,11})-/.exec(value);
  if (!m) return false;
  const issuedMs = Number(m[1]) * 1000;
  return nowMs - issuedMs > CF_CLEARANCE_MAX_AGE_S * 1000;
}

export function sanitizeCookieHeader(header, nowMs = Date.now()) {
  if (!header) return header;
  const pairs = String(header)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const kept = [];
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx < 1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (isStaleCookie(name, value, nowMs)) continue;
    kept.push(pair);
  }
  return kept.join("; ");
}

/* ------------------------------------------------------------------ */
/* axios with retry + cookie jar                                       */
/* ------------------------------------------------------------------ */

function makeClient(providerId, jar) {
  const client = axios.create({
    timeout: 20_000,
    maxRedirects: 6,
    validateStatus: (s) => s >= 200 && s < 400,
    headers: { ...DEFAULT_HEADERS },
  });

  client.interceptors.request.use((cfg) => {
    const cookie = jar.header(cfg.url || "");
    if (cookie) {
      cfg.headers = { ...cfg.headers, Cookie: cookie };
    }
    if (cfg.headers?.Cookie) {
      const clean = sanitizeCookieHeader(cfg.headers.Cookie);
      if (clean) cfg.headers.Cookie = clean;
      else delete cfg.headers.Cookie;
    }
    if (!cfg.headers?.Referer && cfg.url) {
      try {
        cfg.headers.Referer = new URL(cfg.url).origin + "/";
      } catch {
        /* ignore */
      }
    }
    return cfg;
  });

  client.interceptors.response.use((res) => {
    jar.setFromResponse(res.config.url, res.headers["set-cookie"]);
    return res;
  });

  const rawGet = client.get.bind(client);
  client.get = async (url, cfg = {}) => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await rawGet(url, cfg);
      } catch (err) {
        lastErr = err;
        const status = err?.response?.status;
        if (status && status < 500 && status !== 429) break;
        if (cfg?.signal?.aborted) break;
        await sleep(180 * (attempt + 1) + Math.random() * 120);
      }
    }
    throw lastErr;
  };

  return client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* openWebView (headless)                                              */
/* ------------------------------------------------------------------ */

const CHALLENGE_RE =
  /cf-chl|challenge-platform|Just a moment\.\.\.|cf_chl_opt|Enable JavaScript and cookies|Checking your browser|Attention Required|cf-error-details/i;

function looksLikeChallenge(html) {
  return typeof html === "string" && html.length < 120_000 && CHALLENGE_RE.test(html);
}

function blockedError(providerId, url, code, detail) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep raw string */
  }
  const err = new Error(
    code === "WAF_CHALLENGE"
      ? `WAF challenge on ${host} (headless mode cannot solve it)`
      : `${host} refused the request (${detail}) — the link needs a cookie or session this server does not have`,
  );
  err.code = code;
  err.provider = providerId;
  return err;
}

function makeOpenWebView(providerId, client, jar) {
  return async function openWebView(url, options = {}) {
    const started = Date.now();
    const request = {
      timeout: options.timeoutMs ? Math.min(options.timeoutMs, 20_000) : 20_000,
      headers: {
        ...DEFAULT_HEADERS,
        ...(options.headers || {}),
        Accept: "text/html,application/xhtml+xml",
      },
      responseType: "text",
    };

    let res;
    try {
      res = await client.get(url, request);
    } catch (err) {
      const status = err?.response?.status;
      const body = err?.response?.data;
      const text = typeof body === "string" ? body : "";
      if (status === 403 || status === 503) {
        throw blockedError(
          providerId,
          url,
          looksLikeChallenge(text) ? "WAF_CHALLENGE" : "WAF_BLOCKED",
          `HTTP ${status}${text ? "" : ", empty body"}`,
        );
      }
      if (status && looksLikeChallenge(text)) {
        throw blockedError(providerId, url, "WAF_CHALLENGE", `HTTP ${status}`);
      }
      throw err;
    }

    const html = typeof res.data === "string" ? res.data : String(res.data);
    if (looksLikeChallenge(html)) {
      throw blockedError(providerId, url, "WAF_CHALLENGE", "HTTP 200 challenge page");
    }

    return {
      data: html,
      cookies: jar.header(url),
      cookieMap: jar.map(url),
      userAgent: DEFAULT_HEADERS["User-Agent"],
      url,
      elapsedMs: Date.now() - started,
    };
  };
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

const contextCache = new Map();

export function createProviderContext(providerId) {
  const cleanId = String(providerId || "").replace(/^vega:/, "");
  let base = contextCache.get(cleanId);
  if (!base) {
    const jar = jarFor(cleanId);
    const client = makeClient(cleanId, jar);
    base = {
      axios: client,
      cheerio,
      commonHeaders: { ...DEFAULT_HEADERS },
      kvStore: fileKvStore(cleanId),
      openWebView: makeOpenWebView(cleanId, client, jar),
      getCookies: async (url) => jar.map(url),
    };
    contextCache.set(cleanId, base);
  }
  return { ...base, commonHeaders: { ...base.commonHeaders } };
}

export { CookieJar };
