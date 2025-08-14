// index.js
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const fs = require("fs");
const path = require("path");

// ── Load config.json (defaults you ship with the addon) ───────────────────────
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

// ── Manifest with native config (adds a Configure button in Stremio) ─────────
const manifest = {
  id: "org.autostream.best",
  version: "1.7.0",
  name: "AutoStream",
  description:
    "AutoStream picks the best stream for each title, balancing quality with speed (seeders). If 1080p/720p is much faster than 4K/2K, it can win for smoother playback. Usually you’ll see one link; when helpful, a second 1080p option appears. Titles are clean (e.g., “Movie Name — 1080p”).",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"],
  logo: "https://raw.githubusercontent.com/keypop3750/autostream-addon/main/logo.png",

  // Native configuration:
  behaviorHints: {
    configurable: true,            // shows "Configure" button
    configurationRequired: false   // addon still works without config
  },

  // Stremio auto-generates /configure from this:
  config: [
    {
      key: "debrid",
      title: "Debrid provider",
      type: "select",
      options: ["none", "alldebrid", "real-debrid", "premiumize"],
      default: "none",
      required: false
    },
    {
      key: "cached",
      title: "Prefer cached links (Debrid)",
      type: "checkbox",
      default: true,
      required: false
    },
    {
      key: "params",
      title: "Advanced Torrentio params (optional)",
      type: "text",
      default: "exclude=cam,ts&audio=english&sort=seeders",
      required: false
    },
    {
      key: "customSource",
      title: "Custom source URL (optional, overrides above)",
      type: "text",
      required: false
    }
  ],

  // your signed block (kept as-is)
  stremioAddonsConfig: {
    issuer: "https://stremio-addons.net",
    signature:
      "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..KPt7fOiOCod52ZjlFWg52A.dt7eIyal-1oAkU4cOG5c6YPsWn70Ds6AXqY1FJX3Ikqzzeu1gzgj2_xO4e4zh7gsXEyjhoAJ-L9Pg6UI57XD6FWjzpRcvV0v-6WuKmfZO_hDcDIrtVQnFf0nK2dnO7-n.v25_jaY5E-4yH_cxyTKfsA"
  }
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
  const speed = Math.log1p(seeds) * 200; // tweak if needed
  return q + speed + preferenceBonus(label);
}

// Prefer magnets so resolvers (e.g., Debrid) can catch them
const COMMON_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce"
];
function buildMagnet(st) {
  if (typeof st.magnet === "string" && st.magnet.startsWith("magnet:")) return st.magnet;
  const infoHash = st.infoHash || st.infohash || st.hash;
  if (!infoHash) return null;
  const dn = encodeURIComponent((st.title || st.name || "AutoStream").replace(/\s+/g, " "));
  const tr = COMMON_TRACKERS.map(t => "&tr=" + encodeURIComponent(t)).join("");
  return `magnet:?xt=urn:btih:${infoHash}&dn=${dn}${tr}`;
}
function normalizeForResolver(st) {
  const magnet = buildMagnet(st);
  const url = magnet || st.url || st.externalUrl || null;
  return {
    ...st,
    url,
    magnet: magnet || st.magnet,
    behaviorHints: { ...(st.behaviorHints || {}), notWebReady: false }
  };
}

// ── Upstreams ────────────────────────────────────────────────────────────────
async function fetchFromSource(baseUrl, type, id) {
  const url = `${baseUrl}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
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
    const res = await fetch(metaUrl, { headers: { Accept: "application/json" } });
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

// ── Helpers for user config → sources ────────────────────────────────────────
function isDebridEndpoint(u) {
  return /alldebrid|real-?debrid|premiumize/i.test(String(u || ""));
}
function sourcesFromUserConfig(cfg) {
  const list = [...SOURCES];
  const custom = (cfg && typeof cfg.customSource === "string" && cfg.customSource.trim()) || "";
  if (custom && /^https?:\/\//i.test(custom)) {
    // user-provided full endpoint wins
    list.unshift(custom.trim());
    return list;
  }
  const debrid = (cfg?.debrid || "none").toLowerCase();
  if (debrid !== "none") {
    const params = String(cfg?.params || "exclude=cam,ts&audio=english&sort=seeders").replace(/^\|/, "");
    const cached = cfg?.cached ? "cached=true&" : "";
    const ti = `https://torrentio.strem.fun/${debrid}|${cached}${params}`;
    list.unshift(ti);
  }
  return list;
}

// ── Prefer lower quality if MUCH faster (configurable) ────────────────────────
function isMuchFaster(lower, higher, ratioNeed, deltaNeed, rule = PREF.prefer_rule) {
  const sLow  = extractSeeders(lower);
  const sHigh = extractSeeders(higher);
  const ratio = sHigh ? sLow / sHigh : Infinity; // if higher has 0 seeds, lower wins
  const delta = sLow - sHigh;
  if (rule === "ratio_or_delta") return ratio >= ratioNeed || delta >= deltaNeed;
  return ratio >= ratioNeed && delta >= deltaNeed;
}
function bestOfQuality(cands, wantedTag) {
  const filtered = cands.filter(st => qualityTag(combinedLabel(st)) === wantedTag);
  return filtered.length ? filtered.sort((a, b) => rankStream(b) - rankStream(a))[0] : null;
}

// ── Main handler ──────────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ type, id, config: userCfg }) => {
  try {
    // Build sources from user's native config (if any)
    const usedSources = sourcesFromUserConfig(userCfg || {});
    let candidates = await collectStreams(usedSources, type, id);
    if (candidates.length === 0) {
      console.log("No primary results; trying fallback sources …");
      candidates = await collectStreams(FALLBACK_SOURCES, type, id);
    }
    if (candidates.length === 0) return { streams: [] };

    // If user selected a Debrid preset, bias toward 4K/2K (harder for 1080p to replace)
    const debridPreferred = usedSources.some(isDebridEndpoint) || ((userCfg?.debrid || "none") !== "none");
    const localPref = { ...PREF };
    if (debridPreferred) {
      // Keep high-res more often when Debrid is in play:
      localPref.prefer1080_ratio = Math.max(localPref.prefer1080_ratio, 3.5);
      localPref.prefer1080_delta = Math.max(localPref.prefer1080_delta, 1000);
      // 720p rule unchanged
    }

    // Initial curated pick by composite rank
    let curated = candidates.slice().sort((a, b) => rankStream(b) - rankStream(a))[0];

    // Find best per bucket
    const best2160 = bestOfQuality(candidates, "2160p");
    const best1440 = bestOfQuality(candidates, "1440p");
    const best1080 = bestOfQuality(candidates, "1080p");
    const best720  = bestOfQuality(candidates, "720p");

    // Debug (optional)
    console.log(
      "Seeds — 2160:", best2160 && extractSeeders(best2160),
      "1440:", best1440 && extractSeeders(best1440),
      "1080:", best1080 && extractSeeders(best1080),
      "720:",  best720  && extractSeeders(best720),
      "DebridPreferred:", debridPreferred
    );

    // Hierarchical “prefer lower if MUCH faster”
    const curTagA = qualityTag(combinedLabel(curated));
    if ((curTagA === "2160p" || curTagA === "1440p") && best1080 &&
        isMuchFaster(best1080, curated, localPref.prefer1080_ratio, localPref.prefer1080_delta, localPref.prefer_rule)) {
      curated = best1080;
    }
    const curTagB = qualityTag(combinedLabel(curated));
    if (curTagB === "1080p" && best720 &&
        isMuchFaster(best720, curated, localPref.prefer720_ratio, localPref.prefer720_delta, localPref.prefer_rule)) {
      curated = best720;
    }

    // Build clean display title + provider label
    const niceName = await getDisplayLabel(type, id);
    const makeCleanWithQ = (st) => {
      const qTag = qualityTag(combinedLabel(st));
      const clean = `${niceName} — ${qTag}`;
      const normalized = normalizeForResolver(st); // prefer magnet
      return {
        obj: {
          ...normalized,
          title: clean,
          name: "AutoStream",
          behaviorHints: { ...(normalized.behaviorHints || {}), bingeGroup: id }
        },
        qScore: qualityScoreFromTag(qTag),
        rank: rankStream(st)
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
    const sorted = out.sort((a, b) => b.qScore - a.qScore || b.rank - a.rank).map(x => x.obj);

    return { streams: sorted };
  } catch (err) {
    console.error("AutoStream error:", err);
    return { streams: [] };
  }
});

// ── Serve with Express Router provided by SDK (includes /configure) ──────────
const PORT = process.env.PORT || 7000;
const app = express();
const router = getRouter(builder.getInterface());
app.use(router);

app.listen(PORT, () => {
  console.log(`AutoStream add-on running on port ${PORT} → /manifest.json`);
  console.log("Primary sources:", SOURCES);
  console.log("Fallback sources:", FALLBACK_SOURCES);
  console.log("Lower-quality prefs (base):", PREF);
});
