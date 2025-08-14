// index.js
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
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
  version: "1.6.2",
  name: "AutoStream",
  description:
    "AutoStream picks the best stream for each title, balancing quality with speed (seeders). If a lower resolution like 1080p or 720p is much faster than 4K/2K, it’s preferred for smoother playback. You’ll usually see one link; when helpful, a second 1080p option appears. Titles are neat (e.g., “Movie Name — 1080p”).",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"],
  logo: "https://raw.githubusercontent.com/keypop3750/autostream-addon/main/logo.png",
  behaviorHints: { configurable: true, configurationRequired: false },
  // (claim token left as-is)
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
function displayTag(tag) {
  if (tag === "2160p") return "4K";
  if (tag === "1440p") return "2K";
  return tag; // 1080p / 720p / SD / CAM
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
// Speed-aware rank
function rankStream(st) {
  const label = combinedLabel(st);
  const qTag  = qualityTag(label);
  const q     = qualityScoreFromTag(qTag);
  const seeds = extractSeeders(st);
  const speed = Math.log1p(seeds) * 200;
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
  const ratio = sHigh ? sLow / sHigh : Infinity;
  const delta = sLow - sHigh;
  if (rule === "ratio_or_delta") return ratio >= ratioNeed || delta >= deltaNeed;
  return ratio >= ratioNeed && delta >= deltaNeed;
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
      // Make it substantially harder for 1080p to replace 4K/2K:
      localPref.prefer1080_ratio = Math.max(localPref.prefer1080_ratio, 3.5);
      localPref.prefer1080_delta = Math.max(localPref.prefer1080_delta, 1000);
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
        isMuchFaster(best720, curated, localPref.prefer720_ratio, localPref.prefer720_delta, localPref.prefer_rule)) {
      curated = best720;
    }

    // Build clean display title + provider label (with user-friendly tags)
    const niceName = await getDisplayLabel(type, id);
    const makeCleanWithQ = (st) => {
      const qTag = qualityTag(combinedLabel(st));
      const clean = `${niceName} — ${displayTag(qTag)}`;
      const normalized = normalizeForResolver(st);
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

// ── Configure page (like Torrentio) ───────────────────────────────────────────
const PORT = process.env.PORT || 7000;
const app = express();
app.use(express.urlencoded({ extended: true }));

// Simple builder for a Torrentio URL from choices
function buildTorrentioUrl({ provider = "alldebrid", cached = true, apikey = "" }) {
  // provider slug
  const prov = (provider || "alldebrid").toLowerCase();
  const pathSlug =
    prov.includes("real") ? "real-debrid" :
    prov.includes("prem") ? "premiumize" : "alldebrid";
  const params = [];
  if (cached) params.push("cached=true");
  params.push("exclude=cam,ts", "audio=english", "sort=seeders");
  if (apikey) params.push("apikey=" + encodeURIComponent(apikey)); // best-effort
  return `https://torrentio.strem.fun/${pathSlug}|${params.join("&")}`;
}

// Neat, centered Configure form
const FORM_HTML = `
<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>AutoStream — Configure</title>
<style>
  :root { color-scheme: dark; }
  body{margin:0;background:#0d0e16;color:#e8e8f4;font:16px/1.45 system-ui,Segoe UI,Roboto,Helvetica,Arial}
  .wrap{max-width:860px;margin:48px auto;padding:0 20px}
  h1{font-size:28px;margin:0 0 20px}
  .card{background:#121427;border:1px solid #1c1f3a;border-radius:14px;padding:22px}
  .row{display:flex;gap:14px;align-items:center;margin:12px 0}
  label{min-width:220px;opacity:.9}
  select,input[type=text]{flex:1;padding:.7rem .8rem;border-radius:10px;border:1px solid #2b2f55;background:#171a31;color:#eef}
  .check{display:flex;align-items:center;gap:12px}
  input[type=checkbox]{width:18px;height:18px}
  .btn{display:block;width:100%;margin-top:16px;padding:14px 18px;border-radius:12px;border:1px solid #2b2f55;background:#191c36;color:#fff;text-decoration:none;text-align:center}
  .btn:hover{background:#1f2345}
  code{background:#171a31;border:1px solid #2b2f55;border-radius:8px;padding:3px 7px}
  small{opacity:.7}
</style>
<div class="wrap">
  <h1>AutoStream — Configure</h1>
  <div class="card">
    <form method="POST" action="/configure">
      <div class="row">
        <label>Debrid provider</label>
        <select name="provider">
          <option>AllDebrid</option>
          <option>RealDebrid</option>
          <option>Premiumize</option>
        </select>
      </div>

      <div class="row check">
        <input id="cached" type="checkbox" name="cached" checked />
        <label for="cached">Prefer cached links (Debrid)</label>
      </div>

      <div class="row">
        <label>Debrid API key (optional)</label>
        <input type="text" name="apikey" placeholder="Paste your provider’s API key (if required)" />
      </div>

      <button class="btn" type="submit">Install in Stremio</button>
    </form>
    <p><small>
      The installer creates a personalized link like
      <code>/manifest.json?cfg=…</code>. Your key is only encoded inside the link and is not stored
      on this server.
    </small></p>
  </div>
</div>
`;

// GET configure (also use it for "/")
app.get("/", (_, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(FORM_HTML); });
app.get("/configure", (_, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(FORM_HTML); });

// POST configure → build cfg + show install link
app.post("/configure", (req, res) => {
  const provider = String(req.body.provider || "AllDebrid");
  const cached = !!req.body.cached;
  const apikey = String(req.body.apikey || "").trim();

  const torrentio = buildTorrentioUrl({ provider, cached, apikey });
  const cfg = b64u.enc({ torrentio });

  const origin = `${req.protocol}://${req.get("host")}`;
  const install = `${origin}/manifest.json?cfg=${cfg}`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
  <!doctype html>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>AutoStream — Install Link</title>
  <style>
    :root{color-scheme:dark}
    body{margin:0;background:#0d0e16;color:#e8e8f4;font:16px/1.45 system-ui,Segoe UI,Roboto,Helvetica,Arial}
    .wrap{max-width:860px;margin:48px auto;padding:0 20px}
    .card{background:#121427;border:1px solid #1c1f3a;border-radius:14px;padding:22px}
    code{display:block;word-break:break-all;background:#171a31;border:1px solid #2b2f55;border-radius:8px;padding:10px;margin:12px 0}
    a.btn{display:inline-block;padding:12px 16px;border-radius:10px;border:1px solid #2b2f55;background:#191c36;color:#fff;text-decoration:none}
    a.btn:hover{background:#1f2345}
  </style>
  <div class="wrap">
    <div class="card">
      <h2>Your personalized install link</h2>
      <code>${install}</code>
      <p>In Stremio → Add-ons → <b>Install via URL</b>, paste the link above.</p>
      <p><a class="btn" href="/configure">Back</a></p>
    </div>
  </div>`);
});

// Mount the Stremio addon interface (must be after our routes so /configure works)
const addonRouter = getRouter(builder.getInterface());
app.use(addonRouter);

// Start server
app.listen(PORT, () => {
  console.log(`AutoStream add-on running on port ${PORT} → /manifest.json`);
  console.log("Primary sources:", SOURCES);
  console.log("Fallback sources:", FALLBACK_SOURCES);
  console.log("Lower-quality prefs:", PREF);
});
