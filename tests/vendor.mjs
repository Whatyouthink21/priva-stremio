/**
 * Vendor sanity & offline provider execution checks across all 5 Vega providers.
 *
 * Verifies:
 *   - All 5 enabled Vega providers (castle, 4khdhub, autoEmbed, movieBoxWeb, kissKh)
 *     load cleanly inside node:vm and export getStream as a function
 *   - Real vendored kissKh bundle executes its full search -> meta -> keyGenerator -> stream + subtitle
 *     pipeline completely offline against mocked API responses using live urls.json base URL
 *   - Vendor urls.json exists, is valid JSON, and zero mirror domains are hardcoded in server/
 *   - Blocked providers ("everything", "mxplayer", disabled upstream providers) are rejected
 */

import fs from "node:fs/promises";
import path from "node:path";
import { loadVegaProvider, resolveViaVega } from "../server/providers/vega.js";
import { createProviderContext } from "../server/providers/context.js";
import { vendorProviders, BLOCKED_PROVIDERS } from "../scripts/vendor.mjs";

const check = (name, cond, detail = "") => {
  if (!cond) {
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  } else {
    console.log(`  ok    ${name}`);
  }
};

const REQUIRED_PROVIDERS = ["castle", "4khdhub", "autoEmbed", "movieBoxWeb", "kissKh"];
const VENDOR_DIR = path.join(process.cwd(), "server", "providers", "vendor");

console.log("\n[1] Vendored Vega provider bundles load in node:vm");
for (const id of REQUIRED_PROVIDERS) {
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

console.log("\n[3] Real vendored kissKh bundle runs search -> meta -> keyGenerator -> stream offline");
const kissRequests = [];
const mockPc = {
  ...createProviderContext("kissKh"),
  axios: {
    get: async (url) => {
      kissRequests.push(url);
      if (url.includes("/api/DramaList/Search")) {
        return {
          data: [{ id: 7710, title: "Moving (2023)", thumbnail: "https://img.example/moving.jpg" }],
        };
      }
      if (url.includes("/api/DramaList/Drama/7710")) {
        return {
          data: {
            id: 7710,
            title: "Moving",
            description: "Supernatural action series.",
            thumbnail: "https://img.example/moving.jpg",
            episodesCount: 2,
            episodes: [
              { id: 90102, number: 2 },
              { id: 90101, number: 1 },
            ],
          },
        };
      }
      if (url.includes("/api/DramaList/Episode/90101.png")) {
        return {
          data: { Video: "https://hls.kisskh-cdn.example/moving-ep1/master.m3u8" },
        };
      }
      if (url.includes("/api/Sub/90101")) {
        return {
          data: [
            { label: "English", land: "en", src: "https://sub.kisskh-cdn.example/moving-ep1.vtt" },
          ],
        };
      }
      throw new Error(`unexpected kissKh URL: ${url}`);
    },
  },
};

const origFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const u = typeof input === "string" ? input : input?.url || "";
  if (u.includes("urls.json")) {
    return new Response(urlsRaw, { status: 200, headers: { "Content-Type": "application/json" } });
  }
  throw new Error(`unexpected external fetch during offline test: ${u}`);
};

try {
  const kissOut = await resolveViaVega({
    providerId: "kissKh",
    tmdbId: "65930",
    imdbId: "tt24640580",
    type: "series",
    season: 1,
    episode: 1,
    title: "Moving",
    year: 2023,
    providerContext: mockPc,
  });

  check("kissKh resolves HLS stream for episode 1", kissOut.streams.length === 1 && kissOut.streams[0].type === "hls");
  check(
    "kissKh keyGenerator attached signed kkey query param on Episode + Sub API requests",
    kissRequests.some((u) => u.includes("/Episode/90101.png") && /[?&]kkey=[^&]{8,}/.test(u)) &&
      kissRequests.some((u) => u.includes("/api/Sub/90101") && /[?&]kkey=[^&]{8,}/.test(u)),
    JSON.stringify(kissRequests),
  );
  check(
    "kissKh attaches Referer from live urls.json base URL and preserves subtitles",
    kissOut.streams[0].headers?.Referer?.startsWith(urlsJson.kissKh.url) &&
      kissOut.streams[0].subtitles?.[0]?.language === "en",
    JSON.stringify(kissOut.streams[0]),
  );
} finally {
  globalThis.fetch = origFetch;
}

console.log("\n[4] Blocked providers refused cleanly");
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
