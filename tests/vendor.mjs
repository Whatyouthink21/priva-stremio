/**
 * Vendor sanity checks for vendored Vega providers (100% offline).
 *
 * Verifies:
 *   - All expected core providers (castle, 4khdhub, autoEmbed, movieBoxWeb, and kissKh if present)
 *     load cleanly inside node:vm and export getStream as a function
 *   - Vendor urls.json exists, is valid JSON, and contains dynamic base URLs (never hardcoded in server/)
 *   - Blocked providers ("everything", "mxplayer", disabled upstream providers) are rejected
 *     by both scripts/vendor.mjs and loadVegaProvider()
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadVegaProvider } from "../server/providers/vega.js";
import { vendorProviders, BLOCKED_PROVIDERS } from "../scripts/vendor.mjs";

const check = (name, cond, detail = "") => {
  if (!cond) {
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  } else {
    console.log(`  ok    ${name}`);
  }
};

const REQUIRED_CORE = ["castle", "4khdhub", "autoEmbed", "movieBoxWeb"];
const OPTIONAL_EXTRA = ["kissKh"];
const VENDOR_DIR = path.join(process.cwd(), "server", "providers", "vendor");

console.log("\n[1] Vendored Vega provider bundles load in node:vm");
for (const id of [...REQUIRED_CORE, ...OPTIONAL_EXTRA]) {
  const dir = path.join(VENDOR_DIR, id);
  if (!REQUIRED_CORE.includes(id) && !existsSync(dir)) continue;

  const mod = await loadVegaProvider(id);
  check(
    `provider "${id}" loads cleanly and exports getStream()`,
    Boolean(mod) && typeof mod.getStream === "function",
  );
  if (id !== "autoEmbed") {
    check(
      `provider "${id}" exports search + metadata functions`,
      typeof mod.getSearchPosts === "function" && typeof mod.getMeta === "function",
    );
  }
}

console.log("\n[2] Dynamic urls.json present & zero hardcoded mirror domains in server/");
const urlsRaw = await fs.readFile(path.join(VENDOR_DIR, "urls.json"), "utf8");
const urlsJson = JSON.parse(urlsRaw);
check(
  "vendor/urls.json parses and has entries for 4khdhub + kissKh",
  Boolean(urlsJson["4khdhub"]?.url && urlsJson.kissKh?.url),
);

const serverFiles = [
  "server/config.js",
  "server/index.js",
  "server/providers/vega.js",
  "server/providers/registry.js",
  "server/providers/context.js",
  "server/routes/addon.js",
  "server/routes/proxy.js",
];
for (const rel of serverFiles) {
  const src = await fs.readFile(path.join(process.cwd(), rel), "utf8");
  check(
    `${rel} contains zero hardcoded mirror domains from urls.json`,
    !src.includes(urlsJson["4khdhub"].url) && !src.includes(urlsJson.kissKh.url),
  );
}

console.log("\n[3] Blocked providers refused cleanly");
for (const bad of ["everything", "mxplayer", "multi", "movieBox"]) {
  check(`BLOCKED_PROVIDERS includes "${bad}"`, BLOCKED_PROVIDERS.has(bad));

  let rejectedVendor = false;
  try {
    await vendorProviders([bad]);
  } catch {
    rejectedVendor = true;
  }
  check(`vendorProviders() refuses "${bad}"`, rejectedVendor);

  let rejectedLoad = false;
  try {
    await loadVegaProvider(bad);
  } catch {
    rejectedLoad = true;
  }
  check(`loadVegaProvider() refuses "${bad}"`, rejectedLoad);
}
