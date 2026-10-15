# TG HUB — Stremio Addon

A Stremio addon that attaches a **TG HUB** stream to every movie and TV episode you
browse, using TG HUB's public embed URLs:

```
Movies       https://tgvid.lovable.app/embed/movie/{tmdbId}
TV episodes  https://tgvid.lovable.app/embed/tv/{tmdbId}/{season}/{episode}
```

Zero dependencies — Node 18+ built-ins only.

---

## How playback works (please read this first)

Stremio's built-in player only accepts **direct video files** (mp4 / m3u8 / mpd /
torrent / YouTube). It cannot render a web page or an iframe, so the TG HUB embed
can **never** play inside Stremio's own player.

This addon therefore returns the Stremio SDK's [`externalUrl`
field](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md):

> `externalUrl` — string, Meta Link or an external URL to the video, **which should be
> opened in a browser (webpage)**, e.g. link to Netflix

Official Stremio clients (desktop, Android, Stremio Web) honour it, so the flow is:

1. Browse to any movie or episode in Stremio.
2. Pick the **TG HUB** stream.
3. Stremio hands off to your browser → the TG HUB player opens with everything
   intact: server switching, quality selector, multi-audio, subtitles, skip
   intro/outro, and resume.

See [Native playback](#native-playback) for why playing *inside* Stremio isn't
currently wired up.

---

## Quick start

### Node

```bash
git clone <this-repo> && cd priva-stremio
node server.js          # or: npm start
```

Then in Stremio: **Add-ons → "+ Add Addon"** → paste:

```
http://127.0.0.1:7000/manifest.json
```

…or open <http://127.0.0.1:7000/configure> to pick your preferences first and get a
ready-made manifest URL.

To change the port: `PORT=8000 node server.js`

### Docker (recommended for "always on")

```bash
docker compose up -d
curl http://127.0.0.1:7000/health
docker compose logs -f
```

The container restarts on failure and on reboot (`restart: unless-stopped`) and has a
healthcheck that hits `/health`.

---

## Reaching Stremio on another device (phone, TV)

The addon must be reachable over the network, and Stremio's Android TV / mobile
clients generally need **https**. Put the local port behind a tunnel:

```bash
# ad-hoc tunnel
npx cloudflared tunnel --url http://127.0.0.1:7000
# or
ngrok http 7000

# or, with the bundled compose profile (prints the https URL in the logs)
docker compose --profile tunnel up -d
docker compose logs -f tunnel
```

Then run the addon with your public origin so generated URLs are correct:

```bash
PUBLIC_ORIGIN=https://your-tunnel.example.com node server.js
```

Without `PUBLIC_ORIGIN` the addon derives its origin from the request's `Host` /
`X-Forwarded-*` headers, which is why the generated manifest URL can look wrong when
you're testing through a proxy.

### Auto-start on Linux

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/tghub-addon.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tghub-addon
loginctl enable-linger $USER   # keep it running after logout
```

---

## Configuration

Open `/configure` to set your preferences. Stremio shows a **Configure** button on
the addon because the manifest declares `behaviorHints.configurable`.

| Setting | Embed param | Notes |
| --- | --- | --- |
| Accent colour | `color` | 6 hex digits, no `#`. Empty = TG HUB default (`e11d2e`). |
| Preferred audio language | `lang` | `hi` / `eng` / `jap` / `tam` / `tel` |
| Extra language shortcuts | — | Adds one extra stream entry per language |
| Show back button | `back` | |
| Show Episodes button | `episodeSelector` | TV only |
| Autoplay next episode | `autoplayNextEp` | TV only |
| Loading screen style | `loading` | `1` / `2` / `3` |
| Force server | `server` | e.g. `cinemaos` |
| Bridge page | — | Full-screen shell + resume (see below) |

The config is base64url-encoded JSON in the manifest path:

```
http://127.0.0.1:7000/<encoded>/manifest.json
```

so different Stremio profiles can have different settings.

### Bridge page (optional)

Tick **Use the bridge page** and streams open a local full-screen shell
(`/play.html`) that:

- iframes TG HUB with your saved preferences,
- listens for the player's `TGFLIX_EVENT` `postMessage` events and saves progress to
  `localStorage`,
- re-opens the next time with `?t=<seconds>` so you resume where you left off,
- shows a friendly message instead of a blank screen if TG HUB is slow to load.

Leave it off for the simplest setup — TG HUB already does its own resume playback,
and the direct link has no moving parts.

---

## How IDs are resolved

Stremio identifies titles by **IMDb** id (`tt0111161`), but the TG HUB embed needs a
**TMDB** numeric id.

1. **Cinemeta** (default, no API key) — Stremio's own metadata addon returns
   `moviedb_id`:
   ```
   GET https://v3-cinemeta.strem.io/meta/movie/tt0111161.json  →  meta.moviedb_id = 278
   ```
2. **TMDB `/find`** (fallback) — used only when you set `TMDB_API_KEY`:
   ```
   GET https://api.themoviedb.org/3/find/tt0111161?api_key=…&external_source=imdb_id
   ```

Results are cached in memory for 24h. There's a diagnostic endpoint:

```bash
curl http://127.0.0.1:7000/resolve/movie/tt0111161
# {"type":"movie","imdbId":"tt0111161","tmdbId":"278","name":"The Shawshank Redemption","via":"cinemeta","status":"ok"}
```

If that returns `tmdbId: null`, Cinemeta isn't reachable from your machine — set
`TMDB_API_KEY` and the addon will fall back to TMDB automatically. Without either,
it returns no streams.

Series requests carry season/episode as `tt0903747:1:1`. A bare series request
(`tt0903747`) returns no streams, since there's no episode to open.

---

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/manifest.json`, `/{config}/manifest.json` | Addon manifest |
| `GET` | `/stream/movie/tt{id}.json` | Movie streams |
| `GET` | `/stream/series/tt{id}:{s}:{e}.json` | Episode streams |
| `GET` | `/configure`, `/{config}/configure` | Configuration page |
| `GET` | `/{config}/play.html` | Optional bridge page |
| `GET` | `/resolve/{movie\|series}/tt{id}` | IMDb → TMDB diagnostic |
| `GET` | `/health` | Health check |

---

## Example stream response

```json
{
  "streams": [
    {
      "name": "TG HUB · हिंदी",
      "description": "Movie · TMDB 278\nOpens the TG HUB player in your browser.",
      "externalUrl": "https://tgvid.lovable.app/embed/movie/278?color=00b4ff&lang=hi",
      "behaviorHints": { "notWebReady": false, "bingeGroup": "tghub-hi" }
    }
  ]
}
```

---

## Tests

```bash
npm test
```

25 checks covering config sanitisation, embed URL building, id parsing, stream
shape, language variants, the bridge page and both metadata resolvers. Cinemeta and
TMDB are stubbed, so it runs offline.

---

## Native playback

To play TG HUB's video *inside* Stremio you need the raw HLS/DASH URL rather than
the embed page, because:

- the player's `source` data is only exposed via `postMessage` to the embedding
  frame — a Stremio addon server never sees it, and
- once Stremio has handed off to a browser (which is what `externalUrl` does),
  there's no path back into the player.

Getting the URL server-side means reverse-engineering the endpoints the SPA calls.
**I tried and could not do it from this environment**: `tgvid.lovable.app` is a
client-side React SPA whose server-rendered HTML contains no URLs, and only the
rendered page — not the JS bundle — is retrievable from here, so there's no way to
read the network calls it makes.

If you want to chase it yourself:

1. Open <https://tgvid.lovable.app/embed/movie/278> in Chrome.
2. DevTools → Network, filter for `m3u8` / `mpd`.
3. Confirm the URL works with no `Referer` header (`curl` it directly).
4. If so, return it as `url` with `behaviorHints.notWebReady: true`.
5. If it needs headers, `behaviorHints.proxyHeaders` can attach them — desktop
   clients only, not Stremio Web, and it must be paired with `notWebReady: true`.

Most such CDNs are Referer-locked and CORS-restricted, which is exactly what breaks
hls.js in Stremio Web — so expect this path to be unreliable even when it works.

---

## Notes

- `notWebReady: false` is set deliberately: it tells Stremio Web not to hide the
  stream.
- `bingeGroup` is set per language so Stremio keeps using the same variant when
  auto-playing the next episode.
- Stream responses are cached for 6h (`Cache-Control`), manifests for 1h, metadata
  for 24h in memory.
- The addon ships with no catalogs — it only supplies streams for titles Stremio
  already knows about.
- TG HUB aggregates unofficial sources, so treat this as a personal convenience and
  keep it to yourself rather than publishing it as a public addon.
