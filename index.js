// index.js
const { addonBuilder } = require("stremio-addon-sdk");
const express = require("express");
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
  version: "1.6.1",
  name: "AutoStream",
  description:
    "AutoStream picks the best stream for each title, balancing quality with speed (seeders). If a lower resolution like 1080p or 720p is much faster than 4K/2K, it’s preferred for smoother playback. You’ll usually see one link; when helpful, a second 1080p option appears. Titles are neat (e.g., “Movie Name — 1080p”).",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"],
  logo: "https://raw.githubusercontent.com/keypop3750/autostream-addon/main/logo.png",
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
  if (s.includes("720")) return "720p";
  if (s.includes("480")) return "480p";
  if (s.includes("cam")) return "CAM";
  return "SD";
}
function qualityScoreFromTag(tag) {
  switch (tag) {
    case "2160p": return 4000;
    case "1440p": return 1440;
    case "1080p": return 1080;
    case "720p": return 720;
    case "480p": return 480;
    case "CAM": return 10;
    default: return 360;
  }
}
function is1080pLabel(label) { return qualityTag(label) === "1080p"; }
function combinedLabel(st) { return [st.title, st.name, st.description].filter(Boolean).join(" "); }

// Try to read seeders; also attempt a light regex parse from text if needed
function extractSeeders(st) {
  if (typeof st.seeders === "number") return st.seeders;
  if (typeof st.seeds === "number") return st.seeds;
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

// ── Fetch from upstreams ──────────────────────────────────────────────────────
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

// ── Per-user config via base64url token (stateless) ───────────────────────────
const b64u = {
  enc: (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url"),
  dec: (str) => JSON.parse(Buffer.from(String(str || ""), "base64url").toString("utf8"))
};

// Detect debrid endpoints in source URLs
function isDebridEndpoint(u) {
  return /alldebrid|real-?debrid|premiumize/i.test(String(u || ""));
}

// Merge per-request sources (cfg first, then defaults)
function resolveSources(extra) {
  try {
    if (extra && extra.cfg) {
      const cfg = b64u.dec(extra.cfg);
      if (cfg && typeof cfg.torrentio === "string" && /^https?:\/\//i.test(cfg.torrentio)) {
        return [cfg.torrentio, ...SOURCES];
      }
    }
  } catch (_) {}
  return SOURCES;
}

// ── Prefer lower quality if MUCH faster (configurable) ────────────────────────
function isMuchFaster(lower, higher, ratioNeed, deltaNeed, rule = PREF.prefer_rule) {
  const sLow  = extractSeeders(lower);
  const sHigh = extractSeeders(higher);
  const ratio = sHigh ? sLow / sHigh : Infinity; // if higher has 0 seeds, lower wins
  const delta = sLow - sHigh;
  if (rule === "ratio_or_delta") return ratio >= ratioNeed || delta >= deltaNeed;
  return ratio >= ratioNeed && delta >= deltaNeed; // default: both
}
function bestOfQuality(cands, wantedTag) {
  const filtered = cands.filter(st => qualityTag(combinedLabel(st)) === wantedTag);
  return filtered.length ? filtered.sort((a, b) => rankStream(b) - rankStream(a))[0] : null;
}

// ── Main handler ──────────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ type, id, extra }) => {
  try {
    // Resolve sources for this request (cfg → defaults)
    const usedSources = resolveSources(extra);
    let candidates = await collectStreams(usedSources, type, id);
    if (candidates.length === 0) {
      console.log("No primary results; trying fallback sources …");
      candidates = await collectStreams(FALLBACK_SOURCES, type, id);
    }
    if (candidates.length === 0) return { streams: [] };

    // Adjust thresholds if using a debrid endpoint (keep 4K/2K more often)
    const debridPreferred = usedSources.some(isDebridEndpoint);
    const localPref = { ...PREF };
    if (debridPreferred) {
      // Make it harder for 1080p to replace 4K/2K:
      localPref.prefer1080_ratio = Math.max(localPref.prefer1080_ratio, 2.5);
      localPref.prefer1080_delta = Math.max(localPref.prefer1080_delta, 150);
      // leave 720p logic as-is
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
      "720:", best720 && extractSeeders(best720),
      "DebridPreferred:", debridPreferred
    );

    // ── Hierarchical “prefer lower if much faster” ────────────────────────────
    // Step A: If curated is 4K/2K, only switch to 1080p if it's MUCH faster.
    const curTagA = qualityTag(combinedLabel(curated));
    if ((curTagA === "2160p" || curTagA === "1440p") && best1080 &&
        isMuchFaster(best1080, curated, localPref.prefer1080_ratio, localPref.prefer1080_delta, localPref.prefer_rule)) {
      curated = best1080;
    }

    // Step B: Only if curated is 1080p, allow a MUCH-faster 720p to take over.
    const curTagB = qualityTag(combinedLabel(curated));
    if (curTagB === "1080p" && best720 &&
        (best720, curated, localPref.prefer720_ratio, localPref.prefer720_delta, localPref.prefer_rule)) {
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

// ── Serve (cloud-friendly) with config UI ─────────────────────────────────────
const PORT = process.env.PORT || 7000;
const app = express();
app.use(express.urlencoded({ extended: true }));

// Configurator UI
app.get("/", (_, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,Segoe UI,Helvetica,Arial;margin:2rem;max-width:720px;color:#eee;background:#0d0e16}
  input,button{font:inherit;padding:.6rem .8rem;border-radius:.6rem;border:1px solid #333;background:#16182a;color:#eee;width:100%}
  code{background:#16182a;padding:.2rem .4rem;border-radius:.4rem}
  a{color:#b395ff}
</style>
<h1>AutoStream – Configure (optional)</h1>
<p>Paste your <b>Torrentio (Debrid)</b> endpoint (from the Torrentio configurator), e.g.</p>
<p><code>https://torrentio.strem.fun/alldebrid|cached=true&exclude=cam,ts&audio=english&sort=seeders</code></p>
<form method="POST" action="/setup">
  <p><input name="torrentio" placeholder="https://torrentio.strem.fun/alldebrid|cached=true&..."></p>
  <p><button type="submit">Generate Install Link</button></p>
</form>
<p><small>Your personalized link encodes the URL inside <code>cfg</code>. Nothing is stored on the server. Don’t share the link if you want to keep it private.</small></p>
  `);
});

app.post("/setup", (req, res) => {
  const t = String(req.body.torrentio || "").trim();
  if (!/^https?:\/\/.+/i.test(t)) {
    res.status(400).send("Invalid URL");
    return;
  }
  const cfg = b64u.enc({ torrentio: t });
  const install = `${req.protocol}://${req.get("host")}/manifest.json?cfg=${cfg}`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
<h2>Install your personalized AutoStream</h2>
<p>In Stremio → Add-ons → <b>Install via URL</b>, paste this link:</p>
<p><a href="${install}"><code>${install}</code></a></p>
<p><small>Keep this URL if you want to reinstall later.</small></p>
  `);
});

// Mount the Stremio addon interface
const addonInterface = builder.getInterface();

app.get("/manifest.json", addonInterface.manifest);
app.get("/stream/:type/:id.json", addonInterface.get);
app.post("/stream/:type/:id.json", addonInterface.post);


// Start server
app.listen(PORT, () => {
  console.log(`AutoStream add-on running on port ${PORT} → /manifest.json`);
  console.log("Primary sources:", SOURCES);
  console.log("Fallback sources:", FALLBACK_SOURCES);
  console.log("Lower-quality prefs:", PREF);
});
