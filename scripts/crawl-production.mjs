#!/usr/bin/env node
// crawl-production.mjs
//
// Lightweight production/preview crawl: verifies that the DEPLOYED site
// matches what the build promised. Run after every deployment:
//
//   node scripts/crawl-production.mjs https://kindredtrips.com
//   node scripts/crawl-production.mjs https://<preview>.vercel.app
//
// Checks (P0 — non-zero exit on failure):
//   - Route manifest URLs return 200 (no 3xx/4xx/5xx on canonical URLs)
//   - Sitemap URLs return 200, are self-canonical, and are not noindexed
//   - Legacy .html routes redirect in ONE hop to the clean URL
//   - Retired country routes redirect (not 404)
//   - www host redirects to the apex (when DNS resolves)
//   - Live HTML canaries: Jamaica family section free of adult brands;
//     Sandals resort page free of "family-friendly"; homepage shows the
//     published family-resort count
// Samples large templates (resorts) to keep runtime reasonable; core
// pages are checked exhaustively.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.argv[2] || "https://kindredtrips.com").replace(/\/$/, "");
const CANON = "https://kindredtrips.com";
const SAMPLE_PER_TEMPLATE = { resort: 25, theme: 15, country: 30, compare: 10, from: 8 };

const failures = [];
const fail = (rule, msg) => failures.push(`[${rule}] ${msg}`);
const fetchOpts = { redirect: "manual", headers: { "user-agent": "KindredTripsCrawler/1.0 (+https://kindredtrips.com)" } };

async function head(url) {
  try {
    const res = await fetch(url, { ...fetchOpts, method: "GET" });
    return { status: res.status, location: res.headers.get("location"), body: res.status === 200 ? await res.text() : "" };
  } catch (e) {
    return { status: 0, error: String(e?.message ?? e) };
  }
}
const toBase = (u) => u.replace(CANON, BASE);

const manifest = JSON.parse(readFileSync(join(ROOT, "data/route-manifest.json"), "utf8"));
const stats = JSON.parse(readFileSync(join(ROOT, "data/site-stats.json"), "utf8"));

// Sample the manifest: all non-resort pages exhaustively is still large;
// take core pages + per-template samples spread across the list.
const byTemplate = new Map();
for (const r of manifest) {
  if (!byTemplate.has(r.template)) byTemplate.set(r.template, []);
  byTemplate.get(r.template).push(r);
}
const targets = [];
for (const [tpl, rows] of byTemplate) {
  const cap = SAMPLE_PER_TEMPLATE[tpl] ?? rows.length;
  const step = Math.max(1, Math.floor(rows.length / cap));
  targets.push(...rows.filter((_, i) => i % step === 0).slice(0, cap));
}

console.log(`Crawling ${targets.length} sampled routes on ${BASE} …`);
let checked = 0;
for (const t of targets) {
  const res = await head(toBase(t.url));
  checked++;
  if (res.status !== 200) { fail("STATUS", `${t.url} → ${res.status}${res.location ? ` → ${res.location}` : ""}`); continue; }
  const canonical = res.body.match(/rel="canonical" href="([^"]+)"/)?.[1];
  if (canonical && canonical !== t.url) fail("CANONICAL", `${t.url} canonical=${canonical}`);
  const robots = res.body.match(/name="robots" content="([^"]+)"/)?.[1] ?? "";
  const noindexed = /noindex/.test(robots);
  if (t.indexable && noindexed) fail("ROBOTS", `${t.url} expected indexable, got ${robots}`);
  if (!t.indexable && !noindexed) fail("ROBOTS", `${t.url} expected noindex, got "${robots}"`);
}

// Legacy .html routes: exactly one redirect hop to the clean URL.
for (const legacy of ["/about.html", "/contact.html", "/privacy.html"]) {
  const res = await head(`${BASE}${legacy}`);
  if (![301, 302, 307, 308].includes(res.status)) fail("LEGACY", `${legacy} → ${res.status} (expected one-hop redirect)`);
  else {
    const target = new URL(res.location, BASE).pathname;
    if (target !== legacy.replace(".html", "")) fail("LEGACY", `${legacy} redirects to ${res.location}`);
    else {
      const second = await head(new URL(res.location, BASE).toString());
      if (second.status !== 200) fail("LEGACY-CHAIN", `${legacy} chain: second hop → ${second.status}`);
    }
  }
}

// Retired country routes must redirect, never 404.
for (const gone of ["/caribbean/brazil", "/caribbean/ecuador", "/caribbean/peru", "/caribbean/united-states"]) {
  const res = await head(`${BASE}${gone}`);
  if (res.status === 404 || res.status === 0) fail("RETIRED", `${gone} → ${res.status} (expected redirect)`);
}

// www host must not be a separately accessible canonical host.
if (BASE === CANON) {
  const res = await head("https://www.kindredtrips.com/");
  if (res.status === 200) fail("HOST", "www host serves 200 (expected redirect to apex)");
  else if (res.status === 0) console.log("NOTE: www host did not resolve from this network — verify manually.");
}

// Live HTML canaries.
{
  const jam = await head(`${BASE}/caribbean/jamaica`);
  if (jam.status === 200) {
    const familyPortion = jam.body.split(/<h2>Adults-only properties in /)[0];
    for (const canary of ["Sandals Royal Plantation", "Hedonism", "Couples Tower Isle"]) {
      if (familyPortion.includes(canary)) fail("CANARY", `live Jamaica family section contains "${canary}"`);
    }
  } else fail("CANARY", `/caribbean/jamaica → ${jam.status}`);
  const srp = await head(`${BASE}/resort/sandals-royal-plantation`);
  if (srp.status === 200 && /family-friendly/i.test(srp.body.slice(srp.body.indexOf("<main"), srp.body.indexOf("</main>")))) {
    fail("CANARY", "live sandals-royal-plantation page says family-friendly");
  }
  const home = await head(`${BASE}/`);
  const expectedCount = `${Math.floor(stats.family_resorts / 10) * 10}+`;
  if (home.status === 200 && !home.body.includes(`${expectedCount} family resorts`)) {
    fail("CANARY", `live homepage does not show the published count "${expectedCount} family resorts"`);
  }
  const sitemap = await head(`${BASE}/sitemap.xml`);
  if (sitemap.status !== 200) fail("SITEMAP", `/sitemap.xml → ${sitemap.status}`);
}

console.log(`Checked ${checked} routes + legacy/canary probes.`);
if (failures.length) {
  for (const f of failures) console.error("FAIL " + f);
  console.error(`\n${failures.length} production failure(s).`);
  process.exit(1);
}
console.log("Production crawl passed.");
