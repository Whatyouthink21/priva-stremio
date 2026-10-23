import dns from "node:dns";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Prefer IPv4 first so broken/unrouted dual-stack IPv6 on home ISPs does not add
// multi-second TCP SYN stalls to upstream provider requests.
dns.setDefaultResultOrder("ipv4first");
import { config, warnings } from "./config.js";
import { logger } from "./lib/log.js";
import { proxyRouter } from "./routes/proxy.js";
import { addonRouter } from "./routes/addon.js";
import { syncVegaProviders } from "./providers/registry.js";
import { health } from "./lib/health.js";
import { metadataEnabled } from "./lib/metadata.js";

const log = logger("server");
export const app = express();

app.set("trust proxy", true);
app.disable("x-powered-by");

/* ---------------------------------------------------------------- */
/* CORS + Security Headers                                           */
/* ---------------------------------------------------------------- */

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range, If-None-Match");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, X-Priva-Stats",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
});

/* ---------------------------------------------------------------- */
/* Static assets                                                     */
/* ---------------------------------------------------------------- */

const PUBLIC_DIR = path.join(process.cwd(), "public");

app.get("/favicon.svg", (req, res) => {
  res
    .type("image/svg+xml")
    .setHeader("Cache-Control", "public, max-age=86400")
    .send(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
        `<rect width="64" height="64" rx="14" fill="#2563eb"/>` +
        `<path d="M24 18l22 14-22 14z" fill="#fff"/></svg>`,
    );
});

app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    maxAge: 0,
    etag: true,
    lastModified: true,
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-cache");
    },
  }),
);

/* ---------------------------------------------------------------- */
/* Routes                                                            */
/* ---------------------------------------------------------------- */

app.use("/", proxyRouter);
app.use("/", addonRouter);

app.use((req, res) => {
  res.status(404).json({ error: "not found" });
});

app.use((err, req, res, _next) => {
  log.error(`${req.method} ${req.url}: ${err.message}`);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.message || "internal error" });
});

/* ---------------------------------------------------------------- */
/* Boot                                                              */
/* ---------------------------------------------------------------- */

let server;

export async function startServer() {
  if (config.vega.enabled) {
    await syncVegaProviders().catch((e) => log.warn(`vega sync failed: ${e.message}`));
  }

  return new Promise((resolve, reject) => {
    server = app.listen(config.port, config.host, () => {
      log.info(`priva-stremio listening on http://${config.host}:${config.port}`);
      log.info(`public base: ${config.publicBaseUrl} · configure: ${config.publicBaseUrl}/configure`);
      for (const w of warnings) log.warn(w);
      log.info(
        `sources: ${config.vega.sources.join(", ")} · proxy: ${config.proxyEnabled ? "on" : "off"} · tmdb: ${metadataEnabled() ? "on" : "off (cinemeta primary)"}`,
      );
      resolve(server);
    });
    server.on("error", reject);
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  startServer().catch((err) => {
    log.error(`failed to start: ${err.message}`);
    process.exit(1);
  });

  const shutdown = (sig) => {
    log.info(`${sig} received, shutting down`);
    health.flush();
    server?.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
