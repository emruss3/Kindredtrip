#!/usr/bin/env node
// fetch-seo-snapshot.mjs
//
// Pulls the live catalogue snapshot from the seo_snapshot edge function
// and writes data/resorts-seo.json for generate-seo-pages.mjs. Run by
// the refresh-seo-pages GitHub Action (and usable locally).
//
//   node scripts/fetch-seo-snapshot.mjs
//
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const URL = process.env.SUPABASE_URL || "https://wyqbtcuoorclmirepkuo.supabase.co";
// The anon key is public by design (it ships in the site's JS).
const ANON = process.env.SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind5cWJ0Y3Vvb3JjbG1pcmVwa3VvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3MzQ0MDMsImV4cCI6MjA4NjMxMDQwM30.LfZX0hMgJJQ5f-euBE4nRZnPQ4Kpc7IN3c1t9ht4Zbc";

const res = await fetch(`${URL}/functions/v1/seo_snapshot`, {
  headers: { Authorization: `Bearer ${ANON}` },
});
if (!res.ok) {
  console.error(`seo_snapshot returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const rows = await res.json();
if (!Array.isArray(rows) || rows.length < 100) {
  console.error(`Refusing to write snapshot: got ${Array.isArray(rows) ? rows.length : typeof rows} rows (expected 100+).`);
  process.exit(1);
}

// Guard against silent catalogue collapse: refuse a snapshot that shrank
// more than 20% vs the committed one (that smells like a bad upstream
// filter, not real catalogue churn).
const out = join(ROOT, "data/resorts-seo.json");
if (existsSync(out)) {
  const prev = JSON.parse(readFileSync(out, "utf8"));
  if (rows.length < prev.length * 0.8) {
    console.error(`Refusing to write snapshot: ${rows.length} rows vs ${prev.length} previously (>20% shrink).`);
    process.exit(1);
  }
}

rows.sort((a, b) => `${a.country}|${a.resort_name}`.localeCompare(`${b.country}|${b.resort_name}`));
writeFileSync(out, JSON.stringify(rows));
console.log(`Wrote ${rows.length} resorts to data/resorts-seo.json`);
