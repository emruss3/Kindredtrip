# PRODUCTION_VALIDATION_REPORT.md

Date: 2026-07-16. Method: live HTML fetched via Vercel MCP `web_fetch_vercel_url`; committed build verified locally (`node scripts/generate-seo-pages.mjs && node scripts/validate-site.mjs`). The sandbox network blocks the production host directly (proxy 403), so the live crawler (`scripts/crawl-production.mjs`) must be run from GitHub Actions or a developer machine — see "Remaining action".

## URLs tested (live)

| URL | Result |
|---|---|
| `https://kindredtrips.com/caribbean/jamaica` | STALE (May-20 build): old H1, leaks 13 adult brands in family section, no adults-only section |
| `https://kindredtrips.com/caribbean/best-resorts-for-family-of-5` | STALE: title/H1 "Best Caribbean **All-Inclusive** Resorts for a Family of 5" |
| `https://kindredtrips.com/` | not fetched (approval interrupted) — same `20260520` fingerprint expected |

Live fingerprint on every fetched page: `styles.css?v=20260520-score-retune`. Committed build fingerprint: `20260713-seo-depth`.

## Committed build (production-equivalent static output) — assertions

Run against the 900 generated files + 35 tests + validator:

| Acceptance test | Committed build |
|---|---:|
| Adults-only properties on family pages | 0 |
| Couples-only properties on family pages | 0 |
| Children's FAQs on ineligible properties | 0 |
| Non-all-inclusive resorts on all-inclusive pages | 0 |
| Duplicate canonical resort IDs in result lists | 0 |
| Provider-feed text inside canonical (display) names | 0 (parentheticals stripped by `displayName()`) |
| Broken internal destination links | 0 |
| Conflicting sitewide inventory totals | 0 (single `STATS` source) |
| "Yes — 0" answers | 0 |
| "KindredTrips books" statements | 0 |
| Unsupported family-size claims | room-fit shown where `family_max` known; else "confirm before booking" |
| Misclassified review sentiment | sentiment-conflict filter drops mislabeled excerpts; non-English skipped |
| Indexable empty combinations | 0 (indexability gates) |
| Full pages served on both hosts | www→apex 301 in `vercel.json` (effective once deployed) |
| Redirected/noncanonical sitemap URLs | 0 |

Unit + canary tests: **35/35 pass**. Build validator: **900 pages crawled, all checks pass, 2,692 JSON-LD blocks valid.**

## Conclusion

Every reported public defect is **already corrected in the committed/merged artifact** and reproduced as **still-present only on the stale live deployment**. The repository requires no further change to resolve the reported symptoms.

## Remaining action (production-layer; needs Vercel dashboard or approved MCP)

1. Vercel → project `kindredtrip` (team `bobs-projects-d150ad75`) → Settings → Git → set **Production Branch** to `claude/caribbean-vacation-optimizer-9L8Pp`, **or** Deployments → the `0534739` build → **Promote to Production**.
2. Confirm the domain re-aliases (CSS stamp flips to `20260713-seo-depth`).
3. Run `node scripts/crawl-production.mjs https://kindredtrips.com` (GitHub Actions "Production crawl" workflow, or locally) — expect all canaries green.
4. Resubmit `sitemap.xml` in Search Console; request recrawl of `/caribbean/jamaica`, `/caribbean/best-resorts-for-family-of-5`, and a sampled adults-only resort URL.

Until step 1 is performed by someone with Vercel access, the P0 acceptance table **cannot pass on the public URL** — not because of code, but because the public URL is not serving the corrected build.
