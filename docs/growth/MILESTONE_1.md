# Growth milestone 1 — launch blockers

Branch `feat/growth-phase1`, stacked on PR #51 (`feat/search-defaults-and-visibility`).
Covers the first-sprint blockers in the Family Trip Cost Explorer scope (§6): Belize, traveler handling,
landing-page intent and funnel measurement. Nothing here is deployed; production release is an owner action
(see the runbook below).

## What shipped

| Change | Commit | Result |
|---|---|---|
| Belize recovery | `cc9e13a5` | `/caribbean/belize` is an indexable, answer-first guide; the old ranking URL 301s to it in one hop |
| Traveler handling | `30711fcb` | Deep-linked parties are no longer replaced by the default "2 adults + 1 child aged 8" |
| Price surfaces (PR #51) | `85bcb147` | The remaining places a non-live total could appear are gated on live rates |
| Funnel measurement | `d1360ac6`, `1f2aa4d9` | Five funnel events with landing-page attribution; search details removed from GA4 URLs |
| Guide intent | `6ce53c62` | Water-park and family-of-5 guides carry their filter / party into search |

## Implementation notes — traced entry points

| Concern | Files and functions |
|---|---|
| Routes / hosting | Static files on Vercel; `vercel.json` (cleanUrls, redirects, cache headers). No build step. |
| Redirects | `vercel.json` `redirects` (Belize 301s added; host and retired-country rules unchanged) |
| Page + sitemap generation | `scripts/generate-seo-pages.mjs`: `shell()`, `countryPage()`, `editorialCountryPage()` (new), `themeGlobalPage()`, `searchWidget()`, `patchCounts()`, `lastmodFor()`; data in `data/resorts-seo.json`, `data/editorial/*.json` (new) |
| Indexability rules | `scripts/lib/family-rules.mjs` `indexability()` (editorial override added), `GATES` |
| Analytics / consent | GA4 `G-4WHVMCP4Z0` in `index.html` head and generator `GA_CONFIG`; first-party `trackEvent()` → `supabase/functions/log_event` → `search_signals`. **No consent mechanism exists.** |
| Public search form | `index.html` `#search-form` (hero), `#popover-form` (edit search); landing pages use generator `searchWidget()` (`.seo-wizard-form`, GET to `/`) |
| Query parsing | `party.js` (new, shared); `index.html` `hydrateFromDeepLink()`, initial-population block, `runSearchFromPopover()` |
| Search + pricing calls | `index.html` `runSearch()` → `callFn("Search")` → `process_search_batch` → `start_pricing` → `price_flights_worker` / `top_up_hotels_worker`; results via `get_packages` (`refetchPackages()`) |
| Room eligibility | `start_pricing` / `top_up_hotels_worker` `buildOccupancies()` (N-room split, summed multi-room offers); trip detail room list fit filter |
| Results UI | `index.html` `renderResults()`, `renderCard()`, `renderHeroCard()`, `renderPendingCard()`, `isPricesPending()`, `isLivePkg()` |
| Outbound booking links | `index.html` `bookHotel()` / `bookFlight()` → `generate_booking_redirect` (Booking.com via Travelpayouts, Aviasales) |

## Priority URL baseline (repo state: production `main` vs this branch)

| URL | | status | robots | canonical | title | in sitemap | primary CTA |
|---|---|---|---|---|---|---|---|
| `/caribbean/belize/beachfront-resorts` | before (`main`) | 404 | — | — | — | no | — |
| `/caribbean/belize/beachfront-resorts` | after | 301 → /caribbean/belize | — | — | — | no | — |
| `/caribbean/belize` | before (`main`) | 200 | noindex | self | Belize Family Resort Guide | no | Compare trips → |
| `/caribbean/belize` | after | 200 | index | self | Best Family Resorts in Belize: Where to Stay With Kids | yes | Compare trips → |
| `/from/bna/family-vacations` | before (`main`) | 200 | noindex | self | Best Family Vacations from Nashville (BNA) — Ranked | no | Compare trips → |
| `/from/bna/family-vacations` | after | 200 | noindex | self | Best Family Vacations from Nashville (BNA) — Ranked | no | Compare trips → |
| `/caribbean/best-water-park-resorts` | before (`main`) | 200 | index | self | Best Caribbean Family Resorts with a Water Park | yes | link to homepage form |
| `/caribbean/best-water-park-resorts` | after | 200 | index | self | Best Caribbean Family Resorts with a Water Park | yes | Compare total trip cost → |
| `/caribbean/best-resorts-for-family-of-5` | before (`main`) | 200 | index | self | Best Caribbean Resorts for a Family of 5 | yes | link to homepage form |
| `/caribbean/best-resorts-for-family-of-5` | after | 200 | index | self | Best Caribbean Resorts for a Family of 5 | yes | Compare total trip cost → |
| `/caribbean/aruba` | before (`main`) | 200 | index | self | Aruba Family Vacation Guide — 12 Resorts Ranked by Trip Cost | yes | Compare trips → |
| `/caribbean/aruba` | after | 200 | index | self | Aruba Family Vacation Guide — 12 Resorts Ranked by Trip Cost | yes | Compare trips → |
| `/caribbean/aruba/all-inclusive-family-resorts` | before (`main`) | 200 | index | self | Best All-Inclusive Family Resorts in Aruba — Ranked by Famil | yes | Compare trips → |
| `/caribbean/aruba/all-inclusive-family-resorts` | after | 200 | index | self | Best All-Inclusive Family Resorts in Aruba — Ranked by Famil | yes | Compare trips → |
| `/caribbean/costa-rica/all-inclusive-family-resorts` | before (`main`) | 200 | index | self | Best All-Inclusive Family Resorts in Costa Rica — Ranked by  | yes | Compare trips → |
| `/caribbean/costa-rica/all-inclusive-family-resorts` | after | 200 | index | self | Best All-Inclusive Family Resorts in Costa Rica — Ranked by  | yes | Compare trips → |
| `/compare/aruba-vs-turks-and-caicos` | before (`main`) | 404 | — | — | — | no | — |
| `/compare/aruba-vs-turks-and-caicos` | after | 404 | — | — | — | no | — |

Findings for later milestones: `/from/bna/family-vacations` — the Nashville pilot page — is **noindexed**
(airport pages need real airfare data to index); `/compare/aruba-vs-turks-and-caicos` does not exist yet.

## Belize decision

Consolidated into `/caribbean/belize` (owner-approved). Belize has 4 resorts that admit children; only Alaia and
Belizean Dreams fit a family of 4+ in one unit; Thatch Caye rooms sleep 2; Manta Island has no partner data
("Check directly with the resort"). The old page listed two adults-only resorts (Coco Plum, Matachica); they stay
out of the shortlist. Indexing uses an editorial override: a country guide may index below 5 family-eligible
resorts when `data/editorial/<slug>.json` exists (sources + verification date) and at least one resort is
family-eligible — independent of booking availability. Room and policy facts were verified 2026-05-12 from
LiteAPI hotel data; re-verify before editing.

## Funnel events

| Event | Fires | Key fields |
|---|---|---|
| `trip_search_started` | Search accepted (search_id returned), once per attempt | origin, party_size, kids_count, filters |
| `trip_search_results` | Outcome reached, once per attempt | outcome = `results` / `no_match`, result_count |
| `trip_price_shown` | First complete live flight+hotel total rendered in results, once per attempt | complete_price_count, ms_to_price |
| `booking_partner_click` | Every outbound click | partner (`booking.com` / `aviasales`), placement, price_complete |
| `trip_search_error` | User-visible error | error_category (`provider_error`, `request_error`, `network`, `timeout`, `pricing_unavailable`, `invalid_input`, `unknown`), stage |

Every event carries `search_id` (anonymous), `landing_path`, `landing_type`, `entry_path`, `entry_type`, `channel`,
`utm_source/medium/campaign`, `page_path`. Never: travel dates, children's ages, raw query strings.
GA4 page URLs keep only `utm_*`/`gclid`; referrers drop their query. `trip_price_shown` is judged from the rendered
page, and only fully live round-trip packages render a live price label, so partial prices cannot fire it.

### 28-day scorecard (first-party, `search_signals`)

```sql
-- Trailing 28 days, excluding internal traffic. Swap the interval for 14/30/60/90-day reviews.
with ev as (
  select session_id, search_id, signal_type, payload, created_at
  from search_signals
  where created_at >= now() - interval '28 days' and is_internal is not true
)
select coalesce(payload->>'landing_type','(unknown)') as landing_type,
       coalesce(payload->>'landing_path','(unknown)') as landing_path,
       coalesce(payload->>'channel','(unknown)')      as channel,
       count(distinct search_id)  filter (where signal_type='trip_search_started')   as unique_search_starts,
       count(distinct search_id)  filter (where signal_type='trip_price_shown')      as searches_with_complete_price,
       count(distinct session_id) filter (where signal_type='booking_partner_click') as partner_click_sessions,
       count(*)                   filter (where signal_type='booking_partner_click') as partner_clicks_total,
       count(distinct search_id)  filter (where signal_type='trip_search_results' and payload->>'outcome'='no_match') as no_match_searches,
       count(distinct search_id)  filter (where signal_type='trip_search_error')     as error_searches
from ev group by 1,2,3 order by unique_search_starts desc;
```

Segments for the scope (Belize, Aruba, water parks, Costa Rica, comparisons, Nashville) map to `landing_path`
prefixes (`/caribbean/belize`, `/caribbean/aruba%`, `/caribbean/best-water-park-resorts`, `/caribbean/costa-rica%`,
`/compare/%`, `/from/bna/%`). Report raw denominators; at current volume, treat rates as provisional.

**Pre-release first-party baseline** (existing events, internal excluded; new events have no history):

| Period (UTC) | Search sessions | Searches | Results painted | Booking-click sessions | Booking clicks |
|---|---:|---:|---:|---:|---:|
| 2026-10-12 → 2026-11-09 | 7 | 15 | 14 | 2 | 2 |
| 2026-09-14 → 2026-10-12 | 7 | 15 | 6 | 1 | 2 |

Comparability caveat: before `30711fcb`, every landing-page search ran with the default party, and before this
milestone `trip_*` events did not exist — compare like-for-like events and log the release date.

### GA4 setup (owner, one-time)

1. Admin → Events: mark `booking_partner_click` as a key event (and optionally `trip_price_shown`).
2. Admin → Custom definitions: register event-scoped dimensions `landing_path`, `landing_type`, `entry_path`,
   `channel`, `partner`, `placement`, `outcome`, `error_category`.
3. Unique sessions with a partner click = Explorations → sessions with event `booking_partner_click`;
   total clicks = event count. Partner-confirmed bookings/commissions are a separate feed (not wired).

## Release runbook (owner)

Order matters: the log_event allowlist must accept the new events before the frontend sends them.

1. `supabase functions deploy log_event` (v2 allowlist). Verify: `curl -s -X POST …/functions/v1/log_event`
   with `{"signal_type":"trip_search_started"}` returns `{"ok":true}`.
2. Merge PR #51, then `supabase functions deploy Search` (from PR #51; defense in depth).
   `process_search_batch` needs no deploy.
3. Merge this PR → Vercel deploys the static site.
4. Verify on production:
   - `curl -sI https://kindredtrips.com/caribbean/belize/beachfront-resorts` → `301`, `location: /caribbean/belize`;
     the target returns `200`, `index`, self-canonical. `scripts/crawl-production.mjs` (Production crawl workflow)
     now checks this automatically, including the trailing-slash and `?utm_…` variants.
   - A real search from `/from/bna/family-vacations` with kids `8, 6, 3` shows "2 adults, 3 kids".
   - GA4 Realtime shows `trip_search_started` → `trip_price_shown` → `booking_partner_click`;
     `search_signals` receives the same rows.
5. Search Console: inspect `https://kindredtrips.com/caribbean/belize/beachfront-resorts` (expect "Page with
   redirect") and `https://kindredtrips.com/caribbean/belize` (request indexing). Resubmit `sitemap.xml`.
   Track "family resorts in belize" and related beachfront queries; give Google days to weeks to recrawl.
   The "24 of 38 visits" figure is a Semrush estimate — judge recovery from Search Console.
6. Rollback by change: revert the commit and redeploy. Belize: remove the three `vercel.json` rules and
   `data/editorial/belize.json` (page returns to noindex). Funnel: revert `d1360ac6`/`1f2aa4d9` (log_event v2 is
   harmless to keep). Traveler fix: revert `30711fcb`.

## Access and gaps for the owner

- **Search Console**: no access from this environment — export U.S. web clicks/impressions by page and query for the
  prior 28 and 90 days (and the preceding periods) to set the first-party baseline; brand vs nonbrand split.
- **Consent**: none exists. GA4 runs on every page without a consent banner or Consent Mode. Decide whether U.S.-only
  traffic needs one (e.g. CCPA/GPC handling) before adding marketing tags.
- **Semrush Organic Traffic Insights** was still at Google connection setup.
- **Snapshot refresh**: `refresh-seo-pages.yml` has failed every scheduled run since August; counts and inventory on
  generated pages are frozen at 2026-07-20 until it is fixed.

## Tests run

| Check | Kind | Result |
|---|---|---|
| `node --test scripts/tests/*.test.mjs` | unit (party parser, editorial guard, log_event allowlist, GA sanitizer, family rules) | 51/51 |
| `scripts/validate-site.mjs` | full static crawl | pass (616 indexable) |
| CI inline-JS check, `node --check` party.js / resort-booking.js / log_event | syntax | pass |
| Generator idempotency + SEO-page drift | build | pass |
| Traveler regression, Chromium (BNA form, infant, adults-only, single child, whitespace, invalid, reload, autostart, edit after results, 390px) | fixture backend | 12/12; same harness on old code reproduces the bug |
| Funnel acceptance, Chromium (one tracked visit; partial → no price event; order; dedupe; attribution; privacy) | fixture backend | 12/12 |
| No-match and provider-error outcomes | fixture backend | 2/2 |
| Guide handoff (water-park filter, family-of-5 ages) at 1280px and 390px | fixture backend | 7/7 |
| Belize page with JS disabled at 390px | static HTML | pass |
| Live provider checks | live | not run in this milestone (pricing pipeline unchanged here; group pricing verified live in an earlier change) |
