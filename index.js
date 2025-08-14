// index.js
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fs = require("fs");
const path = require("path");

// ── Load config ───────────────────────────────────────────────────────────────
let config;
try {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
} catch (e) {
  console.error("Failed to read config.json:", e);
  process.exit(1);
}
const SOURCES = Array.isArray(config.sources) ? config.sources : [];
const FALLBACK_SOURCES = Array.isArray(config.fallback_sources) ? config.fallback_sources : [];
const PREF = Object.assign(
  {
    // prefer_rule: "ratio_and_delta" | "ratio_or_delta"
    prefer_rule: "ratio_and_delta",
    prefer1080_ratio: 2.0,
    prefer1080_delta: 500,
    prefer720_ratio: 3.0,
    prefer720_delta: 1000
  },
  config.prefer_lower_quality || {}
);

// ── Manifest ──────────────────────────────────────────────────────────────────
const manifest = {
  id: "org.autostream.best",
  version: "1.5.0",
  name: "AutoStream",
  description:
    "AutoStream picks the best stream for each title, "\
    + "balancing quality with speed (seeders). If a lower resolution like 1080p or 720p is much faster than 4K, "\
    + "it’ll prefer that for smoother playback. You’ll usually see one link; when helpful, a second 1080p option appears. "\
    + "Titles are clean (e.g., “Movie Name — 1080p”).",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"],
  // 👇 Use the RAW GitHub URL (must end with .png)
  logo: "https://github.com/keypop3750/autostream-addon/blob/b7c9352666d6241456d8b5a1b69d2b649b06c558/logo.png"
};
const builder = new addonBuilder(manifest);

// ── Helpers: quality / labels / seeders / ranking ────────────────────────────
function qualityTag(label) {
  const s = (label || "").toLowerCase();
  if (s.includes("2160") || s.includes("4k") || s.includes("uhd")) return "2160p";
  if (s.includes("1440") || s.includes("2k")) return "1440p";
  if (s.includes("1080")) return "1080p";
  if (s.includes("720"))  return "720p";
  if (s.includes("480"))  return "480p";
  if (s.includes("cam"))  return "CAM";
  return "SD";
}
function qualityScoreFromTag(tag) {
  switch (tag) {
    case "2160p": return 4000;
    case "1440p": return 1440;
    case "1080p": return 1080;
    case "720p":  return 720;
    case "480p":  return 480;
    case "CAM":   return 10;
    default:      return 360;
  }
}
function is1080pLabel(label) { return qualityTag(label) === "1080p"; }
function combinedLabel(st) { return [st.title, st.name, st.description].filter(Boolean).join(" "); }

// Try to read seeders; also attempt a light regex parse from text if needed
function extractSeeders(st) {
  if (typeof st.seeders === "number") return st.seeders;
  if (typeof st.seeds === "number")   return st.seeds;
  const text = combinedLabel(st);
  const m =
    /\b(\d{2,6})\s*(?:seed(?:ers)?|seeds|s:|se:)/i.exec(text) ||
    /\[(\d{2,6})\s*seeds?\]/i.exec(text) ||
    /\bseeds?\s*[:\-]?\s*(\d{2,6})\b/i.exec(text);
  return m ? parseInt(m[1], 10) : 0;
}

function preferenceBonus(label) {
  const s = (label || "").toLowerCase();
  let bonus = 0;
  ["webdl","webrip","blu","bluray","remux"].forEach(t => { if (s.includes(t)) bonus += 30; });
  ["real-debrid","rd","premiumize","alldebrid","ad","pm"].forEach(t => { if (s.includes(t)) bonus += 20; });
  if (s.includes("hevc") || s.includes("x265")) bonus += 10;
  return bonus;
}

// Speed-aware rank: strong seeders bias so well-seeded lower quality can win
function rankStream(st) {
  const label = combinedLabel(st);
  const qTag  = qualityTag(label);
  const q     = qualityScoreFromTag(qTag);
  const seeds = extractSeeders(st);
  const speed = Math.log1p(seeds) * 200; // adjust weight here if desired
  return q + speed + preferenceBonus(label);
}

// ── Fetch from upstreams ──────────────────────────────────────────────────────
async function fetchFromSource(baseUrl, type, id) {
  const url = `${baseUrl}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) { console.error("Upstream error:", baseUrl, res.status); return []; }
  const data = await res.json();
  const list = Array.isArray(data.streams) ? data.streams : [];
  return list.map(st => ({ ...st, __source: baseUrl }));
}
async function collectStreams(sources, type, id) {
  const all = [];
  for (const src of sources) {
    try { all.push(...await fetchFromSource(src, type, id)); }
    catch (e) { console.error("Source failed:", src, e); }
  }
  // dedupe
  const seen = new Set();
  const unique = [];
  for (const st of all) {
    const key = st.url || st.externalUrl || st.magnet || st.infoHash || JSON.stringify(st);
    if (!seen.has(key)) { seen.add(key); unique.push(st); }
  }
  return unique;
}

// ── Cinemeta nice names ───────────────────────────────────────────────────────
async function getDisplayLabel(type, id) {
  try {
    const [imdb, sStr, eStr] = id.split(":");
    const metaUrl = `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(imdb)}.json`;
    const res = await fetch(metaUrl, { headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error(`Cinemeta ${res.status}`);
    const data = await res.json();
    const title = data?.meta?.name || data?.meta?.title || imdb;

    if (type === "movie" || !sStr || !eStr) return title;

    const season = parseInt(sStr, 10);
    const episode = parseInt(eStr, 10);
    const ep = Array.isArray(data?.meta?.videos)
      ? data.meta.videos.find(v => {
          if (!v?.id) return false;
          const parts = String(v.id).split(":");
          return parts[1] == String(season) && parts[2] == String(episode);
        })
      : null;

    const epTitle = ep?.title || `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
    return `${title} — ${epTitle}`;
  } catch (e) {
    console.warn("Cinemeta lookup failed:", e?.message || e);
    return id;
  }
}

// ── Prefer lower quality if MUCH faster (configurable) ────────────────────────
function isMuchFaster(lower, higher, ratioNeed, deltaNeed) {
  const sLow  = extractSeeders(lower);
  const sHigh = extractSeeders(higher);
  const ratio = sHigh ? sLow / sHigh : Infinity; // if higher has 0 seeds, lower wins
  const delta = sLow - sHigh;
  if (PREF.prefer_rule === "ratio_or_delta") return ratio >= ratioNeed || delta >= deltaNeed;
  return ratio >= ratioNeed && delta >= deltaNeed; // default: both
}

function bestOfQuality(cands, wantedTag) {
  const filtered = cands.filter(st => qualityTag(combinedLabel(st)) === wantedTag);
  return filtered.length ? filtered.sort((a,b) => rankStream(b) - rankStream(a))[0] : null;
}

// ── Main handler ──────────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ type, id }) => {
  try {
    // Collect from primary then fallback
    let candidates = await collectStreams(SOURCES, type, id);
    if (candidates.length === 0) {
      console.log("No primary results; trying fallback sources …");
      candidates = await collectStreams(FALLBACK_SOURCES, type, id);
    }
    if (candidates.length === 0) return { streams: [] };

    // Initial curated pick by composite rank
    let curated = candidates.slice().sort((a,b) => rankStream(b) - rankStream(a))[0];

    // Find best per bucket
    const best2160 = bestOfQuality(candidates, "2160p");
    const best1440 = bestOfQuality(candidates, "1440p");
    const best1080 = bestOfQuality(candidates, "1080p");
    const best720  = bestOfQuality(candidates, "720p");

    // Debug (optional)
    console.log("Seeds — 2160:", best2160 && extractSeeders(best2160),
                "1440:", best1440 && extractSeeders(best1440),
                "1080:", best1080 && extractSeeders(best1080),
                "720:",  best720  && extractSeeders(best720));

    // ── Hierarchical “prefer lower if much faster” ────────────────────────────
    // Step A: If curated is 4K/2K, allow a MUCH-faster 1080p to take over.
    const curTagA = qualityTag(combinedLabel(curated));
    if ((curTagA === "2160p" || curTagA === "1440p") && best1080 &&
        isMuchFaster(best1080, curated, PREF.prefer1080_ratio, PREF.prefer1080_delta)) {
      curated = best1080;
    }

    // Step B: Only if curated is 1080p, allow a MUCH-faster 720p to take over.
    const curTagB = qualityTag(combinedLabel(curated));
    if (curTagB === "1080p" && best720 &&
        isMuchFaster(best720, curated, PREF.prefer720_ratio, PREF.prefer720_delta)) {
      curated = best720;
    }

    // Build clean display title + provider label
    const niceName = await getDisplayLabel(type, id);
    const makeCleanWithQ = (st) => {
      const qTag = qualityTag(combinedLabel(st));
      const clean = `${niceName} — ${qTag}`;
      return {
        obj: {
          ...st,
          title: clean,          // row title (no WEBRip/AMZN/etc)
          name: "AutoStream",    // provider label in list
          behaviorHints: { ...(st.behaviorHints || {}), bingeGroup: id }
        },
        qScore: qualityScoreFromTag(qTag), // for sorting high→low
        rank:  rankStream(st)
      };
    };

    // Decide which to return:
    const out = [];
    const curatedPack = makeCleanWithQ(curated);
    out.push(curatedPack);

    // If curated isn't 1080p AND we have a best1080, include it as a second option
    if (!is1080pLabel(combinedLabel(curated)) && best1080) {
      const keyA = curated.url || curated.externalUrl || curated.magnet || curated.infoHash;
      const keyB = best1080.url || best1080.externalUrl || best1080.magnet || best1080.infoHash;
      if (!keyA || !keyB || keyA !== keyB) out.push(makeCleanWithQ(best1080));
    }

    // Sort by quality (highest first). If equal quality, sort by rank desc.
    const sorted = out.sort((a,b) => b.qScore - a.qScore || b.rank - a.rank).map(x => x.obj);

    return { streams: sorted };
  } catch (err) {
    console.error("AutoStream error:", err);
    return { streams: [] };
  }
});

// ── Serve (cloud-friendly) ────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`AutoStream add-on running on port ${PORT} → /manifest.json`);
console.log("Primary sources:", SOURCES);
console.log("Fallback sources:", FALLBACK_SOURCES);
console.log("Lower-quality prefs:", PREF);
