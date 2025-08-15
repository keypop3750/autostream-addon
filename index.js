// index.js
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const fs = require("fs");
const path = require("path");

// ── Harden process: never crash on async errors ───────────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
});

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
  version: "1.9.3",
  name: "AutoStream",
  description:
    "AutoStream picks the best stream for each title, balancing quality with speed (seeders). If a lower resolution like 1080p or 720p is much faster than 4K/2K, it’s preferred for smoother playback. You’ll usually see one link; when helpful, a second 1080p option appears. Titles are neat (e.g., “Movie Name — 1080p”).",
  resources: ["stream"],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"],
  logo: "https://raw.githubusercontent.com/keypop3750/autostream-addon/main/logo.png",
  behaviorHints: { configurable: true, configurationRequired: false },
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
function displayTag(tag) { return tag === "2160p" ? "4K" : tag === "1440p" ? "2K" : tag; }
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

// ── Fetch from upstreams ──────────────────────────────────────────────────────
async function fetchFromSource(baseUrl, type, id) {
  try {
    const url = `${baseUrl}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.error("[Upstream]", baseUrl, "HTTP", res.status);
      return [];
    }
    const data = await res.json().catch((e) => {
      console.error("[Upstream]", baseUrl, "bad JSON:", e?.message || e);
      return {};
    });
    const list = Array.isArray(data.streams) ? data.streams : [];
    return list.map(st => ({ ...st, __source: baseUrl }));
  } catch (e) {
    console.error("[Upstream]", baseUrl, "threw:", e?.message || e);
    return [];
  }
}
async function collectStreams(sources, type, id) {
  const all = [];
  for (const src of sources) {
    try { all.push(...await fetchFromSource(src, type, id)); }
    catch (e) { console.error("Source failed:", src, e); }
  }
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

// ── Per-user cfg (base64url) ─────────────────────────────────────────────────
const b64u = {
  enc: (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url"),
  dec: (str) => JSON.parse(Buffer.from(String(str || ""), "base64url").toString("utf8"))
};
function isDebridProviderURL(u) {
  return /alldebrid|real-?debrid|premiumize/i.test(String(u || ""));
}
function hasDebridApiKey(u) {
  return /(?:^|[|&?])apikey=/i.test(String(u || ""));
}
function resolveSources(extra) {
  try {
    if (extra && extra.cfg) {
      const cfg = b64u.dec(extra.cfg);
      if (cfg && typeof cfg.torrentio === "string" && /^https?:\/\//i.test(cfg.torrentio)) {
        console.log("[AutoStream] cfg decoded:", cfg);
        return [cfg.torrentio, ...SOURCES];
      }
    }
  } catch (e) {
    console.warn("[AutoStream] cfg decode failed:", e?.message || e);
  }
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
    const usedSources = resolveSources(extra);
    const debridURL   = usedSources.find(isDebridProviderURL);
    const debridOK    = debridURL ? hasDebridApiKey(debridURL) : false;

    console.log("[AutoStream] Using sources:", usedSources);
    console.log("[AutoStream] Debrid source:", debridURL || "none", "Has API key:", debridOK);

    let candidates = await collectStreams(usedSources, type, id);
    if (candidates.length === 0) {
      console.log("No primary results; trying fallback sources …");
      candidates = await collectStreams(FALLBACK_SOURCES, type, id);
    }
    if (candidates.length === 0) {
      console.log("No streams from any source.");
      return { streams: [] };
    }

    const localPref = { ...PREF };
    if (debridOK) {
      localPref.prefer1080_ratio = Math.max(localPref.prefer1080_ratio, 3.5);
      localPref.prefer1080_delta = Math.max(localPref.prefer1080_delta, 1000);
    }

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
      "DebridPreferred:", debridOK
    );

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

    // pass-through streams; only tidy the title
    const makeCleanWithQ = (st) => {
      const qTag = qualityTag(combinedLabel(st));
      const clean = `${niceName} — ${displayTag(qTag)}`;
      return {
        obj: {
          ...st,
          title: clean,
          name: "AutoStream",
          behaviorHints: { ...(st.behaviorHints || {}), bingeGroup: id }
        },
        qScore: qualityScoreFromTag(qTag),
        rank: rankStream(st)
      };
    };

    const out = [];
    const curatedPack = makeCleanWithQ(curated);
    out.push(curatedPack);

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

// ── Configure page & server ───────────────────────────────────────────────────
const app = express();
app.set("trust proxy", true);
app.use(express.urlencoded({ extended: true }));

// Small helper: safely wrap any handler to avoid unhandled rejections
const safe = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch((err) => {
    console.error("[Route error]", err);
    if (!res.headersSent) {
      // Return an empty object (manifest) or empty streams so Stremio doesn't explode
      if (req.path.endsWith("manifest.json")) return res.status(500).json({});
      return res.status(500).json({ streams: [] });
    }
  });

function baseOrigin(req) {
  const xf = (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim();
  const proto = xf || req.protocol || "https";
  return `${proto}://${req.get("host")}`;
}

// provider: 'none' | 'alldebrid' | 'real-debrid' | 'premiumize'
function buildTorrentioUrl({ provider = "none", cached = true, apikey = "" }) {
  const p = (provider || "none").toLowerCase();
  if (p === "none") return null;

  if (!apikey) throw new Error("API key is required for the selected debrid provider.");

  const slug = p.includes("real") ? "real-debrid" : p.includes("prem") ? "premiumize" : "alldebrid";
  const params = [];
  if (cached) params.push("cached=true");
  params.push("exclude=cam,ts", "audio=english", "sort=seeders", "apikey=" + encodeURIComponent(apikey));
  return `https://torrentio.strem.fun/${slug}|${params.join("&")}`;
}

const FORM_HTML = (errorMsg = "") => `
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
  .err{background:#3b1220;border:1px solid #7a213a;color:#ffd8e1;padding:10px;border-radius:10px;margin-bottom:12px}
</style>
<div class="wrap">
  <h1>AutoStream — Configure</h1>
  <div class="card">
    ${errorMsg ? `<div class="err">${errorMsg}</div>` : ""}
    <form method="POST" action="/configure">
      <div class="row">
        <label>Debrid provider</label>
        <select name="provider">
          <option value="none">No Debrid (use defaults)</option>
          <option value="alldebrid">AllDebrid</option>
          <option value="real-debrid">RealDebrid</option>
          <option value="premiumize">Premiumize</option>
        </select>
      </div>

      <div class="row check">
        <input id="cached" type="checkbox" name="cached" checked />
        <label for="cached">Prefer cached links (Debrid)</label>
      </div>

      <div class="row">
        <label>Debrid API key</label>
        <input type="text" name="apikey" placeholder="Required for selected debrid provider" />
      </div>

      <button class="btn" type="submit">Install in Stremio</button>
    </form>
    <p><small>
      Clicking Install tries to open the Stremio app via the <code>stremio://</code> link.
      If your browser blocks it, copy the manifest URL shown on the next screen and use
      <b>Add-ons → Install via URL</b>.
    </small></p>
  </div>
</div>
`;

app.get("/configure", (_req, res) => { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(FORM_HTML()); });
app.get("/", (_req, res) => res.redirect("/configure"));

app.post("/configure", safe((req, res) => {
  const provider = String(req.body.provider || "none").toLowerCase();
  const cached   = !!req.body.cached;
  const apikey   = String(req.body.apikey || "").trim();

  let torrentio = null;
  try {
    torrentio = buildTorrentioUrl({ provider, cached, apikey }); // null if provider === 'none'
  } catch (e) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(FORM_HTML(e.message));
  }

  const cfg = torrentio ? b64u.enc({ torrentio }) : b64u.enc({});
  const origin = baseOrigin(req);

  const manifestUrl = `${origin}/u/${cfg}/manifest.json`;
  const deep = `stremio://addon-install?url=${encodeURIComponent(manifestUrl)}`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
  <!doctype html>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>AutoStream — Install</title>
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
}));

// ---- Mount addon interface (explicit + safe) --------------------------------
const iface = builder.getInterface();

// Base (no cfg)
app.get("/manifest.json", safe((req, res) => iface.manifest(req, res)));
app.get("/stream/:type/:id.json", safe((req, res) => iface.get(req, res)));
app.post("/stream/:type/:id.json", safe((req, res) => iface.post(req, res)));

// Config-aware base: /u/:cfg/...
app.get("/u/:cfg/manifest.json", safe((req, res) => {
  req.query = Object.assign({}, req.query, { cfg: req.params.cfg });
  iface.manifest(req, res);
}));
app.get("/u/:cfg/stream/:type/:id.json", safe((req, res) => {
  req.query = Object.assign({}, req.query, { cfg: req.params.cfg });
  iface.get(req, res);
}));
app.post("/u/:cfg/stream/:type/:id.json", safe((req, res) => {
  req.query = Object.assign({}, req.query, { cfg: req.params.cfg });
  iface.post(req, res);
}));

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
  console.log(`AutoStream add-on running on port ${PORT}`);
  console.log("Primary sources:", SOURCES);
  console.log("Fallback sources:", FALLBACK_SOURCES);
  console.log("Lower-quality prefs:", PREF);
});
