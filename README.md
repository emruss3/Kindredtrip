# KindredTrips

Caribbean family-vacation discovery and booking. Instead of making you pick a destination first, KindredTrips compares complete trips — flights **plus** hotel — across every Caribbean airport and ~974 family-friendly resorts, ranked by total cost for your exact family.

**Live:** [kindredtrips.com](https://kindredtrips.com)

## Stack

- **Frontend:** single-file `index.html` (vanilla JS, no build step) + `styles.css` + `resort-booking.js` (inline booking widget on resort pages). Hosted on Vercel.
- **Backend:** Supabase Postgres + ~20 Deno Edge Functions.
- **Suppliers:** LiteAPI (live hotel + flight rates, booking), Travelpayouts/Booking.com (affiliate deep-links), Google Places (photos + geocoding), OpenAI (`text-embedding-3-small` for semantic search — requires `OPENAI_API_KEY`).
- **SEO:** ~1,010 statically-generated pages (resort + destination) built by `scripts/generate-seo-pages.mjs`.

## Repo layout

```
index.html                       # entire search/results/booking SPA
styles.css                       # all styles
resort-booking.js                # in-page live-booking widget for /resort/<slug>
robots.txt  llms.txt  sitemap.xml

resort/<slug>.html               # 974 generated resort pages (Hotel + Review JSON-LD)
caribbean/<country>.html         # 35 generated destination hubs (+ index)

scripts/
  generate-seo-pages.mjs         # static page + sitemap generator
data/
  resorts-seo.json               # catalogue snapshot (generator input)
  resort-liteapi-hero.json       # per-resort hero photo URLs
  resort-review-seo.json         # family signals + reviews for JSON-LD

supabase/functions/              # ~20 edge functions, see below
supabase/migrations/             # tracked DDL
```

## Core request flow

```
Browser ──POST /functions/v1/Search──▶ Search (validates, inserts row, fires worker)
        ──poll  /functions/v1/get_packages──▶ reads job.status + priced packages
        ──POST  /functions/v1/start_pricing──▶ live LiteAPI hotel + flight pricing
        ──GET   /functions/v1/get_hotel_offers / get_flight_offers──▶ rooms + flights
        ──POST  /functions/v1/generate_booking_redirect──▶ affiliate/booking deep-link
```

The browser **only** calls `/functions/v1/*`. It never touches Postgres directly — edge functions hold the service-role key and own all DB access. (RLS is enabled and locks anon out of every table; see Security.)

### Edge functions

| Function | Role |
|---|---|
| `Search` | Validates input, creates the search + job, fires `process_search_batch` |
| `process_search_batch` | Generates candidate packages from the resort catalogue |
| `start_pricing` | Live LiteAPI hotel + flight pricing; dispatches `top_up_hotels_worker` |
| `get_packages` | The API the frontend polls — packages + summary + job status |
| `get_hotel_offers` / `get_flight_offers` | Live rooms / flights for the trip modal |
| `generate_booking_redirect` | Affiliate URL builder + `outbound_clicks` logger |
| `get_resort_reviews` / `get_room_photos` | Trip-detail enrichment |
| `semantic_search_resorts` / `embed_resorts` | NL search (pgvector + OpenAI embeddings) |
| `ingest_liteapi_hotels` / `discover_liteapi_hotels` / `match_liteapi_to_resorts` | Catalogue ↔ LiteAPI matching pipeline |
| `backfill_liteapi_hotel_photos` / `backfill_resort_photos` | Photo + geocode backfill |
| `top_up_hotels_worker` / `recache_room_mapping` | Async pricing + room-mapping workers |

## Local dev

The frontend is a static file. Serve the repo root with any static server (`python3 -m http.server`) and open `index.html`; it calls the live Supabase project with the embedded anon key.

Deploy an edge function:

```bash
supabase functions deploy <name> --project-ref wyqbtcuoorclmirepkuo
```

Regenerate SEO pages after a catalogue change:

```bash
node scripts/generate-seo-pages.mjs   # rewrites resort/, caribbean/, sitemap.xml
```

## Deployment

`main` auto-deploys to Vercel → kindredtrips.com. CI (`.github/workflows/ci.yml`) syntax-checks the inline JS, `resort-booking.js`, the generator, and validates that every generated page's JSON-LD parses.

## Operational notes

- **Self-tag internal traffic:** visit `/?internal=1` once on any browser to mark it; searches from it set `is_internal=true` so test traffic stays out of the funnel metrics. `/?internal=0` clears it.
- **Cold starts:** the landing page pre-warms the edge-function chain on load (OPTIONS preflights) so the first search doesn't eat cold-start latency.
- **Error visibility:** edge functions log caught exceptions to `edge_function_errors`; query `v_edge_errors_24h` for a daily failure digest.
- **Funnel:** `v_daily_funnel` joins searches → clicks by `session_id`.

## Security

- RLS is enabled on all public tables with no anon policies — the anon key (published in `index.html`) cannot read or write the database. Only service-role edge functions touch data.
- `SECURITY DEFINER` views run as `security_invoker`; sensitive RPCs (`net_http_post_json`, worker functions) are revoked from `anon`/`authenticated`.
- The frontend escapes all dynamic values into HTML (`escapeHtml`) and into inline handlers (`jsArg`).

## Smoke test

```bash
SUPABASE_URL="https://wyqbtcuoorclmirepkuo.supabase.co"
ANON_KEY="<see index.html>"

curl -X POST "$SUPABASE_URL/functions/v1/Search" \
  -H "Authorization: Bearer $ANON_KEY" -H "Content-Type: application/json" \
  -d '{"origin_iata":"BNA","date_start":"2026-08-08","date_end":"2026-08-15","adults":2,"child_ages":[5,8]}'
```
