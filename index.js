// index.js
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const fs = require("fs");
const path = require("path");

// ── Load server defaults from config.json ─────────────────────────────────────
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

// ── Manifest with native config ───────────────────────────────────────────────
const manifest = {
  id: "org.autostream.best",
  version: "1.7.1",
  name: "AutoStream",
  description:
    "AutoStream picks the best stream for each title, balancing quality with speed (seeders). If 1080p/720p is much faster than 4K/2K, it can win for smoother playback. Usually one link; when helpful, a second 1080p option appears. Titles are clean (e.g., “Movie — 1080p”).",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"],
  logo: "https://raw.githubusercontent.com/keypop3750/autostream-addon/main/logo.png",

  behaviorHints: {
    configurable: true,
    configurationRequired: false
  },

  // Shown in Stremio's Configure UI
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

  stremioAddonsConfig: {
    issuer: "https://stremio-addons.net",
    signature:
      "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..KPt7fOiOCod52ZjlFWg52A.dt7eIyal-1oAkU4cOG5c6YPsWn70Ds6AXqY1FJX3Ikqzzeu1gzgj2_xO4e4zh7gsXEyjhoAJ-L9Pg6UI57XD6FWjzpRcvV0v-6WuKmfZO_hDcDIrtVQnFf0nK2dnO7-n.v25_jaY5E-4yH_cxyTKfsA"
  }
};

const builder = new addonBuilder(manifest);

// ── Helpers: quality / seeders / ranking ─────────────────────────────────────
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
function displayQuality(tag) {
  if (tag === "2160p") return "4K";
  if (tag === "1440p") return "2K";
  return tag;
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
function rankStream(st) {
  const label = combinedLabel(st);
  const qTag  = qualityTag(label);
  const q     = qualityScoreFromTag(qTag);
  const seeds = extractSeeders(st);
  const speed = Math.log1p(seeds) * 200;
  return q + speed + preferenceBonus(label);
}

// Prefer magnets so debird resolvers can hook in
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

// ── Cinemeta display names ───────────────────────────────────────────────────
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

// ── Build sources from user's config ─────────────────────────────────────────
function isDebridEndpoint(u) {
  return /alldebrid|real-?debrid|premiumize/i.test(String(u || ""));
}
function sourcesFromUserConfig(cfg) {
  const list = [...SOURCES];
  const custom = (cfg && typeof cfg.customSource === "string" && cfg.customSource.trim()) || "";
  if (custom && /^https?:\/\//i.test(custom)) {
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

// ── Prefer lower quality if MUCH faster ──────────────────────────────────────
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

// ── Stream handler ───────────────────────────────────────────────────────────
builder.defineStreamHandler(async ({ type, id, config: userCfg }) => {
  try {
    const usedSources = sourcesFromUserConfig(userCfg || {});
    let candidates = await collectStreams(usedSources, type, id);
    if (candidates.length === 0) {
      console.log("No primary results; trying fallback sources …");
      candidates = await collectStreams(FALLBACK_SOURCES, type, id);
    }
    if (candidates.length === 0) return { streams: [] };

    // Debrid selected? keep 4K/2K more often
    const debridPreferred = usedSources.some(isDebridEndpoint) || ((userCfg?.debrid || "none") !== "none");
    const localPref = { ...PREF };
    if (debridPreferred) {
      localPref.prefer1080_ratio = Math.max(localPref.prefer1080_ratio, 3.5);
      localPref.prefer1080_delta = Math.max(localPref.prefer1080_delta, 1000);
    }

    // Initial curated pick
    let curated = candidates.slice().sort((a, b) => rankStream(b) - rankStream(a))[0];

    // Best per bucket
    const best2160 = bestOfQuality(candidates, "2160p");
    const best1440 = bestOfQuality(candidates, "1440p");
    const best1080 = bestOfQuality(candidates, "1080p");
    const best720  = bestOfQuality(candidates, "720p");

    // Prefer lower if MUCH faster
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

    // Clean titles with 4K/2K labels
    const niceName = await getDisplayLabel(type, id);
    const makeCleanWithQ = (st) => {
      const qTag = qualityTag(combinedLabel(st));
      const clean = `${niceName} — ${displayQuality(qTag)}`;
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

    const out = [];
    out.push(makeCleanWithQ(curated));
    if (!is1080pLabel(combinedLabel(curated)) && best1080) {
      const keyA = curated.url || curated.externalUrl || curated.magnet || curated.infoHash;
      const keyB = best1080.url || best1080.externalUrl || best1080.magnet || best1080.infoHash;
      if (!keyA || !keyB || keyA !== keyB) out.push(makeCleanWithQ(best1080));
    }

    const sorted = out.sort((a, b) => b.qScore - a.qScore || b.rank - a.rank).map(x => x.obj);
    return { streams: sorted };
  } catch (err) {
    console.error("AutoStream error:", err);
    return { streams: [] };
  }
});

// ── Web server with SDK router + our /configure page ─────────────────────────
const PORT = process.env.PORT || 7000;
const app = express();

// mount SDK router (serves /manifest.json, /stream/… and handles config token)
const sdkRouter = getRouter(builder.getInterface());
app.use(sdkRouter);

// Our own /configure page so browser GET works (Stremio Addons site opens it)
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Render a simple form
app.get("/configure", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AutoStream — Configure</title>
<style>
  body{font-family:system-ui,Segoe UI,Helvetica,Arial;background:#0d0e16;color:#e6e6ec;margin:2rem}
  label{display:block;margin:.8rem 0 .2rem}
  input,select,button{font:inherit;padding:.6rem .8rem;border-radius:.6rem;border:1px solid #333;background:#16182a;color:#eee;width:100%}
  button{cursor:pointer}
  .row{display:grid;gap:.8rem}
</style>
<h1>AutoStream — Configure</h1>
<form method="POST" action="/configure">
  <label>Debrid provider</label>
  <select name="debrid">
    <option value="none">None</option>
    <option value="alldebrid">AllDebrid</option>
    <option value="real-debrid">Real-Debrid</option>
    <option value="premiumize">Premiumize</option>
  </select>

  <label><input type="checkbox" name="cached" value="true" checked> Prefer cached links (Debrid)</label>

  <label>Advanced Torrentio params (optional)</label>
  <input name="params" value="exclude=cam,ts&audio=english&sort=seeders" placeholder="exclude=cam,ts&audio=english&sort=seeders">

  <label>Custom source URL (optional, overrides above)</label>
  <input name="customSource" placeholder="https://torrentio.strem.fun/alldebrid|cached=true&...">

  <p><button type="submit">Install in Stremio</button></p>
</form>
  `);
});

// Accept config (form or JSON), return redirect/JSON with install URL
app.post("/configure", (req, res) => {
  const cfg = {
    debrid: String(req.body.debrid || "none"),
    cached: !!(req.body.cached && req.body.cached !== "false"),
    params: String(req.body.params || ""),
    customSource: String(req.body.customSource || "")
  };

  const token = Buffer.from(JSON.stringify(cfg)).toString("base64url");
  const base = `${req.protocol}://${req.get("host")}`;
  const installUrl = `${base}/manifest.json?config=${token}`;

  // If JSON was requested (e.g. by a site), return JSON.
  if ((req.get("accept") || "").includes("application/json")) {
    res.json({ addonUrl: installUrl });
    return;
  }
  // Otherwise 302 for a browser, which Stremio understands too.
  res.redirect(302, installUrl);
});

app.listen(PORT, () => {
  console.log(`AutoStream add-on running on port ${PORT} → /manifest.json`);
  console.log("Primary sources:", SOURCES);
  console.log("Fallback sources:", FALLBACK_SOURCES);
  console.log("Lower-quality prefs (base):", PREF);
});
