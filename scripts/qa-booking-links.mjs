#!/usr/bin/env node
// qa-booking-links.mjs
//
// Browser-based QA for verified Booking.com property URLs. Unlike the
// qa_booking_links edge function (which Booking serves an anti-bot challenge
// to, defeating name matching), this drives a real Chromium via Playwright so
// the rendered page title/heading is readable — enabling true name + country
// verification on top of 404 / search-redirect detection.
//
// Flags, per resort with a booking_property_url:
//   not_found            -> 404 or "Page Not Found"
//   redirected_to_search -> final URL left the /hotel/ page
//   name_mismatch        -> rendered page name doesn't match the resort
//   country_mismatch     -> rendered page location doesn't match the country
//   ok                   -> resolves to the right hotel page
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (read resorts; optional write-back
// with --write). Usage:
//   node scripts/qa-booking-links.mjs --limit 100 [--write]
// Requires booking.com network access (won't run behind a booking.com-blocking
// proxy). Chromium is preinstalled at /opt/pw-browsers in CI images.

import { chromium } from "playwright";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).");
  process.exit(1);
}
const args = process.argv.slice(2);
const limit = Number((args.find((a) => a.startsWith("--limit="))?.split("=")[1]) ?? (args.includes("--limit") ? args[args.indexOf("--limit") + 1] : 100));
const WRITE = args.includes("--write");

const STOP = new Set(["the","and","a","an","resort","resorts","hotel","hotels","spa","by","all",
  "inclusive","collection","suites","suite","villas","villa","beach","bay","at","de","la","el",
  "los","las","club","grand","royal","premium","golf","family"]);
const norm = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const toks = (s) => norm(s).split(" ").filter((t) => t.length >= 4 && !STOP.has(t));

async function fetchResorts() {
  const url = `${SUPABASE_URL}/rest/v1/resorts?select=resort_id,resort_name,country,booking_property_url,review_count`
    + `&service_excluded=eq.false&booking_property_url=not.is.null`
    + `&order=review_count.desc.nullslast&limit=${limit}`;
  const r = await fetch(url, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  if (!r.ok) throw new Error(`resorts fetch failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function writeStatus(resort_id, status, confidence) {
  await fetch(`${SUPABASE_URL}/rest/v1/resorts?resort_id=eq.${resort_id}`, {
    method: "PATCH",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ booking_status: status, booking_match_confidence: confidence, booking_last_verified_at: new Date().toISOString() }),
  });
}

const rows = await fetchResorts();
console.log(`Checking ${rows.length} resorts with a verified Booking URL…\n`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "en-US", userAgent:
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" });
const tally = {}; const flagged = [];

for (const r of rows) {
  const page = await ctx.newPage();
  let status = "ok", confidence = 1, note = "";
  try {
    const resp = await page.goto(r.booking_property_url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const finalUrl = page.url();
    const httpStatus = resp?.status() ?? 0;
    const bodyText = norm(await page.evaluate(() => document.body?.innerText || "").catch(() => ""));
    const title = norm(await page.title().catch(() => ""));

    if (httpStatus === 404 || /page not found|we can.t find this page/.test(bodyText)) {
      status = "not_found"; confidence = 0; note = `http ${httpStatus}`;
    } else if (!/\/hotel\//.test(finalUrl) || /searchresults|\/destination/.test(finalUrl)) {
      status = "redirected_to_search"; confidence = 0.1; note = finalUrl;
    } else {
      const want = toks(r.resort_name);
      const hit = want.filter((t) => title.includes(t) || bodyText.slice(0, 4000).includes(t)).length;
      const ratio = want.length ? hit / want.length : 1;
      const countryOk = !r.country || bodyText.slice(0, 8000).includes(norm(r.country));
      if (ratio < 0.5) { status = "name_mismatch"; confidence = Number(ratio.toFixed(2)); note = `name ${hit}/${want.length} | title="${title.slice(0,60)}"`; }
      else if (!countryOk) { status = "country_mismatch"; confidence = Number(ratio.toFixed(2)); note = `country "${r.country}" not on page`; }
      else { status = "ok"; confidence = Number(ratio.toFixed(2)); note = `name ${hit}/${want.length}`; }
    }
  } catch (e) {
    status = "error"; confidence = 0; note = String(e?.message ?? e).slice(0, 120);
  }
  await page.close();
  tally[status] = (tally[status] ?? 0) + 1;
  if (status !== "ok") flagged.push({ name: r.resort_name, status, note, url: r.booking_property_url });
  if (WRITE) await writeStatus(r.resort_id, status, confidence);
  process.stdout.write(status === "ok" ? "." : "x");
}

await browser.close();
console.log("\n\n=== QA summary ===");
console.log(tally);
if (flagged.length) {
  console.log(`\n=== ${flagged.length} flagged ===`);
  for (const f of flagged) console.log(`[${f.status}] ${f.name}\n    ${f.note}\n    ${f.url}`);
}
console.log(WRITE ? "\n(booking_status written back to DB)" : "\n(dry run — pass --write to persist booking_status)");
