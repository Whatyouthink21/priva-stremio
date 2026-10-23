#!/usr/bin/env node
/**
 * Vendor Vega provider bundles into server/providers/vendor/<id>/.
 *
 * Order of preference:
 *   1. Sibling ../priva-embed/server/providers/vendor/<id>/ if present
 *   2. jsDelivr CDN: https://cdn.jsdelivr.net/gh/Zenda-Cross/vega-providers@main/dist/<id>/
 *   3. GitHub tarball archive fallback (codeload.github.com, pure Node gunzip + tar reader)
 *   4. Existing vendored copy on disk if completely offline (unless --force)
 *
 * Usage:
 *   npm run vendor
 *   node scripts/vendor.mjs castle 4khdhub autoEmbed movieBoxWeb kissKh
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const DEFAULT_PROVIDERS = ["castle", "4khdhub", "autoEmbed", "movieBoxWeb"];
const MODULES = ["catalog", "posts", "meta", "episodes", "stream", "settings"];

/** Providers that cannot work headless or are marked disabled: true upstream. */
export const BLOCKED_PROVIDERS = new Map([
  ["everything", "injects a Cloudflare Turnstile widget and waits for a ReactNativeWebView token — impossible server-side"],
  ["mxplayer", "requires live browser cookies"],
  ["multi", "disabled: true in upstream manifest.json"],
  ["protonMovies", "disabled: true in upstream manifest.json"],
  ["cinemaLuxe", "disabled: true in upstream manifest.json"],
  ["filmyfly", "disabled: true in upstream manifest.json"],
  ["movieBox", "disabled: true in upstream manifest.json (use movieBoxWeb)"],
  ["mkvDrama", "disabled: true in upstream manifest.json"],
  ["katMovieFix", "disabled: true in upstream manifest.json"],
  ["ringz", "disabled: true in upstream manifest.json"],
  ["ogomovies", "disabled: true in upstream manifest.json"],
  ["a111477", "disabled: true in upstream manifest.json"],
  ["vadapav", "disabled: true in upstream manifest.json"],
  ["moviesApi", "disabled: true in upstream manifest.json"],
  ["ridoMovies", "disabled: true in upstream manifest.json"],
  ["flixhq", "disabled: true in upstream manifest.json"],
  ["primewire", "disabled: true in upstream manifest.json"],
  ["hiAnime", "disabled: true in upstream manifest.json"],
  ["animetsu", "disabled: true in upstream manifest.json"],
  ["tokyoInsider", "disabled: true in upstream manifest.json"],
  ["dooflix", "disabled: true in upstream manifest.json"],
  ["guardahd", "disabled: true in upstream manifest.json"],
  ["skyMovieHD", "disabled: true in upstream manifest.json"],
  ["Joya9tv", "disabled: true in upstream manifest.json"],
  ["uniquestream", "disabled: true in upstream manifest.json"],
  ["cinefreak", "disabled: true in upstream manifest.json"],
]);

const CDN_BASE =
  process.env.VEGA_CDN_BASE ||
  "https://cdn.jsdelivr.net/gh/Zenda-Cross/vega-providers@main/dist";
const URLS_CDN =
  "https://cdn.jsdelivr.net/gh/Zenda-Cross/vega-providers@main/urls.json";
const CODELOAD_TARBALL =
  "https://codeload.github.com/Zenda-Cross/vega-providers/tar.gz/refs/heads/main";

const ROOT = process.cwd();
const VENDOR_DIR = path.join(ROOT, "server", "providers", "vendor");
const SIBLING_VENDOR_DIR = path.resolve(
  ROOT,
  process.env.PRIVA_EMBED_DIR || "../priva-embed",
  "server",
  "providers",
  "vendor",
);

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "priva-stremio-vendor/1.0",
      Accept: "*/*",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, text: await res.text() };
}

async function copyFromDir(srcDir, destDir) {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  const jsFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".js")).map((e) => e.name);
  if (!jsFiles.includes("stream.js")) return null;
  await fs.mkdir(destDir, { recursive: true });
  for (const name of jsFiles) {
    await fs.copyFile(path.join(srcDir, name), path.join(destDir, name));
  }
  return jsFiles.sort();
}

async function downloadFromJsDelivr(id, destDir) {
  const fetched = new Map();
  let networkReachable = false;

  for (const mod of MODULES) {
    try {
      const r = await fetchText(`${CDN_BASE}/${id}/${mod}.js`);
      networkReachable = true;
      if (r.ok && r.text) fetched.set(`${mod}.js`, r.text);
    } catch {
      /* unreachable or timed out */
    }
  }

  if (!networkReachable || !fetched.has("stream.js")) return null;
  await fs.mkdir(destDir, { recursive: true });
  for (const [name, code] of fetched.entries()) {
    await fs.writeFile(path.join(destDir, name), code, "utf8");
  }
  return [...fetched.keys()].sort();
}

/** Lazy-loaded map of relative path -> utf8 content from upstream main tarball. */
let archiveCache = null;
async function loadUpstreamArchive() {
  if (archiveCache) return archiveCache;
  const res = await fetch(CODELOAD_TARBALL, {
    headers: { "User-Agent": "priva-stremio-vendor/1.0" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) return null;
  const raw = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
  const files = new Map();

  let offset = 0;
  let paxPath = null;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) break;

    const sizeOct = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeOct || "0", 8) || 0;
    const typeFlag = String.fromCharCode(header[156] || 48);
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const baseName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const body = raw.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (typeFlag === "x") {
      const m = body.toString("utf8").match(/\d+ path=([^\n]+)\n/);
      if (m) paxPath = m[1];
      continue;
    }

    const fullName = paxPath || (prefix ? `${prefix}/${baseName}` : baseName);
    paxPath = null;
    if (typeFlag === "0" || typeFlag === "\0") {
      const slash = fullName.indexOf("/");
      const rel = slash >= 0 ? fullName.slice(slash + 1) : fullName;
      if (rel === "urls.json" || (rel.startsWith("dist/") && rel.endsWith(".js"))) {
        files.set(rel, body.toString("utf8"));
      }
    }
  }

  archiveCache = files;
  return files;
}

async function downloadFromArchive(id, destDir) {
  const archive = await loadUpstreamArchive().catch(() => null);
  if (!archive) return null;

  const prefix = `dist/${id}/`;
  const matched = [...archive.entries()].filter(([k]) => k.startsWith(prefix));
  const names = matched.map(([k]) => k.slice(prefix.length));
  if (!names.includes("stream.js")) return null;

  await fs.mkdir(destDir, { recursive: true });
  for (const [k, content] of matched) {
    await fs.writeFile(path.join(destDir, k.slice(prefix.length)), content, "utf8");
  }
  return names.sort();
}

async function syncUrlsJson() {
  const dest = path.join(VENDOR_DIR, "urls.json");
  try {
    const r = await fetchText(URLS_CDN);
    if (r.ok && r.text) {
      JSON.parse(r.text);
      await fs.mkdir(VENDOR_DIR, { recursive: true });
      await fs.writeFile(dest, r.text, "utf8");
      return "jsdelivr";
    }
  } catch {}

  try {
    const archive = await loadUpstreamArchive();
    const text = archive?.get("urls.json");
    if (text) {
      JSON.parse(text);
      await fs.mkdir(VENDOR_DIR, { recursive: true });
      await fs.writeFile(dest, text, "utf8");
      return "github-archive";
    }
  } catch {}

  return existsSync(dest) ? "disk" : null;
}

export async function vendorProviders(ids = DEFAULT_PROVIDERS, { force = false } = {}) {
  for (const id of ids) {
    if (BLOCKED_PROVIDERS.has(id)) {
      throw new Error(`refusing to vendor "${id}": ${BLOCKED_PROVIDERS.get(id)}`);
    }
  }

  await fs.mkdir(VENDOR_DIR, { recursive: true });
  const results = [];

  for (const id of ids) {
    const destDir = path.join(VENDOR_DIR, id);
    const siblingDir = path.join(SIBLING_VENDOR_DIR, id);

    if (existsSync(siblingDir)) {
      const copied = await copyFromDir(siblingDir, destDir);
      if (copied) {
        results.push({ id, source: "sibling ../priva-embed", files: copied });
        continue;
      }
    }

    if (!force && existsSync(path.join(destDir, "stream.js"))) {
      const fromCdn = await downloadFromJsDelivr(id, destDir).catch(() => null);
      if (fromCdn) {
        results.push({ id, source: "jsdelivr", files: fromCdn });
        continue;
      }
      const existing = (await fs.readdir(destDir)).filter((f) => f.endsWith(".js")).sort();
      results.push({ id, source: "vendored (offline)", files: existing });
      continue;
    }

    const fromCdn = await downloadFromJsDelivr(id, destDir).catch(() => null);
    if (fromCdn) {
      results.push({ id, source: "jsdelivr", files: fromCdn });
      continue;
    }

    const fromArchive = await downloadFromArchive(id, destDir).catch(() => null);
    if (fromArchive) {
      results.push({ id, source: "github-archive", files: fromArchive });
      continue;
    }

    throw new Error(`could not vendor "${id}" from sibling checkout, jsDelivr, or GitHub archive`);
  }

  const urlsSource = await syncUrlsJson();
  return { results, urlsSource };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const ids = args.filter((a) => !a.startsWith("-"));
  vendorProviders(ids.length ? ids : DEFAULT_PROVIDERS, { force })
    .then(({ results, urlsSource }) => {
      for (const r of results) {
        console.log(`  ✓ ${r.id.padEnd(14)} ${r.source.padEnd(24)} [${r.files.join(", ")}]`);
      }
      if (urlsSource) console.log(`  ✓ ${"urls.json".padEnd(14)} ${urlsSource}`);
    })
    .catch((err) => {
      console.error(`vendor failed: ${err.message}`);
      process.exit(1);
    });
}
