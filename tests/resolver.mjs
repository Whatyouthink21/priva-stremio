/**
 * Resolver timeout, partial response, exception isolation, and background
 * cache completion tests (zero network calls).
 *
 * Explicit scenario:
 *   - Provider A answers in 50ms
 *   - Provider B NEVER answers (hung promise)
 *   - Provider C throws immediately
 *   - Provider D finishes in 320ms (after grace window, upgrading the cache)
 */

process.env.VEGA_ENABLED = "false";
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

let unhandled = null;
process.on("unhandledRejection", (reason) => {
  unhandled = reason;
});

const cinemeta = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      meta: { id: "tt1375666", moviedb_id: 27205, name: "Inception", year: "2010" },
    }),
  );
});
await new Promise((r) => cinemeta.listen(0, "127.0.0.1", r));
process.env.CINEMETA_BASE = `http://127.0.0.1:${cinemeta.address().port}`;

const { app } = await import("../server/index.js");
const { encodeAddonConfig } = await import("../server/lib/addonConfig.js");
const {
  registerProvider,
  unregisterProvider,
  clearResolveCache,
} = await import("../server/providers/registry.js");

let neverTimer = null;

registerProvider({
  id: "fastA",
  label: "fastA",
  resolve: async () => {
    await new Promise((r) => setTimeout(r, 50));
    return {
      streams: [
        { server: "fastA", link: "https://cdn.example/fast-a.m3u8", type: "hls", quality: "1080" },
      ],
    };
  },
});

registerProvider({
  id: "hungB",
  label: "hungB",
  resolve: async ({ signal }) =>
    new Promise((resolve) => {
      // Never resolves on its own; clears cleanly only if aborted so Node exits cleanly.
      neverTimer = setTimeout(resolve, 60_000);
      neverTimer.unref?.();
      signal?.addEventListener("abort", () => clearTimeout(neverTimer), { once: true });
    }),
});

registerProvider({
  id: "throwingC",
  label: "throwingC",
  resolve: async () => {
    throw new Error("simulated extractor crash");
  },
});

registerProvider({
  id: "stragglerD",
  label: "stragglerD",
  resolve: async () => {
    await new Promise((r) => setTimeout(r, 340));
    return {
      streams: [
        { server: "stragglerD", link: "https://cdn.example/straggler-d.mp4", type: "mp4", quality: "1080" },
      ],
    };
  },
});

const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  console.log("\n[1] 50ms provider + hung provider + throwing provider");
  clearResolveCache();
  const cfgABC = encodeAddonConfig({
    p: ["fastA", "hungB", "throwingC"],
    b: { fastA: 4, hungB: 4, throwingC: 4 },
    px: false,
    mk: true,
    max: 20,
  });

  const t0 = Date.now();
  const res1 = await fetch(`${base}/${cfgABC}/stream/movie/tt1375666.json`);
  const elapsed1 = Date.now() - t0;
  const body1 = await res1.json();
  const stats1 = JSON.parse(res1.headers.get("x-priva-stats"));

  check("HTTP 200 returned without waiting for 4000ms hungB budget", res1.status === 200 && elapsed1 < 900, `${elapsed1}ms`);
  check("fastA stream is returned immediately", body1.streams.length === 1 && body1.streams[0].url === "https://cdn.example/fast-a.m3u8");
  check("response marks partial=true while hungB is pending", stats1.partial === true);
  check("zero unhandled rejections from throwingC or hungB", unhandled === null);

  console.log("\n[2] Background straggler upgrades cache on reload");
  clearResolveCache();
  const cfgAD = encodeAddonConfig({
    p: ["fastA", "stragglerD"],
    b: { fastA: 4, stragglerD: 4 },
    px: false,
    mk: true,
    max: 20,
  });

  const first = await fetch(`${base}/${cfgAD}/stream/movie/tt1375666.json`);
  const firstJson = await first.json();
  check("first request returns fastA before stragglerD finishes", firstJson.streams.length === 1);

  // Wait for stragglerD (340ms) to finish in background and upgrade cache:
  await new Promise((r) => setTimeout(r, 320));

  const tReload = Date.now();
  const second = await fetch(`${base}/${cfgAD}/stream/movie/tt1375666.json`);
  const reloadMs = Date.now() - tReload;
  const secondJson = await second.json();
  const stats2 = JSON.parse(second.headers.get("x-priva-stats"));

  check(
    "reload returns both fastA + stragglerD streams from upgraded cache",
    secondJson.streams.length === 2 &&
      secondJson.streams.some((s) => s.url.includes("straggler-d.mp4")),
    JSON.stringify(secondJson.streams.map((s) => s.url)),
  );
  check("reload cache hit is instant (< 80ms) and complete (partial=false)", reloadMs < 80 && stats2.partial === false, `${reloadMs}ms`);
} finally {
  clearTimeout(neverTimer);
  for (const id of ["fastA", "hungB", "throwingC", "stragglerD"]) unregisterProvider(id);
  clearResolveCache();
  await new Promise((r) => server.close(r));
  await new Promise((r) => cinemeta.close(r));
}
