// index.js
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

// thresholds for "prefer lower quality if MUCH faster"
const PREF = Object.assign(
  {
    // "ratio_and_delta" | "ratio_or_delta"
    prefer_rule: "ratio_and_delta",
    prefer1080_ratio: 2.0,
    prefer1080_delta: 500,
    prefer720_ratio: 3.0,
    prefer720_delta: 1000
  },
  config.prefer_lower_quality || {}
);

// ── Manifest (static JSON) ────────────────────────────────────────────────────
const manifest = {
  id: "org.autostream.best",
  version: "2.0.2",
  name: "AutoStream",
  description:
    "AutoStream picks the best stream for each title, balancing quality with seeders. Debrid can be enabled via manifest URL params. Returns a curated best pick and (when helpful) a second 1080p option.",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [], // required by Stremio linter
  idPrefixes: ["tt"],
  logo: "https://raw.githubusercontent.com/keypop3750/autostream-addon/main/logo.png",
  behaviorHints: { configurable: true, configurationRequired: false },
  stremioAddonsConfig: {
    issuer: "https://stremio-addons.net",
    signature:
      "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..KPt7fOiOCod52ZjlFWg52A.dt7eIyal-1oAkU4cOG5c6YPsWn70Ds6AXqY1FJX3Ikqzzeu1gzgj2_xO4e4zh7gsXEyjhoAJ-L9Pg6UI57XD6FWjzpRcvV0v-6WuKmfZO_hDcDIrtVQnFf0nK2dnO7-n.v25_jaY5E-4yH_cxyTKfsA"
  }
};

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

// ── Config readers ────────────────────────────────────────────────────────────
function decodeTokenMaybe(str) {
  try {
    const json = Buffer.from(String(str || ""), "base64url").toString("utf8");
    return JSON.parse(json);
  } catch { return null; }
}

// Read per-request settings from query OR from /u/:cfg token
function getConfig(req) {
  // 1) direct query params (Torrentio-style)
  let debrid = (req.query.debrid || "").toString();
  let apikey = (req.query.apikey || req.query.api_key || req.query.token || "").toString();
  let cached = !!(req.query.cached === "1" || req.query.cached === "true");

  // 2) optional token path (/u/:cfg/...) supporting old base64 config
  if ((!debrid || !apikey) && req.params && req.params.cfg) {
    const obj = decodeTokenMaybe(req.params.cfg);
    if (obj) {
      // Support either a full torrentio URL or fields
      if (typeof obj.torrentio === "string") {
        // legacy style: URL like https://torrentio.../<slug>|cached=true&...&apikey=...
        return { debrid: "custom-url", apikey: "", cached: true, legacyTorrentioUrl: obj.torrentio };
      }
      debrid = (obj.debridProvider || obj.debrid || debrid || "none").toString();
      apikey = (obj.debridApiKey || obj.apiKey || apikey || "").toString();
      cached = obj.preferCached != null ? !!obj.preferCached : cached;
    }
  }

  return {
    debrid: debrid || "none",
    apikey,
    cached,
    legacyTorrentioUrl: undefined
  };
}

// ── Upstream collection & de-dup ─────────────────────────────────────────────
async function fetchFromSource(baseUrl, type, id, cfg) {
  try {
    // Allow legacy "slug|params" URLs
    if (cfg.legacyTorrentioUrl && baseUrl === "__LEGACY_TORRENTIO__") {
      const [root, pipeParams] = cfg.legacyTorrentioUrl.split("|");
      const u = new URL(`${root.replace(/\/+$/, "")}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`);
      if (pipeParams) {
        const pairs = pipeParams.split("&");
        for (const p of pairs) {
          const [k, v = ""] = p.split("=");
          u.searchParams.set(k, v);
        }
      }
      const res = await fetch(u.toString(), { headers: { Accept: "application/json", "user-agent": "autostream/2.0" } });
      if (!res.ok) { console.error("Upstream error:", cfg.legacyTorrentioUrl, res.status, u.toString()); return []; }
      const data = await res.json();
      const list = Array.isArray(data.streams) ? data.streams : [];
      return list.map(st => ({ ...st, __source: cfg.legacyTorrentioUrl }));
    }

    const base = baseUrl.replace(/\/+$/, "");
    const uBase = new URL(base);
    const u = new URL(`${base}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`);

    // If hitting Torrentio, append debrid params as query string (proper way)
    if (/torrentio\.strem\.fun$/i.test(uBase.host) && cfg) {
      if (cfg.debrid && cfg.debrid !== "none" && cfg.debrid !== "custom-url") u.searchParams.set("debrid", cfg.debrid);
      if (cfg.cached != null) u.searchParams.set("cached", cfg.cached ? "true" : "false");
      if (cfg.apikey) u.searchParams.set("apikey", cfg.apikey);
      // keep your other prefs too, if you want:
      u.searchParams.set("exclude", "cam,ts");
      u.searchParams.set("audio", "english");
      u.searchParams.set("sort", "seeders");
    }

    const res = await fetch(u.toString(), { headers: { Accept: "application/json", "user-agent": "autostream/2.0" } });
    if (!res.ok) {
      console.error("Upstream error:", baseUrl, res.status, u.toString());
      return [];
    }
    const data = await res.json();
    const list = Array.isArray(data.streams) ? data.streams : [];
    return list.map(st => ({ ...st, __source: baseUrl }));
  } catch (e) {
    console.error("Source failed:", baseUrl, e.message || e);
    return [];
  }
}

async function collectStreams(sources, type, id, cfg) {
  const all = [];
  for (const src of sources) {
    try { all.push(...await fetchFromSource(src, type, id, cfg)); }
    catch (e) { console.error("Source failed:", src, e.message || e); }
  }
  // De-dup by url/magnet/infoHash
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

// ── Source resolver based on per-request config ───────────────────────────────
function isDebridEndpoint(u) {
  return /alldebrid|real-?debrid|premiumize/i.test(String(u || ""));
}
function resolveSourcesFromConfig(cfg) {
  const list = [...SOURCES];
  if (cfg.legacyTorrentioUrl) {
    list.unshift("__LEGACY_TORRENTIO__");
  } else if (cfg.debrid !== "none" && cfg.apikey) {
    list.unshift("https://torrentio.strem.fun");
  }
  return list;
}

// prefer-lower-quality rule
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

// ── Build response streams (curated + optional 1080p) ────────────────────────
async function buildStreams(type, id, cfg) {
  const usedSources = resolveSourcesFromConfig(cfg);
  const debridPreferred = usedSources.some(isDebridEndpoint) || !!cfg.legacyTorrentioUrl;

  console.log("[AutoStream] Config:", cfg, "Sources:", usedSources);

  let candidates = await collectStreams(usedSources, type, id, cfg);
  if (candidates.length === 0) {
    console.log("No primary results; trying fallback sources …");
    candidates = await collectStreams(FALLBACK_SOURCES, type, id, cfg);
  }
  if (candidates.length === 0) {
    console.log("No streams from any source.");
    return [];
  }

  // If Debrid is preferred, tighten downgrade thresholds
  const localPref = { ...PREF };
  if (debridPreferred) {
    localPref.prefer1080_ratio = Math.max(localPref.prefer1080_ratio, 3.5);
    localPref.prefer1080_delta = Math.max(localPref.prefer1080_delta, 1000);
  }

  // Rich ranking
  let curated = candidates.slice().sort((a, b) => rankStream(b) - rankStream(a))[0];

  const best2160 = bestOfQuality(candidates, "2160p");
  const best1440 = bestOfQuality(candidates, "1440p");
  const best1080 = bestOfQuality(candidates, "1080p");
  const best720  = bestOfQuality(candidates, "720p");

  console.log(
    "Seeds — 2160:", best2160 && extractSeeders(best2160),
    "1440:", best1440 && extractSeeders(best1440),
    "1080:", best1080 && extractSeeders(best1080),
    "720:",  best720  && extractSeeders(best720),
    "DebridPreferred:", debridPreferred
  );

  // Prefer lower quality if MUCH faster (configurable, ratio vs delta)
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

  const niceName = await getDisplayLabel(type, id);

  // Assemble outputs (best + optional 1080p)
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

  const out = [];
  const curatedPack = makeCleanWithQ(curated);
  out.push(curatedPack);

  // If curated isn't 1080p, also include best1080 (if different)
  if (!is1080pLabel(combinedLabel(curated)) && best1080) {
    const keyA = curated.url || curated.externalUrl || curated.magnet || curated.infoHash;
    const keyB = best1080.url || best1080.externalUrl || best1080.magnet || best1080.infoHash;
    if (!keyA || !keyB || keyA !== keyB) out.push(makeCleanWithQ(best1080));
  }

  const sorted = out.sort((a, b) => b.qScore - a.qScore || b.rank - a.rank).map(x => x.obj);
  return sorted;
}

// ── Web server (manual routes for manifest/stream) ────────────────────────────
const PORT = process.env.PORT || 7000;
const app = express();
app.use(express.urlencoded({ extended: true }));

// Request log
app.use((req, _res, next) => { console.log("[REQ]", req.method, req.originalUrl); next(); });

// CORS (helpful in web envs)
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

// Trust proxy → build https URLs on Render
app.set("trust proxy", 1);
function absoluteBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  const host = req.get("host") || "";
  const xf = String(req.headers["x-forwarded-proto"] || "");
  const scheme = xf.includes("https") || host.endsWith(".onrender.com") ? "https" : req.protocol;
  return `${scheme}://${host}`;
}

// --- Configure UI
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
    <form method="GET" action="/install">
      <div class="row">
        <label>Debrid provider</label>
        <select name="debrid">
          <option value="none">No Debrid</option>
          <option value="alldebrid">AllDebrid</option>
          <option value="real-debrid">Real-Debrid</option>
          <option value="premiumize">Premiumize</option>
        </select>
      </div>
      <div class="row check">
        <input id="cached" type="checkbox" name="cached" value="1" checked />
        <label for="cached">Prefer cached links (Debrid)</label>
      </div>
      <div class="row">
        <label>Debrid API key</label>
        <input type="text" name="apikey" placeholder="Paste your provider’s API key"/>
      </div>
      <button class="btn" type="submit">Install in Stremio</button>
    </form>
    <p><small>
      This builds a manifest URL with query params (Torrentio-style).
      Stremio will install that URL; if it later omits the query on /stream, you can also install with
      <code>/u/&lt;token&gt;/manifest.json</code> (legacy token path is supported too).
    </small></p>
  </div>
</div>
`;
app.get("/", (_, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(FORM_HTML); });
app.get("/configure", (_, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(FORM_HTML); });

app.get("/install", (req, res) => {
  const debrid = (req.query.debrid || "none").toString();
  const apikey = (req.query.apikey || "").toString().trim();
  const cached = req.query.cached ? "1" : "";

  const base = absoluteBase(req);
  const qs = new URLSearchParams();
  if (debrid && debrid !== "none") qs.set("debrid", debrid);
  if (apikey) qs.set("apikey", apikey);
  if (cached) qs.set("cached", "1");

  const manifestUrl = `${base}/manifest.json${qs.toString() ? "?" + qs.toString() : ""}`;
  const deep = `stremio://addon-install?url=${encodeURIComponent(manifestUrl)}`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
  <!doctype html>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Install AutoStream</title>
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
      <h2>Install in Stremio</h2>
      <p><a class="btn" href="${deep}">Open Stremio & Install</a></p>
      <p><small>If that doesn’t open Stremio automatically, copy this manifest URL and use
      <b>Add-ons → Install via URL</b>:</small></p>
      <code>${manifestUrl}</code>
      <p><a class="btn" href="/configure">Back</a></p>
    </div>
  </div>`);
});

// --- Manifest routes
app.get("/manifest.json", (req, res) => {
  const cfg = getConfig(req);
  console.log("[MANIFEST] cfg from query/token:", cfg);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(manifest));
});

// Support legacy token prefix too: /u/:cfg/manifest.json
app.get("/u/:cfg/manifest.json", (req, res) => {
  const cfg = getConfig(req);
  console.log("[MANIFEST/u] cfg from token:", cfg);
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(manifest));
});

// --- Stream routes (this is what Stremio calls when you open a title)
app.get("/stream/:type/:id.json", async (req, res) => {
  const cfg = getConfig(req);
  console.log("[STREAM args]", { type: req.params.type, id: req.params.id, cfg });

  try {
    const streams = await buildStreams(req.params.type, req.params.id, cfg);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ streams }));
  } catch (e) {
    console.error("Stream handler error:", e);
    res.status(200).json({ streams: [] });
  }
});

// Legacy token path: /u/:cfg/stream/:type/:id.json
app.get("/u/:cfg/stream/:type/:id.json", async (req, res) => {
  const cfg = getConfig(req);
  console.log("[STREAM/u args]", { type: req.params.type, id: req.params.id, cfg });

  try {
    const streams = await buildStreams(req.params.type, req.params.id, cfg);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ streams }));
  } catch (e) {
    console.error("Stream handler error:", e);
    res.status(200).json({ streams: [] });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log(`AutoStream add-on running on port ${PORT} → /manifest.json`);
  console.log("Primary sources:", SOURCES);
  console.log("Fallback sources:", FALLBACK_SOURCES);
  console.log("Lower-quality prefs:", PREF);
});
