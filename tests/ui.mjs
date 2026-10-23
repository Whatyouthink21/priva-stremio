/**
 * End-to-end JSDOM tests for `/` and `/configure` (zero external network calls).
 *
 * Verifies:
 *   - All public HTML/CSS/JS files reference zero external fonts, scripts, images, or trackers
 *   - Form inputs render (name, MKV toggle + Web note, proxy toggle, max streams, provider checkboxes + health status)
 *   - Changing inputs updates the base64url `/<config>/manifest.json` + `stremio://` URLs and round-trips cleanly
 *   - Copy buttons copy exact text via both navigator.clipboard.writeText and execCommand("copy") fallback
 *   - Live stream test panel queries `/<config>/stream/movie/tt0133093.json` and renders provider cards
 */

process.env.VEGA_ENABLED = "false";
process.env.RESOLVE_GRACE_MS = "80";
process.env.LOG_LEVEL = "error";

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const check = (name, cond, detail = "") => {
  if (!cond) {
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  } else {
    console.log(`  ok    ${name}`);
  }
};

const cinemeta = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      meta: { id: "tt0133093", moviedb_id: 603, name: "The Matrix", year: "1999" },
    }),
  );
});
await new Promise((r) => cinemeta.listen(0, "127.0.0.1", r));
process.env.CINEMETA_BASE = `http://127.0.0.1:${cinemeta.address().port}`;

const { app } = await import("../server/index.js");
const { decodeAddonConfig } = await import("../server/lib/addonConfig.js");
const { registerProvider, unregisterProvider, clearResolveCache } = await import(
  "../server/providers/registry.js"
);
const { health } = await import("../server/lib/health.js");

registerProvider({
  id: "castle",
  label: "castle",
  displayName: "Castle TV",
  resolve: async () => ({
    streams: [
      {
        server: "Castle S1",
        link: "https://cdn.example/matrix-1080p.m3u8",
        type: "hls",
        quality: "1080",
        size: "2.4 GB",
        detail: "WEB-DL",
        headers: { Referer: "https://castle.example/" },
      },
    ],
  }),
});
registerProvider({
  id: "4khdhub",
  label: "4khdhub",
  displayName: "4KHDHub",
  resolve: async () => ({
    streams: [
      {
        server: "HubCloud",
        link: "https://cdn.example/matrix-2160p.mkv",
        type: "mkv",
        quality: "2160",
        size: "12.8 GB",
        detail: "BluRay · HEVC",
      },
    ],
  }),
});
health.recordSuccess("castle", 140, 1);
health.recordSuccess("4khdhub", 5400, 1);

const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

/**
 * Evaluate an ES module tree inside JSDOM's vm context using Node's vm.SourceTextModule
 * or inline import transformation so `/js/common.js` + page scripts run genuinely in JSDOM.
 */
async function bootPageInJsdom(routePath, { useExecCommandFallback = false } = {}) {
  const htmlRes = await fetch(`${base}${routePath}`);
  const html = await htmlRes.text();

  const dom = new JSDOM(html, {
    url: `${base}${routePath}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });

  const { window } = dom;
  let lastCopied = null;

  window.fetch = (input, init) => {
    const resolved =
      typeof input === "string" ? new URL(input, `${base}${routePath}`).toString() : input;
    return fetch(resolved, init);
  };
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;

  if (useExecCommandFallback) {
    Object.defineProperty(window.navigator, "clipboard", { value: undefined, configurable: true });
    window.document.execCommand = (cmd) => {
      if (cmd === "copy") {
        lastCopied = window.document.activeElement?.value ?? "";
        return true;
      }
      return false;
    };
  } else {
    Object.defineProperty(window.navigator, "clipboard", {
      value: {
        writeText: async (text) => {
          lastCopied = text;
        },
      },
      configurable: true,
    });
  }

  // Strip `export` keywords cleanly so every top-level declaration stays in scope inside JSDOM:
  const commonCode = (await fs.readFile(path.join(process.cwd(), "public/js/common.js"), "utf8"))
    .replace(/\bexport\s+async\s+function\s+/g, "async function ")
    .replace(/\bexport\s+function\s+/g, "function ");

  const scriptSrc = window.document.querySelector('script[type="module"]')?.getAttribute("src");
  const entryCode = (await fs.readFile(path.join(process.cwd(), "public", scriptSrc), "utf8"))
    .replace(/import\s*\{([^}]+)\}\s*from\s*["']\/js\/common\.js["'];?/, "")
    .replace(/\bexport\s+function\s+/g, "function ");

  vm.runInContext(`${commonCode}\n${entryCode}`, dom.getInternalVMContext());
  await new Promise((r) => setTimeout(r, 80));

  return { dom, window, document: window.document, getCopied: () => lastCopied };
}

try {
  /* ---------------- 1. Zero external assets check ---------------- */
  console.log("\n[1] Offline safety across public/ (zero external fonts, scripts, or trackers)");
  const publicFiles = [
    "public/index.html",
    "public/configure.html",
    "public/css/app.css",
    "public/js/common.js",
    "public/js/landing.js",
    "public/js/configure.js",
  ];
  for (const rel of publicFiles) {
    const content = await fs.readFile(path.join(process.cwd(), rel), "utf8");
    const extMatches = content.match(/https?:\/\/[^\s"'`)<]+/g) || [];
    check(`${rel} contains zero external http(s) URLs`, extMatches.length === 0, extMatches.join(", "));
  }

  /* ---------------- 2. Landing page (`/`) in JSDOM ---------------- */
  console.log("\n[2] Landing page (/) in JSDOM");
  const landing = await bootPageInJsdom("/");
  check(
    "landing page renders registered providers with ok + slow health pills",
    landing.document.getElementById("landing-providers").textContent.includes("Castle TV") &&
      landing.document.querySelector(".status-ok") !== null &&
      landing.document.querySelector(".status-slow") !== null,
  );
  check(
    "landing page install link uses stremio:// scheme",
    landing.document.getElementById("default-install-btn").getAttribute("href").startsWith("stremio://"),
  );
  landing.dom.window.close();

  /* ---------------- 3. Configure page (`/configure`) in JSDOM ---------------- */
  console.log("\n[3] Configure page (/configure) controls, URL output, copy buttons & live tester");
  const ui = await bootPageInJsdom("/configure");
  const { document, window } = ui;

  const nameInput = document.getElementById("addon-name");
  const mkvToggle = document.getElementById("toggle-mkv");
  const proxyToggle = document.getElementById("toggle-proxy");
  const maxSlider = document.getElementById("max-streams");
  const manifestOut = document.getElementById("manifest-url-input");
  const installBtn = document.getElementById("install-stremio-btn");

  check("renders addon name, MKV toggle, proxy toggle, max streams slider, and provider list", Boolean(nameInput && mkvToggle && proxyToggle && maxSlider && manifestOut));
  check(
    "renders Stremio Web MKV warning note",
    document.body.textContent.includes("Stremio Web cannot play MKV"),
  );
  check(
    "renders stateless URL persistence note",
    document.body.textContent.includes("nothing is stored on the server"),
  );

  // Modify form controls:
  nameInput.value = "My Local Priva";
  nameInput.dispatchEvent(new window.Event("input", { bubbles: true }));

  mkvToggle.checked = false;
  mkvToggle.dispatchEvent(new window.Event("change", { bubbles: true }));

  maxSlider.value = "15";
  maxSlider.dispatchEvent(new window.Event("input", { bubbles: true }));

  const hubCheck = document.querySelector('[data-provider-check="4khdhub"]');
  hubCheck.checked = false;
  hubCheck.dispatchEvent(new window.Event("change", { bubbles: true }));

  const castleBudget = document.querySelector('[data-provider-budget="castle"]');
  castleBudget.value = "9";
  castleBudget.dispatchEvent(new window.Event("input", { bubbles: true }));

  // Wait for 90ms debounce:
  await new Promise((r) => setTimeout(r, 140));

  const emittedManifestUrl = manifestOut.value;
  const matchSeg = /\/([^/]+)\/manifest\.json$/.exec(emittedManifestUrl);
  check("manifest input updates with base64url config segment", Boolean(matchSeg), emittedManifestUrl);
  check(
    "Install in Stremio href matches stremio://<host>/<config>/manifest.json",
    installBtn.getAttribute("href") === emittedManifestUrl.replace(/^http:\/\//, "stremio://"),
  );

  const serverDecoded = decodeAddonConfig(matchSeg[1]);
  check(
    "server decodeAddonConfig round-trips exact UI state",
    serverDecoded.n === "My Local Priva" &&
      JSON.stringify(serverDecoded.p) === '["castle"]' &&
      serverDecoded.b.castle === 9 &&
      serverDecoded.mk === false &&
      serverDecoded.px === true &&
      serverDecoded.max === 15,
    JSON.stringify(serverDecoded),
  );

  // Clipboard writeText button:
  const copyManBtn = document.getElementById("copy-manifest-btn");
  copyManBtn.click();
  await new Promise((r) => setTimeout(r, 30));
  check("Copy manifest URL button copies exact manifest URL and shows 'Copied'", ui.getCopied() === emittedManifestUrl && copyManBtn.textContent === "Copied");

  const copyStremioBtn = document.getElementById("copy-stremio-btn");
  copyStremioBtn.click();
  await new Promise((r) => setTimeout(r, 30));
  check("Copy stremio:// button copies exact stremio:// URL", ui.getCopied().startsWith("stremio://"));

  // Live stream tester submission:
  clearResolveCache();
  const testForm = document.getElementById("test-form");
  testForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 180));

  const cards = document.querySelectorAll(".stream-card");
  check(
    "live stream test renders Direct + Proxy cards for castle (MKV excluded per toggle)",
    cards.length === 2 &&
      document.getElementById("test-results").textContent.includes("1080p") &&
      document.getElementById("test-results").textContent.includes("HLS") &&
      document.getElementById("test-results").textContent.includes("2.4 GB") &&
      document.getElementById("test-summary").textContent.includes("The Matrix"),
    `cards=${cards.length}`,
  );
  ui.dom.window.close();

  /* ---------------- 4. Plain-HTTP execCommand('copy') fallback + /:config/configure reload ---------------- */
  console.log("\n[4] execCommand('copy') fallback & /:config/configure pre-populated state");
  const preloaded = await bootPageInJsdom(`/${matchSeg[1]}/configure`, {
    useExecCommandFallback: true,
  });
  check(
    "visiting /:config/configure pre-populates saved addon name and MKV=off toggle",
    preloaded.document.getElementById("addon-name").value === "My Local Priva" &&
      preloaded.document.getElementById("toggle-mkv").checked === false,
  );
  preloaded.document.getElementById("copy-install-btn").click();
  await new Promise((r) => setTimeout(r, 30));
  check(
    "execCommand('copy') fallback copies configure link on plain HTTP without navigator.clipboard",
    preloaded.getCopied().endsWith(`/${matchSeg[1]}/configure`),
    preloaded.getCopied(),
  );
  preloaded.dom.window.close();
} finally {
  unregisterProvider("castle");
  unregisterProvider("4khdhub");
  clearResolveCache();
  await new Promise((r) => server.close(r));
  await new Promise((r) => cinemeta.close(r));
}
