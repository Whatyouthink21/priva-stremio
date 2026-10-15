import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeConfig, DEFAULT_CONFIG } from './lib/config.js';
import { buildManifest, ADDON_VERSION } from './lib/manifest.js';
import { getStreams } from './lib/streams.js';
import { imdbToTmdb } from './lib/meta.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = Number(process.env.PORT || 7000);
const HOST = process.env.HOST || '0.0.0.0';

/** Public origin of this addon. Override when running behind a tunnel/proxy. */
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* ------------------------------------------------------------------ */

function sendJson(res, body, status = 200, cacheSeconds = 0) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'cache-control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-cache',
  });
  res.end(payload);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'access-control-allow-origin': '*' });
  res.end();
}

function notFound(res) {
  sendJson(res, { err: 'not found' }, 404);
}

/** Absolute public origin for the current request. */
function originFor(req) {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
  const proto =
    (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

async function sendFile(res, filePath, cacheSeconds = 300) {
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': data.length,
      'access-control-allow-origin': '*',
      'cache-control': `public, max-age=${cacheSeconds}`,
    });
    res.end(data);
  } catch {
    notFound(res);
  }
}

/* ---------------------------- routing ------------------------------ */

// Optional config segment: /<cfg>/manifest.json  or  /manifest.json
const CFG = '(?:([A-Za-z0-9_-]+)/)?';
const RE_MANIFEST = new RegExp(`^/${CFG}manifest\\.json$`);
const RE_STREAM = new RegExp(`^/${CFG}stream/(movie|series)/([^/]+)\\.json$`);
const RE_CONFIGURE = new RegExp(`^/${CFG}configure/?$`);
const RE_RECONFIGURE = new RegExp(`^/${CFG}reconfigure$`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
    });
    return res.end();
  }

  const origin = originFor(req);

  try {
    // Health / landing
    if (pathname === '/' || pathname === '/health') {
      return sendJson(res, {
        ok: true,
        addon: 'TG HUB Stremio addon',
        version: ADDON_VERSION,
        manifest: `${origin}/manifest.json`,
        configure: `${origin}/configure`,
      });
    }

    // Manifest
    let m = RE_MANIFEST.exec(pathname);
    if (m) {
      return sendJson(res, buildManifest(origin, m[1] || ''), 200, 3600);
    }

    // Streams
    m = RE_STREAM.exec(pathname);
    if (m) {
      const [, configParam, type, id] = m;
      const cfg = decodeConfig(configParam);
      const streams = await getStreams(cfg, type, id, origin, configParam || '');
      // Cache a little: IMDB->TMDB never changes for a given title.
      return sendJson(res, streams, 200, 60 * 60 * 6);
    }

    // Diagnostic: does IMDb -> TMDB resolution work from this machine?
    m = /^\/resolve\/(movie|series)\/(tt\d+)$/.exec(pathname);
    if (m) {
      const [, type, imdbId] = m;
      const meta = await imdbToTmdb(type, imdbId);
      return sendJson(res, {
        type,
        imdbId,
        tmdbId: meta ? meta.tmdbId : null,
        name: meta ? meta.name : null,
        via: meta ? meta.via : null,
        status: meta
          ? 'ok'
          : 'no TMDB id found — Cinemeta unreachable? Set TMDB_API_KEY to fall back to TMDB.',
      });
    }

    // Configure page (Stremio's "Configure" button opens this)
    m = RE_CONFIGURE.exec(pathname);
    if (m) {
      return sendFile(res, path.join(PUBLIC_DIR, 'configure.html'));
    }

    // Stremio posts here when the user saves configuration.
    m = RE_RECONFIGURE.exec(pathname);
    if (m) {
      return redirect(res, `${origin}/configure`);
    }

    // Optional full-screen bridge page
    if (pathname.endsWith('/play.html')) {
      return sendFile(res, path.join(PUBLIC_DIR, 'play.html'));
    }

    // Static assets
    if (pathname === '/logo.png' || pathname === '/background.png' || pathname === '/favicon.ico') {
      return sendFile(res, path.join(PUBLIC_DIR, pathname.replace(/^\//, '')), 86400);
    }

    return notFound(res);
  } catch (err) {
    console.error('[error]', err);
    return sendJson(res, { err: 'internal error' }, 500);
  }
});

server.listen(PORT, HOST, () => {
  const shown = PUBLIC_ORIGIN || `http://${HOST}:${PORT}`;
  console.log(`TG HUB Stremio addon listening on ${HOST}:${PORT}`);
  console.log(`  local:   http://127.0.0.1:${PORT}/manifest.json`);
  console.log(`  public:  ${shown}/manifest.json`);
  console.log(`  config:  ${shown}/configure`);
  console.log(`\nAdd the manifest URL above to Stremio (Add-ons → "+ Add Addon" → paste URL).`);
});

export { server, DEFAULT_CONFIG };
