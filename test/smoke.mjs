/**
 * Zero-dependency smoke test for the addon's stream + config logic.
 *
 *   node test/smoke.mjs
 *
 * Cinemeta is stubbed so the test runs offline; the real request is a plain
 * GET to https://v3-cinemeta.strem.io/meta/{type}/{imdbId}.json
 */
import assert from 'node:assert/strict';

// Stub the metadata lookup before importing the module under test.
globalThis.fetch = async (url) => {
  const s = String(url);

  // TMDB /find fallback (only exercised when TMDB_API_KEY is set)
  if (s.includes('api.themoviedb.org/3/find/')) {
    const id = (s.match(/find\/(tt\d+)/) || [])[1];
    const table = {
      tt8888888: { movie_results: [{ id: 555, title: 'Found Via TMDB' }], tv_results: [] },
    };
    const hit = table[id];
    return { ok: !!hit, json: async () => (hit || {}) };
  }

  // Cinemeta
  const table = {
    'meta/movie/tt0111161.json': { meta: { id: 'tt0111161', type: 'movie', name: 'The Shawshank Redemption', moviedb_id: 278 } },
    'meta/series/tt0903747.json': { meta: { id: 'tt0903747', type: 'series', name: 'Breaking Bad', moviedb_id: 1396 } },
    'meta/movie/tt9999999.json': { meta: { id: 'tt9999999', type: 'movie', name: 'No Tmdb Id' } },
    'meta/movie/tt8888888.json': { meta: { id: 'tt8888888', type: 'movie', name: 'Also No Tmdb Id' } },
  };
  const hit = Object.entries(table).find(([k]) => s.includes(k));
  return {
    ok: !!hit,
    json: async () => (hit ? hit[1] : {}),
  };
};

const { getStreams } = await import('../lib/streams.js');
const { encodeConfig, decodeConfig, sanitizeConfig, buildEmbedUrl, DEFAULT_CONFIG } = await import('../lib/config.js');
const { parseStremioId, imdbToTmdb } = await import('../lib/meta.js');
const ORIGIN = 'http://127.0.0.1:7000';
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('\nconfig');
check('defaults survive a round trip', () => {
  const enc = encodeConfig(DEFAULT_CONFIG);
  assert.deepEqual(decodeConfig(enc), DEFAULT_CONFIG);
});
check('garbage config falls back to defaults', () => {
  assert.deepEqual(decodeConfig('!!!not-base64!!!'), DEFAULT_CONFIG);
});
check('invalid values are rejected', () => {
  const c = sanitizeConfig({ color: 'red', lang: 'klingon', loading: '9', back: 'maybe', server: '../../etc/passwd' });
  assert.equal(c.color, '');
  assert.equal(c.lang, '');
  assert.equal(c.loading, '');
  assert.equal(c.back, 'true');
  assert.equal(c.server, '');
});
check('non-https baseUrl is rejected', () => {
  assert.equal(sanitizeConfig({ baseUrl: 'http://evil.example' }).baseUrl, DEFAULT_CONFIG.baseUrl);
  assert.equal(sanitizeConfig({ baseUrl: 'https://tgvid.lovable.app/x' }).baseUrl, 'https://tgvid.lovable.app');
});
check('unknown languages are dropped', () => {
  assert.deepEqual(sanitizeConfig({ languages: ['hi', 'xx', 'eng', 'eng'] }).languages, ['hi', 'eng']);
});

console.log('\nembed url');
check('movie url', () => {
  assert.equal(
    buildEmbedUrl(DEFAULT_CONFIG, { type: 'movie', tmdbId: 1303331 }),
    'https://tgvid.lovable.app/embed/movie/1303331'
  );
});
check('tv url', () => {
  assert.equal(
    buildEmbedUrl(DEFAULT_CONFIG, { type: 'series', tmdbId: 94605, season: 1, episode: 1 }),
    'https://tgvid.lovable.app/embed/tv/94605/1/1'
  );
});
check('only non-default params are emitted', () => {
  const url = buildEmbedUrl(
    { ...DEFAULT_CONFIG, color: '00b4ff', lang: 'hi', back: 'false' },
    { type: 'movie', tmdbId: 1303331 }
  );
  assert.equal(url, 'https://tgvid.lovable.app/embed/movie/1303331?color=00b4ff&lang=hi&back=false');
});
check('season/episode are url-safe', () => {
  const url = buildEmbedUrl(DEFAULT_CONFIG, { type: 'series', tmdbId: 94605, season: 2, episode: 11 });
  assert.equal(url, 'https://tgvid.lovable.app/embed/tv/94605/2/11');
});

console.log('\nid parsing');
check('movie id', () => assert.deepEqual(parseStremioId('movie', 'tt0111161'), { imdbId: 'tt0111161' }));
check('series id with episode', () =>
  assert.deepEqual(parseStremioId('series', 'tt0903747:1:1'), { imdbId: 'tt0903747', season: 1, episode: 1 }));
check('series id without episode', () =>
  assert.deepEqual(parseStremioId('series', 'tt0903747'), { imdbId: 'tt0903747', season: undefined, episode: undefined }));
check('junk id rejected', () => assert.equal(parseStremioId('movie', 'not-an-id'), null));

console.log('\nstreams');
const movie = await getStreams(DEFAULT_CONFIG, 'movie', 'tt0111161', ORIGIN, '');
check('movie resolves to a TG HUB stream', () => {
  assert.equal(movie.streams.length, 1);
  assert.equal(movie.streams[0].externalUrl, 'https://tgvid.lovable.app/embed/movie/278');
  assert.equal(movie.streams[0].behaviorHints.notWebReady, false);
  assert.ok(!('url' in movie.streams[0]), 'must NOT set url — Stremio would try to play the HTML page');
  assert.ok(movie.streams[0].name.startsWith('TG HUB'));
});

const series = await getStreams(DEFAULT_CONFIG, 'series', 'tt0903747:1:1', ORIGIN, '');
check('series resolves to a TG HUB stream', () => {
  assert.equal(series.streams.length, 1);
  assert.equal(series.streams[0].externalUrl, 'https://tgvid.lovable.app/embed/tv/1396/1/1');
});

const bareSeries = await getStreams(DEFAULT_CONFIG, 'series', 'tt0903747', ORIGIN, '');
check('series without episode returns no streams', () => assert.deepEqual(bareSeries, { streams: [] }));

const noTmdb = await getStreams(DEFAULT_CONFIG, 'movie', 'tt9999999', ORIGIN, '');
check('title without a TMDB id returns no streams', () => assert.deepEqual(noTmdb, { streams: [] }));

const junk = await getStreams(DEFAULT_CONFIG, 'movie', 'garbage', ORIGIN, '');
check('malformed id returns no streams', () => assert.deepEqual(junk, { streams: [] }));

console.log('\nlanguage variants');
const multi = await getStreams(
  sanitizeConfig({ lang: 'hi', languages: ['hi', 'eng'], color: '00b4ff' }),
  'movie',
  'tt0111161',
  ORIGIN,
  ''
);
check('one stream per language, no duplicates', () => {
  assert.equal(multi.streams.length, 2);
  const urls = multi.streams.map((s) => s.externalUrl);
  assert.ok(urls.some((u) => u.includes('lang=hi')));
  assert.ok(urls.some((u) => u.includes('lang=eng')));
  assert.equal(new Set(urls).size, 2);
});
check('language variants share the colour setting', () => {
  multi.streams.forEach((s) => assert.ok(s.externalUrl.includes('color=00b4ff')));
});
check('bingeGroup is stable per language', () => {
  const hi = multi.streams.find((s) => s.externalUrl.includes('lang=hi'));
  assert.equal(hi.behaviorHints.bingeGroup, 'tghub-hi');
});

console.log('\nbridge page');
const bridged = await getStreams(
  sanitizeConfig({ useBridge: true, lang: 'hi' }),
  'series',
  'tt0903747:2:5',
  ORIGIN,
  'CFG123'
);
check('bridge streams point at the local play page and carry the config', () => {
  const u = new URL(bridged.streams[0].externalUrl);
  assert.equal(u.origin + u.pathname, `${ORIGIN}/CFG123/play.html`);
  assert.equal(u.searchParams.get('type'), 'series');
  assert.equal(u.searchParams.get('id'), '1396');
  assert.equal(u.searchParams.get('s'), '2');
  assert.equal(u.searchParams.get('e'), '5');
  assert.equal(u.searchParams.get('lang'), 'hi');
});

console.log('\nmetadata resolution');
const shawshank = await imdbToTmdb('movie', 'tt0111161');
check('Cinemeta is the primary resolver', () => {
  assert.equal(shawshank.tmdbId, '278');
  assert.equal(shawshank.via, 'cinemeta');
});

const unresolved = await imdbToTmdb('movie', 'tt9999999');
check('no TMDB id and no API key stays unresolved', () => assert.equal(unresolved, null));

process.env.TMDB_API_KEY = 'test-key';
const fallback = await imdbToTmdb('movie', 'tt8888888');
check('TMDB /find is used as a fallback when an API key is set', () => {
  assert.equal(fallback.tmdbId, '555');
  assert.equal(fallback.via, 'tmdb');
});
delete process.env.TMDB_API_KEY;

console.log(`\n${passed} checks passed\n`);
