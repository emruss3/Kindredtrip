# KindredTrips

Caribbean family-vacation discovery and ranking. Searches every Caribbean airport and every family-friendly resort, then ranks complete trips (flights + hotel) by total cost.

## Stack

- **Frontend**: single-file `index.html` (vanilla, no build step). Hosted on Vercel.
- **Backend**: Supabase Postgres + Edge Functions (Deno).
- **Domain**: kindredtrips.com

## Repo layout

```
index.html                    # the entire frontend
supabase/functions/
  Search/                     # creates search + auto-fires batch
  process_search_batch/       # generates packages from resorts
  get_packages/               # API the frontend reads from
  price_packages_mock/        # deterministic mock pricer (active)
  generate_booking_redirect/  # affiliate URL generator + click logger
docs/                         # static page copy (about, privacy, contact)
```

## Local dev

The frontend is a static file — open `index.html` in a browser, or serve it with any static host. It calls the live Supabase project directly using the embedded anon key.

To deploy edge function changes to Supabase:

```bash
supabase functions deploy <name> --project-ref wyqbtcuoorclmirepkuo
```

## Deployment

`main` auto-deploys to Vercel → kindredtrips.com.

## Smoke test

```bash
SUPABASE_URL="https://wyqbtcuoorclmirepkuo.supabase.co"
ANON_KEY="<see index.html>"

curl -X POST "$SUPABASE_URL/functions/v1/Search" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"origin_iata":"BNA","date_start":"2026-08-08","date_end":"2026-08-15","adults":2,"child_ages":[5,8]}'
```
