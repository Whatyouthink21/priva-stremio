/**
 * Core Stremio addon contract test suite (100% offline).
 *
 * Covers:
 *   - Default & configured /manifest.json + CORS + OPTIONS preflight
 *   - Stremio ID parsing (movie, series, season 0 specials, bare series ID, unknown ID)
 *   - Stateless config encode/decode round-trip + unknown keys + 400 on bad base64/JSON
 *   - Stream row formatting (direct + proxy, headers, bingeGroup, MKV notWebReady, name <= 14, cap)
 *   - Deduplication (duplicate upstream links + re-signed /p/<token> links)
 *   - Ranking (hls -> mp4 -> dash -> mkv, descending quality)
 *   - Signed proxy (/p/<token> HTTP 206 Range bytes=0-1023, HLS playlist rewrite, bad token -> 403)
 *   - /health JSON + ok / slow / cooling status states
 */

process.env.VEGA_ENABLED = "false";
process.env.PROXY_ALLOW_HOSTS = "127.0.0.1";
process.env.RESOLVE_GRACE_MS = "120";
process.env.LOG_LEVEL = "error";

import http from "node:http";

const check = (name, cond, detail = "") => {
  if (!cond) {
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  } else {
    console.log(`  ok    ${name}`);
  }
};

/* ---------- Local mock Cinemeta + byte-range upstream server ---------- */

const UPSTREAM_BYTES = Buffer.alloc(8192);
for (let i = 0; i < UPSTREAM_BYTES.length; i++) UPSTREAM_BYTES[i] = i % 251;

let lastUpstreamHeaders = {};

const fixtureServer = http.createServer((req, res) => {
  lastUpstreamHeaders = req.headers;
  const u = new URL(req.url, "http://127.0.0.1");

  if (u.pathname === "/meta/movie/tt0133093.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        meta: {
          id: "tt0133093",
          moviedb_id: 603,
          name: "The Matrix",
          year: "1999",
        },
      }),
    );
  }

  if (u.pathname === "/meta/series/tt0944947.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        meta: {
          id: "tt0944947",
          moviedb_id: 1399,
          name: "Game of Thrones",
          year: "2011–2019",
        },
      }),
    );
  }

  if (u.pathname.startsWith("/meta/")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ meta: null }));
  }

  if (u.pathname === "/video/sample.mp4") {
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), UPSTREAM_BYTES.length - 1) : UPSTREAM_BYTES.length - 1;
        const slice = UPSTREAM_BYTES.subarray(start, end + 1);
        res.writeHead(206, {
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${end}/${UPSTREAM_BYTES.length}`,
          "Content-Length": slice.length,
        });
        return res.end(slice);
      }
    }
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Length": UPSTREAM_BYTES.length,
    });
    return res.end(UPSTREAM_BYTES);
  }

  if (u.pathname === "/hls/master.m3u8") {
    const playlist = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      '#EXT-X-KEY:METHOD=AES-128,URI="enc.key"',
      "#EXTINF:4.000,",
      "seg-000.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    return res.end(playlist);
  }

  res.writeHead(404);
  return res.end("not found");
});

await new Promise((r) => fixtureServer.listen(0, "127.0.0.1", r));
const fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;
process.env.CINEMETA_BASE = fixtureOrigin;

/* ---------- Import app modules after env setup ---------- */

const { app } = await import("../server/index.js");
const { parseStremioId, clearMetadataCache } = await import("../server/lib/metadata.js");
const {
  encodeAddonConfig,
  decodeAddonConfig,
  ADDON_ID,
} = await import("../server/lib/addonConfig.js");
const {
  streamKey,
  dedupeStreams,
  toStremioStreams,
  formatStreamName,
} = await import("../server/lib/streams.js");
const { makeProxyUrl } = await import("../server/routes/proxy.js");
const { sign, verify } = await import("../server/lib/token.js");
const { health } = await import("../server/lib/health.js");
const {
  registerProvider,
  unregisterProvider,
  clearResolveCache,
} = await import("../server/providers/registry.js");

let lastSeriesCall = null;

registerProvider({
  id: "castle",
  label: "castle",
  displayName: "Castle TV",
  resolve: async ({ type, season, episode, title, tmdbId }) => {
    if (type === "series") lastSeriesCall = { season, episode, title, tmdbId };
    return {
      meta: { title, year: 1999 },
      streams: [
        {
          server: "Castle S1",
          link: `${fixtureOrigin}/hls/master.m3u8`,
          type: "hls",
          quality: "1080",
          headers: { Referer: "https://castle.example/", "User-Agent": "CastleTest/1.0" },
          subtitles: [
            { title: "English", language: "en", type: "text/vtt", uri: `${fixtureOrigin}/subs/en.vtt` },
          ],
        },
        {
          server: "Castle MP4",
          link: `${fixtureOrigin}/video/sample.mp4`,
          type: "mp4",
          quality: "720",
          headers: { Referer: "https://castle.example/" },
        },
      ],
    };
  },
});

registerProvider({
  id: "4khdhub",
  label: "4khdhub",
  displayName: "4KHDHub",
  resolve: async ({ title }) => ({
    meta: { title },
    streams: [
      {
        server: "PixelServer",
        link: `${fixtureOrigin}/files/matrix-2160p.mkv`,
        type: "mkv",
        quality: "2160",
        size: "14.2 GB",
        detail: "BluRay · DV · HEVC",
        headers: { Referer: "https://hubcloud.example/" },
      },
      // Intentional duplicate of castle's HLS URL to test cross-provider dedupe:
      {
        server: "DuplicateMirror",
        link: `${fixtureOrigin}/hls/master.m3u8`,
        type: "hls",
        quality: "1080",
      },
    ],
  }),
});

const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  /* ---------------- 1. Manifest + CORS ---------------- */
  console.log("\n[1] Manifest & CORS");
  const optRes = await fetch(`${base}/manifest.json`, { method: "OPTIONS" });
  check("OPTIONS /manifest.json returns 204", optRes.status === 204);
  check(
    "OPTIONS sets Access-Control-Allow-Origin: *",
    optRes.headers.get("access-control-allow-origin") === "*",
  );

  const manRes = await fetch(`${base}/manifest.json`);
  const man = await manRes.json();
  check("GET /manifest.json returns 200", manRes.status === 200);
  check("manifest CORS header is *", manRes.headers.get("access-control-allow-origin") === "*");
  check("manifest id matches community.priva.streams", man.id === ADDON_ID);
  check("manifest version is 1.0.0", man.version === "1.0.0");
  check("manifest name defaults to Priva", man.name === "Priva");
  check(
    "manifest types are movie + series",
    JSON.stringify(man.types) === JSON.stringify(["movie", "series"]),
  );
  check(
    "manifest resources is stream-only",
    JSON.stringify(man.resources) === JSON.stringify(["stream"]),
  );
  check("manifest idPrefixes is ['tt']", JSON.stringify(man.idPrefixes) === JSON.stringify(["tt"]));
  check("manifest catalogs is empty array", Array.isArray(man.catalogs) && man.catalogs.length === 0);
  check(
    "manifest behaviorHints marks addon configurable without mandatory config",
    man.behaviorHints?.configurable === true && man.behaviorHints?.configurationRequired === false,
  );

  /* ---------------- 2. Stateless Config Codec & 400 Handling ---------------- */
  console.log("\n[2] Config round-trip & malformed config handling");
  const customCfg = {
    n: "Priva Home TV",
    p: ["castle"],
    b: { castle: 7 },
    mk: false,
    px: true,
    max: 14,
  };
  const encoded = encodeAddonConfig(customCfg);
  const decoded = decodeAddonConfig(encoded);
  check("config round-trip preserves name", decoded.n === "Priva Home TV");
  check("config round-trip preserves provider subset", JSON.stringify(decoded.p) === '["castle"]');
  check("config round-trip preserves per-provider budget", decoded.b.castle === 7);
  check("config round-trip preserves mk=false", decoded.mk === false);
  check("config round-trip preserves px=true", decoded.px === true);
  check("config round-trip preserves max=14", decoded.max === 14);

  const withUnknownKeys = Buffer.from(
    JSON.stringify({ ...customCfg, futureFlag: true, unknownNested: { a: 1 }, n: "TwentyPlusCharactersNameHere" }),
  ).toString("base64url");
  const tolerant = decodeAddonConfig(withUnknownKeys);
  check("unknown keys in config are ignored cleanly", tolerant.futureFlag === undefined);
  check("addon name is clamped to <= 18 chars", tolerant.n.length === 18);

  const scopedManRes = await fetch(`${base}/${encoded}/manifest.json`);
  const scopedMan = await scopedManRes.json();
  check("GET /:config/manifest.json applies custom name", scopedMan.name === "Priva Home TV");
  check(
    "GET /:config/manifest.json narrows description to castle",
    scopedMan.description === "Sources from castle",
  );

  const badTokens = [
    "%%%not-valid-base64%%%",
    Buffer.from("{broken-json", "utf8").toString("base64url"),
    Buffer.from("[1,2,3]", "utf8").toString("base64url"),
  ];
  for (const bad of badTokens) {
    const r1 = await fetch(`${base}/${encodeURIComponent(bad)}/manifest.json`);
    const body1 = await r1.text();
    check(
      `bad config "${bad.slice(0, 12)}…" on manifest returns HTTP 400 without stack trace`,
      r1.status === 400 && !/\bat\s+\S+\s*\(/.test(body1),
      `status=${r1.status} body=${body1.slice(0, 80)}`,
    );
  }
  const rBadCfgPage = await fetch(`${base}/configure?config=%%%bad%%%`);
  check("GET /configure?config=bad returns HTTP 400", rBadCfgPage.status === 400);

  /* ---------------- 3. ID Parsing & Series Specials (Season 0) ---------------- */
  console.log("\n[3] Stremio ID parsing & HTTP 200 guarantees");
  const pMovie = parseStremioId("movie", "tt0133093");
  check("parses movie tt0133093", pMovie.ok && pMovie.imdbId === "tt0133093");

  const pSeries = parseStremioId("series", "tt0944947:1:1");
  check(
    "parses series tt0944947:1:1",
    pSeries.ok && pSeries.imdbId === "tt0944947" && pSeries.season === 1 && pSeries.episode === 1,
  );

  const pSpecial = parseStremioId("series", "tt0944947:0:1");
  check(
    "parses season 0 special tt0944947:0:1 with season === 0",
    pSpecial.ok && pSpecial.season === 0 && pSpecial.episode === 1,
  );

  const pBareSeries = parseStremioId("series", "tt0944947");
  check("rejects bare tt... ID on series", pBareSeries.ok === false);

  const bareSeriesHttp = await fetch(`${base}/stream/series/tt0944947.json`);
  const bareSeriesJson = await bareSeriesHttp.json();
  check(
    "GET /stream/series/tt0944947.json returns HTTP 200 { streams: [] } (never 404)",
    bareSeriesHttp.status === 200 && Array.isArray(bareSeriesJson.streams) && bareSeriesJson.streams.length === 0,
  );

  const unknownHttp = await fetch(`${base}/stream/movie/tt99999999.json`);
  const unknownJson = await unknownHttp.json();
  check(
    "unknown IMDb ID returns HTTP 200 { streams: [] }",
    unknownHttp.status === 200 && Array.isArray(unknownJson.streams) && unknownJson.streams.length === 0,
  );

  clearResolveCache();
  const specialHttp = await fetch(`${base}/stream/series/tt0944947:0:1.json`);
  const specialJson = await specialHttp.json();
  check(
    "season 0 special passes season=0, episode=1, and Cinemeta tmdbId into provider",
    specialHttp.status === 200 &&
      specialJson.streams.length > 0 &&
      lastSeriesCall?.season === 0 &&
      lastSeriesCall?.episode === 1 &&
      lastSeriesCall?.tmdbId === "1399",
    JSON.stringify(lastSeriesCall),
  );

  /* ---------------- 4. Stream Row Formatting, Ranking, Dedupe ---------------- */
  console.log("\n[4] Stream row formatting, ranking, deduplication & caps");
  clearResolveCache();
  const fullCfg = encodeAddonConfig({
    n: "Priva",
    p: ["castle", "4khdhub"],
    mk: true,
    px: true,
    max: 20,
  });
  const streamRes = await fetch(`${base}/${fullCfg}/stream/movie/tt0133093.json`);
  const streamBody = await streamRes.json();
  check("GET /:config/stream/movie/tt0133093.json returns 200", streamRes.status === 200);
  check(
    "response body has pure Stremio shape { streams } only",
    JSON.stringify(Object.keys(streamBody)) === '["streams"]',
  );
  check("X-Priva-Stats header carries timing diagnostics", Boolean(streamRes.headers.get("x-priva-stats")));

  const rows = streamBody.streams;
  // 3 unique streams (HLS 1080p, MP4 720p, MKV 2160p) * (direct + proxy) = 6 rows (duplicate HLS merged!)
  check("cross-provider duplicate HLS URL merged cleanly (6 total rows: 3 direct + 3 proxy)", rows.length === 6, `got ${rows.length}`);

  check(
    "ranking places HLS first, MP4 second, MKV after MP4",
    rows[0].title.includes("HLS") && rows[2].title.includes("MP4") && rows[4].title.includes("MKV"),
    rows.map((r) => r.title.split("\n")[0]).join(" | "),
  );

  const directHls = rows[0];
  const proxyHls = rows[1];
  check(
    "direct row carries upstream URL + proxyHeaders.request + bingeGroup",
    directHls.url === `${fixtureOrigin}/hls/master.m3u8` &&
      directHls.behaviorHints?.proxyHeaders?.request?.Referer === "https://castle.example/" &&
      directHls.behaviorHints?.bingeGroup === "priva-castle",
  );
  check(
    "direct row carries subtitles array",
    Array.isArray(directHls.subtitles) && directHls.subtitles[0]?.lang === "en",
  );
  check(
    "proxy row URL points to /p/<token> on current host",
    proxyHls.url.startsWith(`${base}/p/`),
    proxyHls.url,
  );

  const mkvDirect = rows[4];
  check(
    "MKV row carries notWebReady: true + size + BluRay/DV/HEVC tags",
    mkvDirect.behaviorHints?.notWebReady === true &&
      mkvDirect.title.includes("14.2 GB") &&
      mkvDirect.title.includes("BluRay"),
    mkvDirect.title,
  );

  const allProviderNames = ["castle", "4khdhub", "autoEmbed", "movieBoxWeb", "kissKh", "superLongProviderId"];
  check(
    "all direct & proxy stream names stay <= 14 characters",
    allProviderNames.every(
      (id) => formatStreamName(id, false).length <= 14 && formatStreamName(id, true).length <= 14,
    ),
  );

  // Filter MKV off + Proxy off:
  const webSafeCfg = encodeAddonConfig({
    p: ["castle", "4khdhub"],
    mk: false,
    px: false,
    max: 20,
  });
  const webRes = await fetch(`${base}/${webSafeCfg}/stream/movie/tt0133093.json`);
  const webRows = (await webRes.json()).streams;
  check(
    "mk=false & px=false drops MKV and /p/ rows leaving 2 direct web-friendly rows",
    webRows.length === 2 &&
      webRows.every((r) => !r.title.includes("MKV") && !r.url.includes("/p/")),
  );

  // Re-signed /p/<token> deduplication:
  const signedA = { url: `${base}${makeProxyUrl("https://cdn.example/video.m3u8", { referer: "https://a/" }, 600)}` };
  const signedB = { url: `${base}${makeProxyUrl("https://cdn.example/video.m3u8", { referer: "https://b/" }, 3600)}` };
  check(
    "re-signed /p/<token> URLs for the same target share streamKey and dedupe to 1",
    streamKey(signedA) === streamKey(signedB) && dedupeStreams([signedA, signedB]).length === 1,
  );

  // Ranking order across all 4 container types:
  const fourKindRows = toStremioStreams(
    [
      { provider: "p", link: "https://ex.com/a.mkv", type: "mkv", quality: "2160", proxy: false },
      { provider: "p", link: "https://ex.com/b.mpd", type: "dash", quality: "1080", proxy: false },
      { provider: "p", link: "https://ex.com/c-720.mp4", type: "mp4", quality: "720", proxy: false },
      { provider: "p", link: "https://ex.com/c-1080.mp4", type: "mp4", quality: "1080", proxy: false },
      { provider: "p", link: "https://ex.com/d.m3u8", type: "hls", quality: "720", proxy: false },
    ],
    { origin: base, includeProxy: false, includeMkv: true, maxStreams: 10 },
  );
  check(
    "full rank order is HLS -> MP4 1080p -> MP4 720p -> DASH -> MKV",
    JSON.stringify(fourKindRows.map((r) => r.url)) ===
      JSON.stringify([
        "https://ex.com/d.m3u8",
        "https://ex.com/c-1080.mp4",
        "https://ex.com/c-720.mp4",
        "https://ex.com/b.mpd",
        "https://ex.com/a.mkv",
      ]),
  );

  /* ---------------- 5. Signed Proxy (/p/<token>) Range 206 & HLS ---------------- */
  console.log("\n[5] Signed stream proxy (/p/<token>)");
  const mp4ProxyRow = rows.find((r) => r.url.includes("/p/") && r.title.includes("MP4"));
  const rangeRes = await fetch(mp4ProxyRow.url, {
    headers: { Range: "bytes=0-1023" },
  });
  const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
  check("GET /p/<token> with Range: bytes=0-1023 returns 206 Partial Content", rangeRes.status === 206);
  check(
    "206 response preserves Content-Range: bytes 0-1023/8192",
    rangeRes.headers.get("content-range") === `bytes 0-1023/${UPSTREAM_BYTES.length}`,
    rangeRes.headers.get("content-range"),
  );
  check(
    "206 response byte payload matches upstream slice 0..1023",
    rangeBuf.length === 1024 && rangeBuf.equals(UPSTREAM_BYTES.subarray(0, 1024)),
  );
  check(
    "proxy injected signed Referer header to upstream",
    lastUpstreamHeaders.referer === "https://castle.example/",
  );

  const rewrittenRes = await fetch(proxyHls.url);
  const rewrittenM3u8 = await rewrittenRes.text();
  check(
    "proxied HLS master playlist rewrites key + segment URIs to /p/<token>",
    rewrittenRes.status === 200 &&
      rewrittenM3u8.includes('URI="/p/') &&
      /\n\/p\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(rewrittenM3u8),
  );

  const expiredToken = sign({ u: `${fixtureOrigin}/video/sample.mp4`, h: {} }, -10);
  check("verify() rejects expired tokens", verify(expiredToken) === null);
  const badProxyRes = await fetch(`${base}/p/${expiredToken}`);
  check("GET /p/<expired> returns HTTP 403", badProxyRes.status === 403);

  /* ---------------- 6. /health Ledger States ---------------- */
  console.log("\n[6] /health JSON & provider state transitions");
  health.recordSuccess("castle", 180, 2);
  health.recordSuccess("4khdhub", 6200, 1);
  for (let i = 0; i < 5; i++) health.recordFailure("deadSource", new Error("503"), 900);

  check("fast source health status is ok", health.status("castle") === "ok");
  check("slow source (>=5s) health status is slow", health.status("4khdhub") === "slow");
  check("5x failing source enters cooling status", health.status("deadSource") === "cooling");

  const healthRes = await fetch(`${base}/health`);
  const healthJson = await healthRes.json();
  check("GET /health returns 200 with ok=true and providers list", healthRes.status === 200 && healthJson.ok === true && Array.isArray(healthJson.providers));
} finally {
  unregisterProvider("castle");
  unregisterProvider("4khdhub");
  clearMetadataCache();
  clearResolveCache();
  await new Promise((r) => server.close(r));
  await new Promise((r) => fixtureServer.close(r));
}
