#!/usr/bin/env node
// submit-indexnow.mjs
//
// Push the sitemap's URLs to IndexNow (Bing, Yandex, Seznam, Naver —
// Google does not consume IndexNow; submit the sitemap once in Google
// Search Console instead). Safe to re-run: IndexNow treats resubmission
// of unchanged URLs as a no-op hint.
//
//   node scripts/submit-indexnow.mjs             # submit every sitemap URL
//   node scripts/submit-indexnow.mjs url1 url2   # submit specific URLs
//
// The key file (<key>.txt) is served from the site root so the endpoint
// can verify domain ownership — it must be deployed before this works.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "kindredtrips.com";
const KEY = "13df83c37f3c04cdaa1e3ad4ba096081";

const args = process.argv.slice(2);
const urls = args.length
  ? args
  : [...readFileSync(join(ROOT, "sitemap.xml"), "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

if (!urls.length) {
  console.error("No URLs to submit.");
  process.exit(1);
}

// IndexNow accepts up to 10,000 URLs per POST; chunk defensively anyway.
let ok = 0;
for (let i = 0; i < urls.length; i += 5000) {
  const chunk = urls.slice(i, i + 5000);
  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: HOST,
      key: KEY,
      keyLocation: `https://${HOST}/${KEY}.txt`,
      urlList: chunk,
    }),
  });
  // 200 = processed, 202 = accepted for processing — both fine.
  if (res.status === 200 || res.status === 202) {
    ok += chunk.length;
    console.log(`Submitted ${chunk.length} URLs (HTTP ${res.status}).`);
  } else {
    console.error(`IndexNow returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
}
console.log(`Done — ${ok}/${urls.length} URLs pushed to IndexNow.`);
