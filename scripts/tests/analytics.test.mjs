// Every event the frontend sends must be accepted by the log_event edge
// function's allowlist — otherwise it is silently dropped (log_event always
// returns 200). This guard caught the five trip-funnel events missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const allowSrc = read("supabase/functions/log_event/index.ts");
const allowed = new Set([...allowSrc.slice(allowSrc.indexOf("new Set(["), allowSrc.indexOf("]);")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));

test("every frontend event name is on the log_event allowlist", () => {
  const sent = new Set();
  for (const file of ["index.html", "resort-booking.js"]) {
    for (const m of read(file).matchAll(/(?:trackEvent|trackFunnel|KT_trackEvent|logEvent)\(\s*"([a-z_]+)"/g)) sent.add(m[1]);
  }
  assert.ok(sent.size >= 10, `expected to find the frontend events (found ${sent.size})`);
  const missing = [...sent].filter((n) => !allowed.has(n));
  assert.deepEqual(missing, [], `not on the log_event allowlist (silently dropped): ${missing.join(", ")}`);
});

test("analytics page URLs keep only campaign params (homepage + generated pages)", () => {
  for (const src of [read("index.html"), read("caribbean/belize.html")]) {
    assert.match(src, /page_location:c\(location\.href,1\)/, "sanitized page_location");
    assert.match(src, /page_referrer:document\.referrer\?c\(document\.referrer,0\)/, "query-free page_referrer");
    assert.doesNotMatch(src, /gtag\('config', 'G-4WHVMCP4Z0'\);/, "no unsanitized config call");
  }
});
