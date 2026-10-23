# priva-stremio

Stream-only Stremio addon built on the multi-provider resolver and signed range proxy from [`priva-embed`](https://github.com/Whatyouthink21/priva-embed).

`priva-stremio` exposes **only** Stremio's `stream` resource (`community.priva.streams`) — no duplicate catalogs, no browser player bundle, no ffmpeg remux pipeline, and zero third-party wrapper dependencies. For each movie (`tt0133093`) or episode (`tt0944947:1:1`), it resolves streams in parallel across vendored Vega providers, ranks them (`HLS → MP4 → DASH → MKV`, highest resolution first), deduplicates links, and emits:

1. **Direct rows** — upstream stream URL + `behaviorHints.proxyHeaders.request` (zero bandwidth through your server on Stremio Desktop / Android).
2. **Signed proxy rows (`/p/<token>`)** — stateless HMAC-signed range proxy that forwards `Referer`/`Cookie`/`User-Agent`, answers `206 Partial Content` byte ranges for seeking, and rewrites HLS `.m3u8` segments + AES-128 keys.

---

## Requirements

- **Node.js `20.6+`** (`Node 22 LTS` recommended — `.env` is loaded natively via Node's `--env-file-if-exists=.env` flag with zero `dotenv`).
- **Stremio Desktop** (Windows / macOS / Linux) for local `http://127.0.0.1:7000` installation.

---

## Run Locally on Windows (Command Prompt)

```cmd
git clone https://github.com/Whatyouthink21/priva-stremio.git
cd priva-stremio
npm install
npm run vendor
copy .env.example .env
npm start
```

### Run Locally on macOS / Linux

```bash
git clone https://github.com/Whatyouthink21/priva-stremio.git
cd priva-stremio
npm install
npm run vendor
cp .env.example .env
npm start
```

The server listens on **`http://127.0.0.1:7000`** (`0.0.0.0:7000`):

- **Overview:** `http://127.0.0.1:7000/`
- **Configure & Live Stream Tester:** `http://127.0.0.1:7000/configure`
- **Default Manifest:** `http://127.0.0.1:7000/manifest.json`
- **Health Check:** `http://127.0.0.1:7000/health`

### Quick `curl` Smoke Checks (Windows CMD or Terminal)

```cmd
curl http://127.0.0.1:7000/health
curl http://127.0.0.1:7000/manifest.json
curl http://127.0.0.1:7000/stream/movie/tt0133093.json
curl http://127.0.0.1:7000/stream/series/tt0944947:1:1.json
```

### Install in Stremio Desktop

1. Open **`http://127.0.0.1:7000/configure`** in your browser.
2. Adjust providers, MKV preference, proxy rows, and timeouts (or test a title directly inside the **Live stream tester** card).
3. Click **Install in Stremio** (or click **Copy manifest URL** and paste `http://127.0.0.1:7000/<config>/manifest.json` into Stremio's Addon search bar).

---

## Stateless URL Configuration (`/<config>/manifest.json`)

Nothing is stored in a database on the server. `/configure` encodes your preferences as compact base64url JSON right in the URL path:

```json
{
  "n": "Priva",
  "p": ["castle", "4khdhub", "autoEmbed", "movieBoxWeb", "kissKh"],
  "b": { "castle": 6, "autoEmbed": 10, "movieBoxWeb": 10, "kissKh": 10, "4khdhub": 15 },
  "mk": true,
  "px": true,
  "max": 20
}
```

- Opening `/<config>/configure` or `/configure?config=<config>` pre-populates your saved choices.
- Unknown keys are ignored for forward compatibility; malformed base64 or non-object JSON returns a clean `HTTP 400`.
- When you change any setting later, click **Install in Stremio** again to replace the addon entry.

---

## Stremio Desktop vs Stremio Web

| Client | `http://127.0.0.1:7000` | MKV Streams | Custom Upstream Headers |
| :--- | :--- | :--- | :--- |
| **Stremio Desktop** | Works out of the box | Native MPV playback | Supported directly + via `/p/<token>` |
| **Stremio Web (`web.stremio.com`)** | Blocked by mixed-content HTTPS rules | Unreliable in browser decoders — turn **Include MKV** off on `/configure` | Requires **Include proxy rows** (`/p/<token>`) |

To use a **local** server with **Stremio Web**, expose port `7000` over HTTPS with Cloudflare Tunnel and set `PUBLIC_BASE_URL` in `.env`:

```cmd
cloudflared tunnel --url http://127.0.0.1:7000
```

Then set `PUBLIC_BASE_URL=https://<your-subdomain>.trycloudflare.com` in `.env` and restart `npm start`.

---

## Timeouts, Partial Answers & Reloading for Stragglers

Stremio drops slow addon requests if they take too long, while sources like `4khdhub` walk multi-step extractor chains.

- Per-provider default budgets: `castle=6000ms`, `autoEmbed=10000ms`, `movieBoxWeb=10000ms`, `kissKh=10000ms`, `4khdhub=15000ms`.
- Once the fastest provider returns playable streams, `priva-stremio` waits **`RESOLVE_GRACE_MS=3000` (3 seconds)** for other fast peers and returns immediately so Stremio stays responsive.
- Slower providers **keep running in the background** and automatically upgrade the in-memory cache entry when they finish. On `/configure`, the Live Stream Tester automatically polls until background sources complete; in Stremio, re-opening the title once shows the full cached set instantaneously.

---

## Provider Status

Provider bundles come unmodified from [`Zenda-Cross/vega-providers`](https://github.com/Zenda-Cross/vega-providers) (`npm run vendor`) and resolve active mirror domains dynamically from `urls.json` at runtime.

| Provider ID | Upstream Label | Typical Output | Default Budget | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `castle` | Castle TV | MP4 / HLS | `6s` | Fast movie & TV resolver across broad catalog |
| `4khdhub` | 4KHDHub | MKV (up to 2160p HDR/DV) | `10s` | High-bitrate releases via HubCloud; best on Stremio Desktop |
| `autoEmbed` | MultiStream | HLS / MP4 | `8s` | Parallel aggregator across Cinejoy, Movy, and Vidstuck |
| `movieBoxWeb` | MovieBox Web | HLS / MP4 + Subtitles | `8s` | Multi-quality streams with multi-language captions |
| `kissKh` | KissKH | HLS + Subtitles | `8s` | Asian dramas & anime with decrypted `.srt`/`.vtt` subtitles |
| `everything` | *(Excluded)* | — | — | Requires interactive Cloudflare Turnstile WebView token (impossible headless) |
| `mxplayer` | *(Excluded)* | — | — | Requires live browser session cookies |
| `disabled: true` | *(Excluded)* | — | — | All upstream entries marked `disabled: true` in `manifest.json` are blocked |

---

## Deploy to Render

`render.yaml` ships ready for Render's Node Web Service Blueprint:

1. Push this repository to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com), click **New + → Blueprint** and select your repository.
3. Render reads `render.yaml` automatically (`buildCommand: npm ci`, `startCommand: npm start`, `healthCheckPath: /health`, auto-generated `TOKEN_SECRET`).
4. Once live, open `https://<your-service>.onrender.com/configure` and click **Install in Stremio**.

> **Important Render Free-Tier Note:** Render's free web instances spin down after **15 minutes of inactivity**, and waking a sleeping instance takes **~30–50 seconds** — longer than Stremio waits on a single stream request. Either open `/health` once before watching, schedule an external 10-minute ping to `https://<your-service>.onrender.com/health`, or use a paid starter instance.

### Environment Variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `7000` | HTTP listen port (`0.0.0.0:$PORT`) |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:$PORT` | Public origin override (auto-detected from `X-Forwarded-Proto`/`Host` on Render) |
| `TOKEN_SECRET` | *(auto-generated with warning)* | 64-char hex HMAC key for `/p/<token>` links (set in `.env` so tokens survive restarts) |
| `TOKEN_TTL` | `43200` | Signed proxy token lifetime in seconds (12 hours) |
| `VEGA_SOURCES` | `castle,4khdhub,autoEmbed,movieBoxWeb,kissKh` | Default enabled providers |
| `VEGA_LINK_CONCURRENCY` | `3` | Concurrent link extractions per provider |
| `VEGA_TIMEOUTS` | `castle=6000,autoEmbed=8000,movieBoxWeb=8000,kissKh=8000,4khdhub=10000` | Per-provider timeout budgets in ms |
| `RESOLVE_GRACE_MS` | `1000` | Grace window after first stream hit before returning partial results |
| `TMDB_API_KEY` | *(optional)* | Optional TMDB fallback/enrichment key (Cinemeta is used automatically with no key) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |

---

## Tests

All test suites are zero-framework Node `.mjs` scripts that run 100% offline:

```cmd
npm run test:all
```

Individual suites:

- `npm run test:addon` — Manifest, CORS, ID parser, config round-trip, stream formatting, dedupe, ranking, Range `206` proxy, `/health`
- `npm run test:resolver` — 50ms + hung + throwing provider isolation & background cache completion
- `npm run test:matcher` — Title normalizer, sequel rejection, season `0` specials, quality/size extraction
- `npm run test:vega` — `node:vm` sandbox evaluation, header isolation, `cf_clearance` cookie sanitization
- `npm run test:vendor` — All 5 vendored provider bundles + offline `kissKh` execution + blocked-provider guards
- `npm run test:ui` — `jsdom` tests for `/` and `/configure`, live URL updates, clipboard fallbacks, live stream tester
- `npm run test:deploy` — Clean boot without `.env`, `PORT` override, excluded legacy file checks, `render.yaml` validation
