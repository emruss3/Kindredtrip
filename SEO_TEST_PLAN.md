# SEO_TEST_PLAN.md

## Unit tests — `node --test scripts/tests/*.test.mjs` (26 tests)
Family eligibility (adults/couples/brand keywords/age gates/uncertain/whitelist/Beaches regression), all-inclusive copy gate, zero/one/many grammar (no "Yes — 0", no affirmative from unknown), family-friendly gating, toddler-fit age guards, ranking penalty for ineligible properties, review snippet truncation + sentiment-conflict, airport display format, indexability gates per template, display-name cleaning.

## Integration/crawl tests — `node scripts/validate-site.mjs` (post-build, build-blocking)
Crawls every generated page (900) and checks: no ineligible resort linked in any family context; ineligible resort pages are noindexed, free of family language and kids FAQs; all-inclusive page lists only verified-AI properties; zero-count grammar; duplicate data rows; one H1 per indexable page; self-canonical (exact, extensionless, canonical host); unique titles; sitemap contains only existing+indexable+self-canonical URLs (no `.html`, no uppercase, no noindexed templates); sitewide counts match `data/site-stats.json`; no disallowed business-model language; airport "IATA — Name" format; JSON-LD parses and matches eligibility; orphan detection. Emits `INDEXABILITY_REPORT.csv`.

## CI — `.github/workflows/ci.yml` (build-blocking on every push/PR)
unit tests → inline-JS syntax checks → regenerate → drift check (generated output must be committed; HTML is deterministic) → site validator → JSON snapshot parse.

## Lighthouse
Not yet in CI (no stable headless-Chrome harness in the build environment). Recommended: `treosh/lighthouse-ci-action` against a Vercel preview, budgets LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 for /, /caribbean, one large country page, one theme page, one resort page.

## Manual validation steps
1. After deploy: Google Rich Results Test + Schema.org validator on one resort page, one country page, one best page, the Atlantis-vs-Baha-Mar compare page.
2. Search Console: submit `sitemap.xml`; URL-inspect one page per new template.
3. `node scripts/validate-site.mjs` against the deployed output after every major deployment (rerunnable route-validation script).
4. Spot-check Vercel redirects: `/about.html` → `/about` (single 308 hop), `/caribbean/brazil` → `/caribbean` (301).
