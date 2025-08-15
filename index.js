// index.js
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const fs = require("fs");
const path = require("path");

// ── Load config.json (sources, fallbacks, knobs)
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
    prefer2160_ratio: 1.5,
    prefer2160_delta: 250,
    prefer1440_ratio: 1.7,
    prefer1440_delta: 350,
    prefer1080_ratio: 2.0,
    prefer1080_delta: 500,
    prefer720_ratio: 3.0,
    prefer720_delta: 1000,
  },
  config.prefer_lower_quality || {}
);

// ── Manifest
const manifest = {
  id: "org.autostream.best",
  version: "2.0.0",
  name: "AutoStream",
  description:
    "Auto picks a single best stream, balancing quality with seeders. Optional debrid via URL params (Torrentio-style).",
  logo: "https://raw.githubusercontent.com/keypop3750/autostream-addon/main/logo.png",
  background: "https://raw.githubusercontent.com/keypop3750/autostream-addon/main/logo.png",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt", "kitsu", "local"],
  catalogs: [],                // <- required by the SDK's linter
  behaviorHints: { configurable: true }
};

// ── Server bits
const app = express();
const PORT = process.env.PORT || 7000;
app.set("trust proxy", 1);     // honor x-forwarded-proto on Render

function absoluteBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  const host = req.get("host") || "";
  const xf = String(req.headers["x-forwarded-proto"] || "");
  const scheme = xf.includes("https") || host.endsWith(".onrender.com") ? "https" : req.protocol;
  return `${scheme}://${host}`;
}

// ── Helpers used by stream selection
function isDebridSourceURL(u) {
  // crude test: your upstream "debrid" param or presence of api key
  return /\bdebrid=|apikey=|api_key=|token=/.test(u);
}
function hasDebridApiKey(u) {
  try {
    const q = new URL(u).searchParams;
    return !!(q.get("apikey") || q.get("api_key") || q.get("token"));
  } catch {
    return /\b(api_key|apikey|token)=/.test(u);
  }
}
function qualityTag(label) {
  if (!label) return null;
  if (/2160p|4k/i.test(label)) return "2160p";
  if (/1440p|2k/i.test(label)) return "1440p";
  if (/1080p/i.test(label)) return "1080p";
  if (/720p/i.test(label)) return "720p";
  return null;
}
function extractSeeders(s) {
  if (!s || !s.title) return null;
  const m = s.title.match(/\b(\d{1,6})\s*seed/i);
  if (m) return parseInt(m[1], 10);
  const m2 = s.title.match(/\bS:(\d{1,6})\b/i);
  if (m2) return parseInt(m2[1], 10);
  return null;
}
function combinedLabel(s) {
  return [s.title, s.description].filter(Boolean).join(" ");
}
function isMuchFaster(a, b, { ratio, delta }) {
  const sa = extractSeeders(a) || 0;
  const sb = extractSeeders(b) || 0;
  return sa >= sb * ratio || sa >= sb + delta;
}
function bestOfQuality(cands, q) {
  let best = null, bestSeed = -1;
  for (const s of cands) {
    if (qualityTag(combinedLabel(s)) !== q) continue;
    const seed = extractSeeders(s) ?? -1;
    if (seed > bestSeed) { best = s; bestSeed = seed; }
  }
  return best;
}
function normalizeSourceURL(u) {
  return /^https?:\/\//i.test(u) ? u.trim() : null;
}

// Build the active sources list **from query params** (Torrentio-style)
function applyQueryCfgToSources(base, extra) {
  const list = [...base];
  const debrid = (extra && (extra.debrid || extra.dp)) || "none";
  const apiKey = (extra && (extra.apikey || extra.api_key || extra.token || extra.k)) || "";
  const preferCached = !!(extra && (extra.cached === "1" || extra.cached === "true" || extra.c === "1"));

  if (debrid !== "none" && apiKey) {
    // Example: use Torrentio upstream with debrid params first in the list
    // (Adjust to your preferred upstream if different)
    const url =
      `https://torrentio.strem.fun/` +
      `debrid=${encodeURIComponent(debrid)}` +
      `&cached=${preferCached ? "true" : "false"}` +
      `&apikey=${encodeURIComponent(apiKey)}`;
    list.unshift(url);
  }
  return list.map(normalizeSourceURL).filter(Boolean);
}

// ── Addon interface
const addon = new addonBuilder(manifest);

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { "user-agent": "autostream-addon/2.0" } });
  if (!res.ok) throw new Error(`Fetch ${url} => ${res.status}`);
  return res.json();
}
async function collectStreams(sourceList, type, id) {
  const all = [];
  for (const base of sourceList) {
    try {
      const u = new URL(base);
      u.pathname = `/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
      const obj = await fetchJSON(u.toString());
      if (Array.isArray(obj.streams)) for (const s of obj.streams) all.push(s);
    } catch (e) {
      console.error("Source failed:", base, e.message);
    }
  }
  return all;
}

// Torrentio-style: read debrid from args.extra (query params)
addon.defineStreamHandler(async ({ type, id, extra = {} }) => {
  console.log("[STREAM] extra:", { hasExtra: !!extra, debrid: extra.debrid || extra.dp, cached: extra.cached || extra.c, hasKey: !!(extra.apikey || extra.k) });

  try {
    const usedSources = applyQueryCfgToSources(SOURCES, extra);
    const debridURL = usedSources.find(isDebridSourceURL);
    const debridOK = debridURL ? hasDebridApiKey(debridURL) : false;

    console.log("[AutoStream] Using sources:", usedSources);
    console.log("[AutoStream] Debrid source:", debridURL || "none", "Has API key:", debridOK);

    let candidates = await collectStreams(usedSources, type, id);
    if (!candidates.length) {
      console.log("No primary results; trying fallback sources …");
      candidates = await collectStreams(FALLBACK_SOURCES, type, id);
    }
    if (!candidates.length) return { streams: [] };

    const curated = candidates.filter(s => /720p|1080p|1440p|2160p|4k/i.test(combinedLabel(s)));

    const best2160 = bestOfQuality(curated, "2160p");
    const best1440 = bestOfQuality(curated, "1440p");
    const best1080 = bestOfQuality(curated, "1080p");
    const best720  = bestOfQuality(curated, "720p");

    console.log(
      "Seeds — 2160:", best2160 && extractSeeders(best2160),
      "1440:", best1440 && extractSeeders(best1440),
      "1080:", best1080 && extractSeeders(best1080),
      "720:",  best720  && extractSeeders(best720),
      "DebridActive:", debridOK
    );

    let final = best2160 || best1440 || best1080 || best720 || curated[0];

    if (final && best1080 && ["2160p", "1440p"].includes(qualityTag(combinedLabel(final)))) {
      if (isMuchFaster(best1080, final, { ratio: PREF.prefer1080_ratio, delta: PREF.prefer1080_delta })) final = best1080;
    }
    if (final && best720 && ["2160p", "1440p", "1080p"].includes(qualityTag(combinedLabel(final)))) {
      if (isMuchFaster(best720, final, { ratio: PREF.prefer720_ratio, delta: PREF.prefer720_delta })) final = best720;
    }

    return { streams: final ? [final] : [] };
  } catch (e) {
    console.error("Stream handler error:", e);
    return { streams: [] };
  }
});

// ── Simple Configure → Install page (emits Torrentio-style query params)
app.get("/", (_req, res) => res.redirect("/configure"));

app.get("/configure", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>AutoStream — Configure</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Inter,Arial,sans-serif;background:#0f1226;color:#e8ecff}
  .wrap{max-width:680px;margin:50px auto;padding:0 16px}
  .card{background:#14183a;border:1px solid #2b2f55;border-radius:12px;padding:24px}
  h1{margin:0 0 12px}
  .row{display:flex;gap:12px;align-items:center;margin:10px 0}
  label{width:220px;display:inline-block}
  select,input{background:#0c1029;border:1px solid #2b2f55;border-radius:8px;color:#e8ecff;padding:8px 10px}
  .btn{display:inline-block;padding:10px 14px;border-radius:10px;border:1px solid #2b2f55;background:#191c36;color:#fff;text-decoration:none}
  .btn:hover{background:#1f2345}
  code{display:block;word-break:break-all;padding:10px;background:#0c1029;border:1px solid #2b2f55;border-radius:8px;margin-top:12px}
</style></head><body>
  <div class="wrap">
    <div class="card">
      <h1>AutoStream — Configure</h1>
      <form method="GET" action="/install">
        <div class="row">
          <label>Debrid provider</label>
          <select name="debrid">
            <option value="none" selected>No Debrid (use defaults)</option>
            <option value="real-debrid">Real-Debrid</option>
            <option value="premiumize">Premiumize</option>
            <option value="alldebrid">AllDebrid</option>
          </select>
        </div>
        <div class="row">
          <label>Prefer cached links (Debrid)</label>
          <input type="checkbox" name="cached" value="1" checked />
        </div>
        <div class="row">
          <label>Debrid API key</label>
          <input type="text" name="apikey" placeholder="Required for selected debrid provider"/>
        </div>
        <div class="row">
          <button class="btn" type="submit">Install in Stremio</button>
        </div>
      </form>
    </div>
  </div>
</body></html>`);
});

app.get("/install", (req, res) => {
  const debrid = (req.query.debrid || "none").toString();
  const apikey = (req.query.apikey || "").toString().trim();
  const cached = req.query.cached ? "1" : "0";

  const base = absoluteBase(req);
  const qs = new URLSearchParams();
  if (debrid !== "none") qs.set("debrid", debrid);
  if (apikey) qs.set("apikey", apikey);
  if (cached) qs.set("cached", cached);

  const manifestUrl = `${base}/manifest.json${qs.toString() ? "?" + qs.toString() : ""}`;
  const deep = `stremio://${manifestUrl}`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Install AutoStream</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Inter,Arial,sans-serif;background:#0f1226;color:#e8ecff}
    .wrap{max-width:680px;margin:50px auto;padding:0 16px}
    .card{background:#14183a;border:1px solid #2b2f55;border-radius:12px;padding:24px}
    h2{margin:0 0 12px}
    code{display:block;word-break:break-all;padding:10px;background:#0c1029;border:1px solid #2b2f55;border-radius:8px;margin-top:12px}
    a.btn{display:inline-block;padding:10px 14px;border-radius:10px;border:1px solid #2b2f55;background:#191c36;color:#fff;text-decoration:none}
    a.btn:hover{background:#1f2345}
  </style>
  <div class="wrap">
    <div class="card">
      <h2>Install in Stremio</h2>
      <p><a class="btn" href="${deep}">Open Stremio & Install</a></p>
      <p><small>If that doesn’t open Stremio, copy this manifest URL and use <b>Add-ons → Install via URL</b>:</small></p>
      <code>${manifestUrl}</code>
      <p><a class="btn" href="/configure">Back</a></p>
    </div>
  </div>`);
});

// Mount the addon interface (no special prefixes needed)
const router = getRouter(addon.getInterface());
app.use("/", router);

// Start server
app.listen(PORT, () => {
  console.log(`AutoStream add-on on port ${PORT}`);
  console.log("Primary sources:", SOURCES);
  console.log("Fallback sources:", FALLBACK_SOURCES);
});
