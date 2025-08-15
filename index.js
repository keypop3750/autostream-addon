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

// ── Defaults for lower-quality preference knobs ───────────────────────────────
const PREF = Object.assign(
  {
    prefer2160_ratio: 1.5,
    prefer2160_delta: 250,
    prefer1440_ratio: 1.7,
    prefer1440_delta: 350,
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
  version: "1.9.2",
  name: "AutoStream",
  description:
    "AutoStream picks the best stream for each title, balancing quality with speed (seeders). If a lower resolution like 1080p or 720p is significantly better seeded than 2160p, it wins.",
  logo: "https://raw.githubusercontent.com/keypop3750/autostream-addon/main/logo.png",
  background: "https://raw.githubusercontent.com/keypop3750/autostream-addon/main/logo.png",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt", "kitsu", "local"],
  // ✅ required by stremio-addon-linter
  catalogs: [],
  behaviorHints: {
    configurable: true
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 7000;

function isDebridProviderURL(u) {
  return /real-debrid|premiumize|alldebrid/i.test(u) || /\bapikey=/.test(u);
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
  let best = null;
  let bestSeed = -1;
  for (const s of cands) {
    if (qualityTag(combinedLabel(s)) !== q) continue;
    const seed = extractSeeders(s) ?? -1;
    if (seed > bestSeed) {
      best = s;
      bestSeed = seed;
    }
  }
  return best;
}

function normalizeSourceURL(u) {
  if (!/^https?:\/\//i.test(u)) return null;
  return u.trim();
}

function applyCfgToSources(base, cfg) {
  const list = [...base];
  if (cfg && cfg.debrid && cfg.debrid !== "none" && cfg.apiKey) {
    // NOTE: tune this to the exact params your upstream source expects
    const debridParam = `debrid=${encodeURIComponent(cfg.debrid)}`;
    const cachedParam = `cached=${cfg.preferCached ? "true" : "false"}`;
    const keyParam = `apikey=${encodeURIComponent(cfg.apiKey)}`;
    const rd = `https://torrentio.strem.fun/${debridParam}&${cachedParam}&${keyParam}`;
    list.unshift(rd);
  }
  return list.filter(Boolean).map(normalizeSourceURL).filter(Boolean);
}

function decodeCfgToken(token) {
  try {
    const json = Buffer.from(token, "base64url").toString("utf8");
    const obj = JSON.parse(json);
    return {
      debrid: obj.debridProvider || obj.debrid || "none",
      apiKey: obj.debridApiKey || obj.apiKey || "",
      preferCached: !!obj.preferCached,
    };
  } catch {
    return { debrid: "none", apiKey: "", preferCached: false };
  }
}

function resolveSources(extra) {
  let cfg = null;
  if (extra && extra.cfg) cfg = decodeCfgToken(extra.cfg);
  const withCfg = applyCfgToSources(SOURCES, cfg);
  return withCfg.length ? withCfg : SOURCES;
}

// ── Add-on interface ──────────────────────────────────────────────────────────
const addon = new addonBuilder(manifest);

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { "user-agent": "autostream-addon/1.0" } });
  if (!res.ok) throw new Error(`Fetch ${url} => ${res.status}`);
  return res.json();
}

async function collectStreams(sourceList, type, id) {
  const all = [];
  for (const base of sourceList) {
    try {
      const u = new URL(base);
      u.pathname = "/stream/" + encodeURIComponent(type) + "/" + encodeURIComponent(id) + ".json";
      const obj = await fetchJSON(u.toString());
      if (Array.isArray(obj.streams)) {
        for (const s of obj.streams) all.push(s);
      }
    } catch (e) {
      console.error("Source failed:", base, e.message);
    }
  }
  return all;
}

addon.defineStreamHandler(async ({ type, id, extra }) => {
  console.log("[STREAM] extra.cfg present:", !!(extra && extra.cfg));
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
      "DebridPreferred:", debridOK
    );

    // Choose with seed-aware downgrades
    const top = best2160 || best1440 || best1080 || best720 || curated[0];
    let final = top;

    if (top && best1080 && (qualityTag(combinedLabel(top)) === "2160p" || qualityTag(combinedLabel(top)) === "1440p")) {
      if (isMuchFaster(best1080, top, { ratio: PREF.prefer1080_ratio, delta: PREF.prefer1080_delta })) {
        final = best1080;
      }
    }
    if (final && best720 && ["2160p", "1440p", "1080p"].includes(qualityTag(combinedLabel(final)))) {
      if (isMuchFaster(best720, final, { ratio: PREF.prefer720_ratio, delta: PREF.prefer720_delta })) {
        final = best720;
      }
    }

    return { streams: final ? [final] : [] };
  } catch (e) {
    console.error("Stream handler error:", e);
    return { streams: [] };
  }
});

// ── Simple UI pages for configuration ─────────────────────────────────────────
app.get("/", (_req, res) => {
  res.redirect("/configure");
});

app.get("/configure", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>AutoStream — Configure</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Inter,Arial,sans-serif;background:#0f1226;color:#e8ecff}
  .wrap{max-width:680px;margin:50px auto;padding:0 16px}
  .card{background:#14183a;border:1px solid #2b2f55;border-radius:12px;padding:24px}
  h1,h2{margin:0 0 12px}
  .row{display:flex;gap:12px;align-items:center;margin:10px 0}
  label{width:200px;display:inline-block}
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
          <select name="debridProvider">
            <option value="none" selected>No Debrid (use defaults)</option>
            <option value="real-debrid">Real-Debrid</option>
            <option value="premiumize">Premiumize</option>
            <option value="alldebrid">AllDebrid</option>
          </select>
        </div>
        <div class="row">
          <label>Prefer cached links (Debrid)</label>
          <input type="checkbox" name="preferCached" checked />
        </div>
        <div class="row">
          <label>Debrid API key</label>
          <input type="text" name="debridApiKey" placeholder="Required for selected debrid provider"/>
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
  const cfg = {
    debridProvider: req.query.debridProvider || "none",
    debridApiKey: (req.query.debridApiKey || "").trim(),
    preferCached: !!req.query.preferCached,
  };
  const token = Buffer.from(JSON.stringify(cfg)).toString("base64url");
  const base = `${req.protocol}://${req.get("host")}`;

  const manifestUrl = `${base}/u/${token}/manifest.json`;
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
      <p><small>If that doesn’t open Stremio automatically, copy this manifest URL and use
      <b>Add-ons → Install via URL</b>:</small></p>
      <code>${manifestUrl}</code>
      <p><a class="btn" href="/configure">Back</a></p>
    </div>
  </div>`);
});

// ---- Mount addon interface (⚠️ ORDER MATTERS)
const router = getRouter(addon.getInterface());

// Per-user config prefix: inject ?cfg=… so SDK exposes it as extra.cfg
app.use("/u/:cfg", (req, _res, next) => {
  const [pathOnly, qstr = ""] = req.url.split("?");
  const qs = new URLSearchParams(qstr);
  qs.set("cfg", req.params.cfg);
  req.url = `${pathOnly}?${qs.toString()}`;
  next();
}, router);

// Plain base (no cfg) AFTER
app.use("/", router);

// Start server
app.listen(PORT, () => {
  console.log(`AutoStream add-on running on port ${PORT}`);
  console.log("Primary sources:", SOURCES);
  console.log("Fallback sources:", FALLBACK_SOURCES);
  console.log("Lower-quality prefs:", PREF);
});
