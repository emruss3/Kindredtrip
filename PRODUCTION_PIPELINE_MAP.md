# PRODUCTION_PIPELINE_MAP.md — actual production content architecture

There is exactly **one** content pipeline. There is **no** separate runtime dataset, no server rendering, and no deploy-time regeneration.

Lineage: Supabase `resorts` (+ `hotel_rate_offers` for all-inclusive evidence) → view `seo_resort_snapshot` (migration `20260713_seo_resort_snapshot_view.sql`) → edge fn `seo_snapshot` → `scripts/fetch-seo-snapshot.mjs` → committed **`data/resorts-seo.json`** → `scripts/generate-seo-pages.mjs` → committed static HTML → Vercel static passthrough (`vercel.json`, `cleanUrls`, no `buildCommand`).

| Output | Data source | Query/function | Build/runtime | Cache/revalidation | Filters applied |
|---|---|---|---|---|---|
| Homepage counts | `data/resorts-seo.json`→`STATS` | `patchCounts()` | build | Vercel CDN, `must-revalidate` on `/` | `familyEligible()` for family count; total for properties |
| Homepage destination links | `byCountry` + `data/route-manifest.json` | `patchCounts()` rewrites `.seo-dest-links` | build | CDN | per-country `familyEligible` counts; validator forbids links to unpublished routes |
| Destination index | snapshot | `destinationsIndex()` | build | CDN `s-maxage=86400` | family counts; adults-only counted separately |
| Destination pages | `byCountry` | `countryPage()` (`familyList` grid + labeled `adultList`) | build | CDN `s-maxage=86400` | `familyEligible()` for all family modules; `noindex` if `<5` |
| Attribute pages | snapshot × `THEMES[].match` | `themeGlobalPage()`/`themeCountryPage()` | build | CDN | `familyEligible` + verified attribute; AI theme needs `all_inclusive===true` |
| Family-size pages | `family_max` (provider room caps) | theme `resorts-for-family-of-5`/`large-family` | build | CDN | `familyEligible` + `family_max>=5/6` |
| Toddler pages | `infants`/`cribs`/`kc_min` | theme `resorts-for-toddlers` | build | CDN | `familyEligible` + `toddlerFit()` |
| Resort pages | snapshot row + reviews | `resortPage()` (family) / `adultResortPage()` (else) | build | CDN `s-maxage=86400` | `familyEligible()` picks template; ineligible→neutral+`noindex` |
| Related resorts | same-country rows | `siblings` in `resortPage()` | build | CDN | same eligibility class only |
| FAQs | snapshot fields | `resortFaq()/countryFaq()/themeFaq()` + `countAnswer()` | build | CDN | family FAQs only on `family_allowed`; zero-guarded |
| Metadata | page builders→`shell()` | `shell()` | build | CDN | titles derive from applied filter; validator `AI-TITLE` blocks unverified all-inclusive titles |
| JSON-LD | page builders | `hotelLd/crumbLd/collectionLd/faqJsonLd` | build | CDN | family ItemLists = `family_allowed` only |
| XML sitemap | route data + `data/lastmod.json` | sitemap section, `lastmodFor()` | build | CDN | indexable only; no adult resorts / thin countries / `/from` |
| Internal links | `data/route-manifest.json` | footer + builders | build | CDN | manifest routes only |
| Interactive search (runtime) | Supabase edge fns | client JS | runtime | none | prices all bookable properties; **not a crawlable/indexable surface** |

### Checks against the failure modes listed in the brief
- Separate static/runtime datasets: **No** (search is client-only, non-indexable).
- Old generated JSON / stale build artifacts in repo: **No** (single committed snapshot; deterministic regen verified — zero drift).
- Unpurged CDN output: **YES — this is the live defect.** The production alias points at the May-20 deployment.
- Multiple Supabase queries / eligibility helpers: **No** — one view, one `familyEligibility()` in `scripts/lib/family-rules.mjs`, imported by generator + validator + tests.
- Separate metadata vs body queries: **No** (same builder).
- Different sitemap vs page queries: **No** (same generation pass + manifest).
- Nulls defaulting to family-eligible: **No** — null `audience` → `uncertain` → excluded.
- Routes generated from raw destinations vs published routes: **No** — `data/route-manifest.json` is the single nav/sitemap source.
