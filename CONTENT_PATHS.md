# CONTENT_PATHS.md — production content-path trace

Every production output, its source, generating code, timing, caching, eligibility filter, and canonicalization. All generated pages are **build-time static** (no runtime rendering); caching is Vercel CDN per `vercel.json` (`s-maxage=86400, stale-while-revalidate=604800` for generated trees; `must-revalidate` for `/` and `*.html`). "Regeneration" = `node scripts/generate-seo-pages.mjs`, run manually or by the weekly `refresh-seo-pages.yml` workflow (which first refreshes the snapshot from Supabase).

Data lineage: Supabase `resorts` table (+ `hotel_rate_offers` for all-inclusive evidence) → `seo_resort_snapshot` view (canonical field definitions, migration `20260713_seo_resort_snapshot_view.sql`) → `seo_snapshot` edge function → `scripts/fetch-seo-snapshot.mjs` → **`data/resorts-seo.json`** (committed). Reviews: `resort_reviews_raw` + `resort_family_signals` → `data/resort-review-seo.json`. Photos: `data/resort-liteapi-hero.json`.

| Output | Source | Function (scripts/generate-seo-pages.mjs unless noted) | Timing | Eligibility filter | Canonicalization |
|---|---|---|---|---|---|
| Homepage resort count | `data/resorts-seo.json` → `STATS` | `patchCounts()` regex patches into `index.html` | build | `familyEligible()` for "family resorts"; total for "properties" | n/a |
| Homepage destination count | same → `STATS.countries` | `patchCounts()` | build | countries present in snapshot | n/a |
| Homepage destination nav links | snapshot `byCountry` | `patchCounts()` (rewrites `.seo-dest-links`) | build | per-country `familyEligible` counts shown | routes must exist in `data/route-manifest.json` (validator-enforced) |
| Destination index (`/caribbean`) | snapshot | `destinationsIndex()` | build | family counts; adults-only counted separately | self-canonical `${ORIGIN}/caribbean` |
| Destination page inventory | `byCountry` map | `countryPage()` — `familyList` grid + labeled `adultList` link section | build | grid/picks/toddler/teen/easy-reach: `familyEligible()` only | self-canonical `countryPath()`; `noindex` when family-eligible < 5 |
| Attribute ("best") page inventory | snapshot filtered by `THEMES[].match` | `themeGlobalPage()` / `themeCountryPage()` | build | every theme match requires `familyEligible(r)` AND the verified attribute; AI theme requires provider-verified `all_inclusive` | self-canonical; pages only generated at ≥ 5 matches |
| Family-size page inventory | `family_max` (provider room-occupancy caps) | themes `resorts-for-family-of-5` / `large-family-resorts` | build | `familyEligible` + `family_max >= 5/6` | as above |
| Resort pages | snapshot row + review bundle | `resortPage()` (family_allowed) / `adultResortPage()` (all others) | build | `familyEligible()` selects the template; ineligible = neutral + noindex | self-canonical `resortPath()`; one page per canonical row (DB unique provider-ID index + source dedupe) |
| Related resorts module | same-country rows | `siblings` similarity sort inside `resortPage()` | build | same-eligibility-class only | links only to generated resort routes |
| FAQs | snapshot fields | `resortFaq()`, `countryFaq()`, `themeFaq()`; zero-guards via `countAnswer()` pattern | build | family FAQs only on family_allowed pages; adult pages get neutral FAQ | rendered + matching FAQPage JSON-LD |
| Metadata (title/desc/OG) | page builders → `shell()` | `shell()` | build | titles never claim attributes the filter didn't enforce (validator `AI-TITLE`) | canonical + og:url = self URL |
| JSON-LD | page builders | `hotelLd`/`crumbLd`/`collectionLd`/`faqJsonLd` in each builder | build | ItemLists contain family_allowed only; adult pages carry neutral Resort schema | URLs inside LD are canonical `${ORIGIN}` URLs |
| Sitemap | route data during generation | sitemap section + `lastmodFor()` (content-hash via `data/lastmod.json`) | build | indexable routes only (no adult resorts, no thin countries, no `/from`) | extensionless canonical-host URLs only (validator-enforced) |
| Internal destination links | `countries`/`byCountry` | footer + section links in `shell()` and page builders | build | theme/country links only to generated (manifest) routes | extensionless |
| Live search results (runtime) | Supabase edge functions (`Search` → `process_search_batch` → `start_pricing` → `get_packages`) | client JS in `index.html` / `resort-booking.js` | runtime | search UI prices all bookable properties (incl. adults-only for kid-free parties); not crawlable — client-rendered, no crawlable parameter URLs | n/a (not indexable surface) |

Enforcement: `scripts/lib/family-rules.mjs` (shared rules) · `scripts/tests/*.test.mjs` (36 unit + canary tests) · `scripts/validate-site.mjs` (build crawl, block­ing) · `scripts/crawl-production.mjs` (deployed-site crawl) · `.github/workflows/ci.yml` (every push).
