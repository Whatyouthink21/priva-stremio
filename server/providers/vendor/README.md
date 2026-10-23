# Vendored providers

These directories contain **prebuilt provider bundles** copied from another
project. They are loaded before the CDN and, because a vendor directory exists,
the loader will **never** reach the network for that provider — including for
optional modules it does not ship. A vendored provider works air-gapped.

## Layout

```
vendor/<provider-id>/
├── catalog.js     list of categories            (optional)
├── posts.js       getPosts / getSearchPosts
├── meta.js        getMeta → linkList
├── episodes.js    getEpisodes                   (optional)
└── stream.js      getStream → [{server, link, type, quality}]
```

The directory name is the provider id. `VEGA_SOURCES=castle` looks for
`vendor/castle/`, and registers it as `vega:castle`.

Copy **the built bundles** (`dist/<provider>/*.js` from the upstream repo), not
the TypeScript sources. The upstream build inlines every local import, so a
bundle has no `require()` calls and no companion files to copy. `stream.js` for a
provider with helpers is typically 10–60 KB for exactly this reason.

---

## `castle`

| | |
|---|---|
| Source | https://github.com/Zenda-Cross/vega-providers |
| Path | `dist/castle/{catalog,posts,meta,stream,episodes}.js` |
| Upstream commit | `9b41e2752d481d181afe7bd585eca1a5d51ddac6` (main, 2026-10-22) |
| Modules | 5 (no `settings.js` upstream) |
| Self-contained | yes — `castleCore` is inlined, zero `require()` |

**sha256** (asserted by `tests/vendor-castle.mjs`, so upstream drift is visible):

```
09a8691f6cd4a9fd084c3157409ff5459be7bd636e8f660246df30881ca75d9a  catalog.js
427fdcdfb070972ee51a82a7cb9f4c2730dedf4f02fb5e185393f106f798fb9f  episodes.js
e0a0e0b04b2d4ed9df6475018bb6d21ea594c601f5951cf9d2d47b7617aa1f98  meta.js
32ff34a8ab0036606c85395e39c33b30b0b5cc794b2544426dd062c6049719bd  posts.js
edab1cf93cc47f9414b84f3e2297c4dbaea6d1ecf044502aa5fe3a30662e8c79  stream.js
```

### What this provider needs

`castle` is **search-based**, not ID-native:

```
getSearchPosts(title) → getMeta(page link) → getStream(castle://play/<movieId>_<episodeId>)
```

So a bare `/embed/movie/<id>` URL cannot resolve it — pass a title:

```
/embed/movie/1234?providers=vega:castle&title=Inception&year=2010
```

The bridge picks the best search hit by title similarity, walks `linkList` to the
episode's play link, then calls `getStream`. See `resolveViaVega()` in
`../vega.js` for the mapping.

### Refresh it

```bash
BASE=https://raw.githubusercontent.com/Zenda-Cross/vega-providers/main/dist/castle
for f in catalog posts meta stream episodes; do
  curl -fsSL "$BASE/$f.js" -o "server/providers/vendor/castle/$f.js"
done
npm run test:vendor   # fails loudly if the sha256 pins changed
```

Update the hashes above and in `tests/vendor-castle.mjs` when you re-vendor — the
point of the pin is that a change is a deliberate, reviewable act.

### Trust

Bundle evaluation runs in a `node:vm` context with `require` disabled and a
bounded `fetch`. **`vm` is a correctness boundary, not a security sandbox** — this
code executes in your server process with whatever privileges that process has.
Vendor providers you have actually read, or run the resolver in its own container.

### Licensing

The upstream repository has **no license file**, which means all rights are
reserved by default — it grants you nothing. Vendoring a bundle is a private
decision for whoever deploys this; it is not a right the upstream project gave
you. If this repo is ever distributed publicly, revisit that with the author.

---

## `autoEmbed` (MultiStream)

| | |
|---|---|
| Source | https://github.com/Zenda-Cross/vega-providers |
| Path | `dist/autoEmbed/{catalog,posts,meta,stream,settings}.js` |
| Modules | 5 |
| Self-contained | yes, with one caveat below |

**sha256** (asserted by `tests/vendor-multi.mjs`):

```
73c0c8b66eedd25550fdb4605c180ebb0c8d3f493d31177507f9c586e4783c41  catalog.js
e5c85d1df865671175bac22fd34ca36e5a6babc0bcd95ad23a0479204fde9945  posts.js
cf3665cf2a111ada4e4840e8e0224d6141801c312c125e20deeabecb98cc8778  meta.js
a377ff98b8db30a709444cdeca6286901d23abe4dfa58814028a962f05a90abf  settings.js
53f39dcc02dc8069fe0f0a099a88b1c5f6cd5ccb2ce9a540ee94d6efdc639c58  stream.js
```

### What this provider needs

An aggregator: one id fans out to three back-ends (Cinejoy, Movy, Vidstuck) and
returns whatever they resolve, which is why one provider can fill a whole server
menu. Output is HLS/DASH, so it never touches the remux path.

Search-based like `castle`, so it needs a title:

```
/embed/movie/1234?providers=vega:autoEmbed&title=Inception&year=2010
```

**The caveat:** `stream.js` probes `require("crypto")` for a fast OpenSSL path.
Our sandbox deliberately forbids modules, so that call throws — inside a
`try`, which is why it still works: the bundle carries a pure-JS AES fallback and
uses it. `tests/vendor-multi.mjs` asserts that fallback is still present, because
if upstream ever dropped it, the provider would fail with a confusing decrypt
error instead of an obvious one.

It is also the slowest of the four (three upstreams in parallel, each with
retries). Give it its own budget:

```bash
VEGA_TIMEOUTS="autoEmbed=25000"
```

---

## `movieBoxWeb`

| | |
|---|---|
| Source | https://github.com/Zenda-Cross/vega-providers |
| Path | `dist/movieBoxWeb/{catalog,episodes,meta,posts,stream}.js` |
| Modules | 5 (ships `episodes.js`) |
| Self-contained | yes — zero `require()` |

**sha256**:

```
bde84d9d7fdaba6c6469ea1b934b83634ffe591a271ccb7989f3823f46ca6ef4  catalog.js
93840a1ce347fa8accd57a2fa74a41a3c8467fa4c3ed900334636e4747d23fdf  episodes.js
bd15033c790f274c88739601ecd482a527f87c6b133170b5bbe92902e8a9a608  meta.js
269e318432d33a5cf09b6b5a5525043520b1419d6a581d1f14cdfef874f0402a  posts.js
8271d00279f2585dee3f67742059c4eb14b667e43ad4989fe767df4dd332c6c4  stream.js
```

### What this provider needs

Search-based, HLS/DASH + WebVTT captions, no account (it resets its cookie to
`token=` to use the anonymous API). Titles are strong for Asian releases.

Series are labelled **`S01 E03`**, which exposed a real bridge bug: episode
selection used to take the *first number* in the label, so every episode was read
as episode 1 (or worse, as season 1). `episodeNumberOf()` /
`seasonNumberOf()` in `../vega.js` now parse `S01E03`, `S01 E03`, `1x03`,
`Episode 3`, `E03` and only fall back to a bare number when nothing else
matches — and the match is season-aware, so `S02 E03` cannot satisfy a request
for `S01 E03`.

---

## `4khdhub`

| | |
|---|---|
| Source | https://github.com/Zenda-Cross/vega-providers |
| Path | `dist/4khdhub/{catalog,posts,meta,stream,settings}.js` |
| Upstream commit | `main`, 2026-10-22 |
| Modules | 5 |
| Self-contained | yes — the HubCloud extractor is inlined, zero `require()` |

**sha256** (asserted by `tests/vendor-4khdhub.mjs`):

```
a4ee2d3fbdead1bdf0317c77d8441e44994dab2975acfd5bb3fbcc914fc31100  catalog.js
2a39c7c15ce9b449e458442eb14933397c680e051352a6b2977f197cf696a3ff  posts.js
32e8cbce6f9b9c7f51a8dbb266d98299fb18ecdbed9005a4ba492c900f6d754d  meta.js
b391f8a39e2359cb33af0cc6320e6c9e6b1477050615e92f8ce6fd44132a1cb3  settings.js
a394d51245387562b30f7b94e96322e31aa2705ceb5a003746fae21ece535e3c  stream.js
```

### What this provider needs

Same shape as `castle` — search-based, so it needs a title:

```
/embed/movie/1234?providers=vega:4khdhub&title=Inception&year=2010
```

Two differences the bridge had to be taught:

1. **One `linkList` entry per quality.** A movie's meta carries 480p, 720p,
   1080p and 2160p as separate entries, each with its own HubCloud link.
   `pickMediaLinks()` returns all of them and the resolver extracts them in
   parallel, so the quality menu is real instead of "whatever was first".
2. **Everything comes back as `.mkv`.** The extractor hardcodes `type: "mkv"`
   for every server it finds (Pixeldrain, CF Worker, CF Storage, FastDl,
   HubCdn, GDrive). No browser can demux Matroska, so these streams go through
   the remux endpoint instead of straight into `<video>` — see
   [`docs/mkv-remux.md`](../../../docs/mkv-remux.md).

### Refresh it

```bash
BASE=https://raw.githubusercontent.com/Zenda-Cross/vega-providers/main/dist/4khdhub
for f in catalog posts meta stream settings; do
  curl -fsSL "$BASE/$f.js" -o "server/providers/vendor/4khdhub/$f.js"
done
npm run test:4khdhub   # fails loudly if the sha256 pins changed
```

### Trust / licensing

Identical caveats to `castle` below: the bundle runs inside your server
process, `vm` is not a sandbox, and upstream has no license file.
