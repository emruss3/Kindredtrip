#!/usr/bin/env node
// validate-site.mjs
//
// Post-build crawl over the generated static site. Build-blocking: any
// FAIL exits non-zero. Rerun after every generation/deployment:
//
//   node scripts/generate-seo-pages.mjs && node scripts/validate-site.mjs
//
// Checks (mapped to the CI gate list):
//   1-3. No adult_only / couples_only / uncertain resort on any family surface
//   4.   Ineligible resorts carry no kids FAQs and no family language
//   5.   "all-inclusive" copy only with provider-verified AI status
//   6-7. No "Yes — 0" grammar anywhere
//   8.   No duplicate canonical resort pages (one page per canonical entity)
//   9-11. One H1, self-canonical, unique titles on indexable pages
//   12-13. Sitemap: only existing, indexable, self-canonical, extensionless URLs
//   17.  Sitewide counts match data/site-stats.json
//   18-19. noindexed templates (/from, thin pages) are out of the sitemap
//   20.  No disallowed business-model language
//   21.  Airport rows use "IATA — Full name" format where IATA is known
//   22.  JSON-LD parses and eligibility matches visible content
//   24.  Orphan report: every indexable page is internally linked
// Also emits INDEXABILITY_REPORT.csv and ORPHANS in the summary.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  familyEligibility, slugify, displayName, DISALLOWED_BUSINESS_LANGUAGE,
} from "./lib/family-rules.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://kindredtrips.com";
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const failures = [];
const warnings = [];
const fail = (rule, msg) => failures.push(`[${rule}] ${msg}`);
const warn = (rule, msg) => warnings.push(`[${rule}] ${msg}`);

// ---------- inventory ----------
const resorts = JSON.parse(read("data/resorts-seo.json"));
const stats = JSON.parse(read("data/site-stats.json"));
const eligByName = new Map();
const slugElig = new Map();
{
  const used = new Set();
  for (const r of resorts) {
    const e = familyEligibility(r);
    eligByName.set(displayName(r), e);
    let base = slugify(r.resort_name), slug = base;
    if (used.has(slug)) slug = `${base}-${String(r.resort_id).slice(0, 4)}`;
    used.add(slug);
    slugElig.set(slug, e);
  }
}

function walk(dir) {
  const out = [];
  if (!existsSync(join(ROOT, dir))) return out;
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (rel.endsWith(".html")) out.push(rel);
  }
  return out;
}
const htmlFiles = ["resort", "caribbean", "from", "compare"].flatMap(walk)
  .concat(["index.html", "about.html", "contact.html", "privacy.html"]);

const pages = new Map(); // path -> {html, robots, canonical, title, h1s}
for (const f of htmlFiles) {
  const html = read(f);
  pages.set(f, {
    html,
    robots: html.match(/name="robots" content="([^"]+)"/)?.[1] ?? "",
    canonical: html.match(/rel="canonical" href="([^"]+)"/)?.[1] ?? "",
    title: html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "",
    h1s: [...html.matchAll(/<h1[\s>]/g)].length,
  });
}
const urlOf = (f) => {
  if (f === "index.html") return `${ORIGIN}/`;
  if (f === "caribbean/index.html") return `${ORIGIN}/caribbean`;
  if (["about.html", "contact.html", "privacy.html"].includes(f)) return `${ORIGIN}/${f.replace(".html", "")}`;
  return `${ORIGIN}/${f.replace(/\.html$/, "")}`;
};
const isIndexable = (p) => !/noindex/.test(p.robots);

// ---------- 1-4: family surfaces contain only family_allowed ----------
// Family surfaces = country pages' family sections, theme pages, /from
// pages, index. We check every /resort/<slug> link on those surfaces.
const familySurfaces = [...pages.keys()].filter((f) =>
  (f.startsWith("caribbean/") || f.startsWith("from/")) && f.endsWith(".html"));
for (const f of familySurfaces) {
  const { html } = pages.get(f);
  // Adults-only sections on country pages are explicitly labeled; slice
  // them out before checking.
  const familyPortion = html.split(/<h2>Adults-only properties in /)[0];
  for (const m of familyPortion.matchAll(/href="\/resort\/([a-z0-9-]+)"/g)) {
    const e = slugElig.get(m[1]);
    if (e && e !== "family_allowed") {
      fail("FAMILY-SURFACE", `${f} links ${m[1]} (${e}) in family context`);
    }
  }
}
// Resort pages for ineligible properties: noindex + no family language.
const FAMILY_LANG = /family-friendly|family resort|family vacation|kids club|Kids club|family fit|Family fit/;
for (const [f, p] of pages) {
  if (!f.startsWith("resort/")) continue;
  const slug = f.replace(/^resort\//, "").replace(/\.html$/, "");
  const e = slugElig.get(slug);
  if (!e) continue;
  if (e !== "family_allowed") {
    if (isIndexable(p)) fail("ADULT-NOINDEX", `${f} (${e}) is indexable`);
    const body = p.html.slice(p.html.indexOf("<main"), p.html.indexOf("</main>"));
    if (FAMILY_LANG.test(body)) fail("ADULT-LANG", `${f} (${e}) uses family language`);
    if (/Does .{0,80} have a kids club/.test(body)) fail("ADULT-KIDSFAQ", `${f} has a kids FAQ`);
  }
}

// ---------- 5: all-inclusive copy requires verified status ----------
{
  const aiPage = pages.get("caribbean/best-all-inclusive-family-resorts.html");
  if (aiPage) {
    const aiOk = new Set(resorts.filter((r) => r.all_inclusive === true).map((r) => slugify(r.resort_name)));
    for (const m of aiPage.html.matchAll(/href="\/resort\/([a-z0-9-]+)"/g)) {
      if (slugElig.has(m[1]) && !aiOk.has(m[1]) && ![...aiOk].some((s) => m[1].startsWith(s))) {
        fail("AI-VERIFIED", `all-inclusive page lists ${m[1]} without verified AI rates`);
      }
    }
  }
}

// ---------- 6-7: zero-count grammar ----------
for (const [f, p] of pages) {
  if (/Yes — 0 |Yes—0 |Yes - 0 /.test(p.html)) fail("ZERO-GRAMMAR", `${f} contains "Yes — 0"`);
  if (/\b0 resorts? (have|offer|with) /.test(p.html) && /Yes/.test(p.html.slice(Math.max(0, p.html.search(/\b0 resorts?/) - 80), p.html.search(/\b0 resorts?/)))) {
    warn("ZERO-GRAMMAR", `${f} may affirm from a zero count`);
  }
}

// ---------- 8: no duplicate canonical resort pages ----------
{
  const seen = new Map();
  for (const f of pages.keys()) {
    if (!f.startsWith("resort/")) continue;
    const key = f.replace(/-[0-9a-f]{4}\.html$/, ".html"); // id-suffixed collisions
    if (seen.has(key) && key !== f) warn("DUPE-PAGE", `possible duplicate entity: ${f} vs ${seen.get(key)}`);
    else seen.set(key, f);
  }
  const names = new Map();
  for (const r of resorts) {
    const k = `${displayName(r).toLowerCase()}|${r.country}`;
    if (names.has(k)) fail("DUPE-DATA", `duplicate catalogue rows for ${k}`);
    names.set(k, true);
  }
}

// ---------- 9-11: H1 / canonical / title uniqueness ----------
const titleSeen = new Map();
for (const [f, p] of pages) {
  if (!isIndexable(p)) continue;
  if (p.h1s !== 1) fail("H1", `${f} has ${p.h1s} h1 elements`);
  const expected = urlOf(f);
  if (p.canonical !== expected) fail("CANONICAL", `${f} canonical=${p.canonical} expected=${expected}`);
  if (/\.html$/.test(p.canonical) && !["about", "contact", "privacy"].some((s) => p.canonical.includes(s))) {
    fail("CANONICAL-EXT", `${f} canonical has .html`);
  }
  if (titleSeen.has(p.title)) fail("TITLE-DUPE", `duplicate title "${p.title.slice(0, 60)}" on ${f} and ${titleSeen.get(p.title)}`);
  titleSeen.set(p.title, f);
}

// ---------- 12-13, 18-19: sitemap hygiene ----------
{
  const sitemap = read("sitemap.xml");
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const locSet = new Set(locs);
  if (locSet.size !== locs.length) fail("SITEMAP", "duplicate URLs in sitemap");
  for (const loc of locs) {
    if (!loc.startsWith(ORIGIN)) fail("SITEMAP-HOST", `${loc} not on canonical host`);
    if (/\.html$/.test(loc)) fail("SITEMAP-EXT", `${loc} has .html extension`);
    if (/[A-Z]/.test(loc.replace(ORIGIN, ""))) fail("SITEMAP-CASE", `${loc} has uppercase path`);
    const rel = loc.replace(ORIGIN, "").replace(/^\//, "");
    const file = rel === "" ? "index.html" : rel === "caribbean" ? "caribbean/index.html" : `${rel}.html`;
    const p = pages.get(file);
    if (!p) { fail("SITEMAP-200", `${loc} has no generated file`); continue; }
    if (!isIndexable(p)) fail("SITEMAP-NOINDEX", `${loc} is noindexed but in sitemap`);
    if (p.canonical && p.canonical !== loc) fail("SITEMAP-CANON", `${loc} canonicalizes elsewhere (${p.canonical})`);
  }
  for (const [f, p] of pages) {
    if (f.startsWith("from/") && locSet.has(urlOf(f))) fail("SITEMAP-FROM", `${f} (noindex template) in sitemap`);
  }
}

// ---------- 17: counts from central source ----------
{
  for (const f of ["index.html", "about.html", "llms.txt"]) {
    if (!existsSync(join(ROOT, f))) continue;
    const s = read(f);
    for (const m of s.matchAll(/(\d[\d,]*)\+ family(?:-friendly)? resorts/g)) {
      if (m[1].replace(/,/g, "") !== String(Math.floor(stats.family_resorts / 10) * 10)) {
        fail("COUNTS", `${f} says "${m[0]}" but central stat is ${stats.family_resorts}`);
      }
    }
    for (const m of s.matchAll(/(\d+) Caribbean destinations/g)) {
      if (Number(m[1]) !== stats.countries) fail("COUNTS", `${f} says ${m[0]}, central=${stats.countries}`);
    }
  }
}

// ---------- 20: business-model language ----------
for (const [f, p] of pages) {
  for (const re of DISALLOWED_BUSINESS_LANGUAGE) {
    if (re.test(p.html)) fail("BIZ-LANG", `${f} matches ${re}`);
  }
}

// ---------- 21: airport display format ----------
for (const [f, p] of pages) {
  if (!f.startsWith("resort/")) continue;
  const m = p.html.match(/Nearest airport<\/th><td>([^<]*)</);
  if (m && /\b[A-Z]{3}\b/.test(m[1]) && !m[1].includes("—")) {
    fail("AIRPORT-FMT", `${f} airport row "${m[1]}" lacks "IATA — Name" format`);
  }
}

// ---------- 22: JSON-LD validity + eligibility coherence ----------
let ldChecked = 0;
for (const [f, p] of pages) {
  for (const m of p.html.matchAll(/<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/g)) {
    try { JSON.parse(m[1]); ldChecked++; } catch { fail("JSONLD", `${f} has invalid JSON-LD`); }
  }
  if (f.startsWith("resort/")) {
    const slug = f.replace(/^resort\//, "").replace(/\.html$/, "");
    const e = slugElig.get(slug);
    if (e && e !== "family_allowed" && /"amenityFeature"/.test(p.html) && /Kids club/.test(p.html.match(/"amenityFeature"[\s\S]{0,600}/)?.[0] ?? "")) {
      fail("JSONLD-ELIG", `${f} (${e}) schema claims kids amenity`);
    }
  }
}

// ---------- 24: orphan report ----------
{
  const inbound = new Map([...pages.keys()].map((f) => [f, 0]));
  for (const [f, p] of pages) {
    for (const m of p.html.matchAll(/href="(\/(?:resort|caribbean|from|compare)\/[^"#?]+|\/caribbean)"/g)) {
      let target = m[1] === "/caribbean" ? "caribbean/index.html" : `${m[1].slice(1)}.html`;
      if (pages.has(target) && target !== f) inbound.set(target, (inbound.get(target) ?? 0) + 1);
    }
  }
  for (const [f, p] of pages) {
    if (!isIndexable(p)) continue;
    if (["index.html", "about.html", "contact.html", "privacy.html", "caribbean/index.html"].includes(f)) continue;
    if ((inbound.get(f) ?? 0) === 0) fail("ORPHAN", `${f} has no internal inbound links`);
  }
}

// ---------- HTML-level canaries (final rendered output) ----------
{
  const jam = pages.get("caribbean/jamaica.html");
  if (jam) {
    const familyPortion = jam.html.split(/<h2>Adults-only properties in /)[0];
    for (const canary of ["Sandals Royal Plantation", "Hedonism", "Couples Tower Isle", "Grand Lido"]) {
      if (familyPortion.includes(canary)) fail("CANARY-HTML", `jamaica family section contains "${canary}"`);
    }
  }
  const srp = pages.get("resort/sandals-royal-plantation.html");
  if (srp) {
    const body = srp.html.slice(srp.html.indexOf("<main"), srp.html.indexOf("</main>"));
    if (/family-friendly/i.test(body)) fail("CANARY-HTML", "sandals-royal-plantation page says family-friendly");
  }
  const westin = [...pages.keys()].find((f) => f.includes("westin-reserva-conchal"));
  if (westin && !isIndexable(pages.get(westin))) fail("CANARY-HTML", "Westin Reserva Conchal (family canary) is noindexed");
}

// ---------- broken internal links (redirect-aware) ----------
{
  const redirects = (() => {
    try {
      return (JSON.parse(read("vercel.json")).redirects ?? []).map((r) => r.source.replace("/:path*", ""));
    } catch { return []; }
  })();
  const redirected = (href) => redirects.some((src) => href === src || href.startsWith(src + "/"));
  const broken = new Map();
  for (const [f, p] of pages) {
    for (const m of p.html.matchAll(/href="(\/(?:resort|caribbean|from|compare)\/[^"#?]+)"/g)) {
      const href = m[1];
      const target = `${href.slice(1)}.html`;
      if (!pages.has(target) && href !== "/caribbean" && !redirected(href)) {
        broken.set(href, f);
      }
    }
  }
  for (const [href, f] of broken) fail("BROKEN-LINK", `${f} links ${href} (no page, no redirect)`);
}

// ---------- provider restrictions must not leak into display names ----------
for (const [f, p] of pages) {
  const h1 = p.html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "";
  if (/\((?:[^)]*(?:only|nude|clothing|allowed|refundable)[^)]*)\)/i.test(h1)) {
    fail("H1-RESTRICTION", `${f} h1 leaks a provider restriction: "${h1.replace(/<[^>]+>/g, "").slice(0, 80)}"`);
  }
}

// ---------- filter-derived titles: any "All-Inclusive"-titled list page ----------
{
  const aiOk = new Set(resorts.filter((r) => r.all_inclusive === true).map((r) => slugify(r.resort_name)));
  for (const [f, p] of pages) {
    if (!/All-Inclusive/i.test(p.title)) continue;
    if (f.startsWith("resort/") || f.startsWith("compare/")) continue; // single-entity pages describe their own status
    const listPortion = p.html.split(/<h2>More "best of the Caribbean" lists|<h2>By destination/)[0];
    for (const m of listPortion.matchAll(/href="\/resort\/([a-z0-9-]+)"/g)) {
      if (slugElig.has(m[1]) && !aiOk.has(m[1])) {
        fail("AI-TITLE", `${f} titled All-Inclusive lists unverified ${m[1]}`);
      }
    }
  }
}

// ---------- duplicate meta descriptions on indexable pages ----------
{
  const descSeen = new Map();
  for (const [f, p] of pages) {
    if (!isIndexable(p)) continue;
    const d = p.html.match(/name="description" content="([^"]*)"/)?.[1] ?? "";
    if (!d) { fail("DESC", `${f} missing meta description`); continue; }
    if (descSeen.has(d)) fail("DESC-DUPE", `duplicate description on ${f} and ${descSeen.get(d)}`);
    descSeen.set(d, f);
  }
}

// ---------- route manifest consistency ----------
{
  const manifest = JSON.parse(read("data/route-manifest.json"));
  const manifestUrls = new Set(manifest.map((r) => r.url));
  // Every generated page must be in the manifest and vice versa.
  for (const f of pages.keys()) {
    if (!manifestUrls.has(urlOf(f))) fail("MANIFEST", `${f} generated but not in route manifest`);
  }
  for (const r of manifest) {
    const rel = r.url.replace(ORIGIN, "").replace(/^\//, "");
    const file = rel === "" ? "index.html" : rel === "caribbean" ? "caribbean/index.html" : `${rel}.html`;
    if (!pages.has(file)) fail("MANIFEST", `${r.url} in manifest but no page generated`);
  }
  // Homepage destination navigation must only reference manifest routes.
  const home = pages.get("index.html");
  if (home) {
    for (const m of home.html.matchAll(/href="(\/caribbean\/[a-z0-9-]+)"/g)) {
      if (!manifestUrls.has(`${ORIGIN}${m[1]}`)) fail("NAV-MANIFEST", `homepage links ${m[1]} which is not a published route`);
    }
  }
}

// ---------- INDEXABILITY_REPORT.csv ----------
{
  const rows = [["url", "template", "indexable", "robots", "canonical", "in_sitemap"]];
  const sitemapLocs = new Set([...read("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
  for (const [f, p] of pages) {
    const template = f === "index.html" ? "home"
      : f.startsWith("resort/") ? "resort"
      : f.startsWith("from/") ? "from"
      : f.startsWith("compare/") ? "compare"
      : f === "caribbean/index.html" ? "index"
      : /caribbean\/[^/]+\/[^/]+\.html/.test(f) || /caribbean\/best-/.test(f) ? "theme"
      : f.startsWith("caribbean/") ? "country" : "static";
    const u = urlOf(f);
    rows.push([u, template, String(isIndexable(p)), p.robots, p.canonical, String(sitemapLocs.has(u))]);
  }
  writeFileSync(join(ROOT, "INDEXABILITY_REPORT.csv"), rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n") + "\n");
}

// ---------- summary ----------
const indexableCount = [...pages.values()].filter(isIndexable).length;
console.log(`Crawled ${pages.size} pages (${indexableCount} indexable). JSON-LD blocks validated: ${ldChecked}.`);
for (const w of warnings) console.log("WARN " + w);
if (failures.length) {
  for (const f of failures) console.error("FAIL " + f);
  console.error(`\n${failures.length} failure(s).`);
  process.exit(1);
}
console.log("All site validation checks passed.");
