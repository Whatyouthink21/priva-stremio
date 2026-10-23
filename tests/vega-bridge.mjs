/**
 * Vega VM sandbox & providerContext isolation tests (zero network calls).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createProviderContext, sanitizeCookieHeader } from "../server/providers/context.js";
import { loadVegaProvider, resolveViaVega } from "../server/providers/vega.js";

const check = (name, cond, detail = "") => {
  if (!cond) {
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  } else {
    console.log(`  ok    ${name}`);
  }
};

const FIXTURE_ID = "__test_vega_fixture__";
const FIXTURE_DIR = path.join(process.cwd(), "server", "providers", "vendor", FIXTURE_ID);

await fs.mkdir(FIXTURE_DIR, { recursive: true });
await fs.writeFile(
  path.join(FIXTURE_DIR, "posts.js"),
  `
  exports.getSearchPosts = async function ({ searchQuery }) {
    return [{ title: searchQuery + " (1999) 1080p", link: "https://fixture.example/item/matrix" }];
  };
  `,
);
await fs.writeFile(
  path.join(FIXTURE_DIR, "meta.js"),
  `
  exports.getMeta = async function () {
    const urlsRes = await fetch("https://raw.githubusercontent.com/Zenda-Cross/vega-providers/refs/heads/main/urls.json");
    const urls = await urlsRes.json();
    if (!urls || typeof urls !== "object") throw new Error("missing urls.json");
    return {
      title: "The Matrix",
      type: "movie",
      linkList: [
        {
          title: "The.Matrix.1999.1080p.BluRay.x265 [6.6 GB]",
          quality: "1080p",
          directLinks: [{ title: "HubCloud [6.6 GB]", link: "https://fixture.example/dl/1" }]
        }
      ]
    };
  };
  `,
);
await fs.writeFile(
  path.join(FIXTURE_DIR, "stream.js"),
  `
  exports.getStream = async function ({ providerContext }) {
    providerContext.commonHeaders["Referer"] = "https://fixture.example/watch";
    return [{ server: "FixtureCDN", link: "https://cdn.fixture.example/master.m3u8", type: "m3u8" }];
  };
  `,
);

try {
  console.log("\n[1] VM sandbox evaluation + offline urls.json resolution");
  const mod = await loadVegaProvider(FIXTURE_ID);
  check("loads vendored CJS bundle modules into single provider object", typeof mod.getStream === "function" && typeof mod.getMeta === "function");

  const pcA = createProviderContext(FIXTURE_ID);
  const pcB = createProviderContext(FIXTURE_ID);
  check("commonHeaders are shallow-cloned per call so mutations never leak across requests", pcA.commonHeaders !== pcB.commonHeaders);

  const res = await resolveViaVega({
    providerId: FIXTURE_ID,
    tmdbId: "603",
    imdbId: "tt0133093",
    type: "movie",
    title: "The Matrix",
    year: 1999,
    providerContext: pcA,
  });

  check("resolveViaVega completes search -> meta -> stream chain offline", res.streams.length === 1);
  check(
    "propagates quality=1080, size=6.6 GB, BluRay/HEVC detail, and Referer header",
    res.streams[0].quality === "1080" &&
      res.streams[0].size === "6.6 GB" &&
      res.streams[0].detail.includes("BluRay") &&
      res.streams[0].headers?.referer === "https://fixture.example/watch",
    JSON.stringify(res.streams[0]),
  );

  console.log("\n[2] Stale cf_clearance cookie sanitizer");
  const staleTs = Math.floor(Date.now() / 1000) - 7200;
  const cleaned = sanitizeCookieHeader(`session=abc; cf_clearance=xyz-${staleTs}-0-1; lang=en`);
  check("strips expired cf_clearance cookie while keeping valid cookies", cleaned === "session=abc; lang=en", cleaned);
} finally {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
}
