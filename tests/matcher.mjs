/**
 * Title normalizer, sequel guard, year tolerance, season 0 specials, and
 * media link quality/size extraction tests (pure unit tests, zero network).
 */

import {
  titleTokens,
  matchPost,
  choosePost,
  seasonNumberOf,
  episodeNumberOf,
  pickMediaLinks,
  providerPayload,
} from "../server/providers/vega.js";
import { normalizeStream } from "../server/providers/types.js";

const check = (name, cond, detail = "") => {
  if (!cond) {
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  } else {
    console.log(`  ok    ${name}`);
  }
};

console.log("\n[1] Title tokens & release noise filtering");
check(
  "strips codecs, resolutions, audio tags, and release groups",
  JSON.stringify(titleTokens("Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv")) ===
    '["dune","two","flux"]' ||
    titleTokens("The.Matrix.1999.2160p.UHD.BluRay.x265.10bit.HDR.Dual.Audio-PSA").join(" ") === "matrix",
);

console.log("\n[2] Title matching & sequel rejection");
check(
  "matches noisy torrent release title with matching year",
  matchPost({ title: "The Dark Knight", year: 2008 }, "The Dark Knight (2008) 1080p BluRay x265 HEVC").ok === true,
);
check(
  "rejects sequel when searching original without sequel word",
  matchPost({ title: "The Dark Knight", year: 2008 }, "The Dark Knight Rises 1080p BluRay").ok === false,
);
check(
  "rejects wrong year remake when enforceYear is true",
  matchPost({ title: "Total Recall", year: 1990 }, "Total Recall (2012) 1080p BluRay").ok === false,
);

const chosen = choosePost(
  { title: "Game of Thrones", year: 2011, season: 2, enforceYear: false },
  [
    { title: "Game of Thrones Season 1 Complete 1080p", link: "/s1" },
    { title: "Game of Thrones Season 2 Complete 1080p", link: "/s2" },
  ],
);
check("choosePost prefers matching season when multiple seasons match", chosen.chosen?.link === "/s2");

console.log("\n[3] Specials (season 0) & episode extraction");
check("'Specials' maps to season 0", seasonNumberOf("Specials") === 0);
check("'S00E01' maps to season 0, episode 1", seasonNumberOf("S00E01") === 0 && episodeNumberOf("S00E01") === 1);

const specialPick = pickMediaLinks(
  {
    type: "series",
    linkList: [
      { title: "Specials", directLinks: [{ title: "Episode 1", link: "https://ex/sp1" }] },
      { title: "Season 1", directLinks: [{ title: "Episode 1", link: "https://ex/s1e1" }] },
    ],
  },
  0,
  1,
);
check("pickMediaLinks selects season 0 entry for specials", specialPick[0]?.link === "https://ex/sp1");

console.log("\n[4] 4KHDHub quality/size/release tag propagation");
const movieLinks = pickMediaLinks({
  type: "movie",
  linkList: [
    {
      title: "The.Matrix.1999.2160p.UHD.BluRay.REMUX.DV.HEVC.Atmos-FGT [42.5 GB]",
      quality: "2160p",
      directLinks: [{ title: "HubCloud", link: "https://hubcloud.example/drive/abc" }],
    },
  ],
});
check(
  "pickMediaLinks preserves parent quality & release title onto flattened directLinks",
  movieLinks[0]?.quality === "2160p",
);

const norm = normalizeStream(
  {
    server: "PixelServer",
    link: "https://pixel.example/The.Matrix.2160p.mkv",
    type: "mkv",
    title: movieLinks[0].title,
  },
  "4khdhub",
);
check(
  "normalizeStream extracts quality=2160, size=42.5 GB, and Remux/DV/HEVC/Atmos tags",
  norm.quality === "2160" && norm.size === "42.5 GB" && norm.detail.includes("Remux"),
  JSON.stringify(norm),
);

console.log("\n[5] providerPayload separates numeric tmdbId from tt... imdbId");
const pFromImdbOnly = JSON.parse(
  providerPayload({ tmdbId: "tt0133093", imdbId: "tt0133093", type: "series", season: 0, episode: 2 }),
);
check(
  "providerPayload never puts tt... in tmdbId and preserves season 0",
  pFromImdbOnly.tmdbId === undefined && pFromImdbOnly.imdbId === "tt0133093" && pFromImdbOnly.season === 0,
);
