// ingest_liteapi_hotels
//
// Pulls LiteAPI's "Resort" inventory (hotelTypeId=206) for the
// addressable countries and inserts any property not already in the
// resorts table. Each new row gets:
//   - resort_name, country, latitude, longitude, liteapi_hotel_id
//   - audience='Family' (default per product policy; refined later)
//   - airport_code from nearest-centroid lookup against existing resorts
//   - data_quality='liteapi_ingest_v1'
// Cap data (amenities, facilities, room catalogue) is left empty here;
// a separate enrichment pass calls /data/hotel?hotelId=X for each new
// resort. Splitting keeps this function within edge-runtime budget.
//
// POST /functions/v1/ingest_liteapi_hotels  body: {
//   countries?: string[],   // ISO-3166 alpha-2; defaults to full set
//   max_per_run?: number,   // safety cap per invocation (default 500)
//   dry_run?: boolean,      // simulate without inserting (default false)
// }
//
// Chains itself if more countries remain.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "ingest_liteapi_hotels_v1";
const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";
const PER_REQUEST_DELAY_MS = 250;   // ≤ 4 req/sec to dodge LiteAPI rate limits
const WALL_CLOCK_BUDGET_MS = 40_000;

// ISO 3166-1 alpha-2 for the addressable resort universe — Cuba (CU)
// and Brazil (BR) are intentionally excluded per product policy.
const COUNTRY_CODES: Array<{ code: string; name: string }> = [
  { code: "MX", name: "Mexico" },
  { code: "DO", name: "Dominican Republic" },
  { code: "JM", name: "Jamaica" },
  { code: "LC", name: "Saint Lucia" },
  { code: "BB", name: "Barbados" },
  { code: "CR", name: "Costa Rica" },
  { code: "AG", name: "Antigua and Barbuda" },
  { code: "AW", name: "Aruba" },
  { code: "CO", name: "Colombia" },
  { code: "TC", name: "Turks and Caicos" },
  { code: "BS", name: "Bahamas" },
  { code: "CW", name: "Curaçao" },
  { code: "BZ", name: "Belize" },
  { code: "GD", name: "Grenada" },
  { code: "HN", name: "Honduras" },
  { code: "PA", name: "Panama" },
  { code: "SX", name: "Sint Maarten" },
  { code: "MF", name: "Saint Martin" },
  { code: "VG", name: "British Virgin Islands" },
  { code: "GT", name: "Guatemala" },
  { code: "EC", name: "Ecuador" },
  { code: "PE", name: "Peru" },
  { code: "VI", name: "US Virgin Islands" },
  { code: "VC", name: "Saint Vincent and the Grenadines" },
  { code: "BM", name: "Bermuda" },
  { code: "KY", name: "Cayman Islands" },
  { code: "SV", name: "El Salvador" },
  { code: "BQ", name: "Bonaire" },
  { code: "HT", name: "Haiti" },
  { code: "MQ", name: "Martinique" },
  { code: "DM", name: "Dominica" },
  { code: "NI", name: "Nicaragua" },
  { code: "KN", name: "Saint Kitts and Nevis" },
  { code: "GP", name: "Guadeloupe" },
  { code: "TT", name: "Trinidad and Tobago" },
];

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

function findApiKey(): string | null {
  for (const n of ["LiteAPI", "LITEAPI", "LITEAPI_SANDBOX_KEY", "LITEAPI_API_KEY"]) {
    const v = Deno.env.get(n);
    if (v && v.length > 10) return v;
  }
  return null;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHotels(apiKey: string, code: string, offset: number, limit: number) {
  const params = new URLSearchParams({
    countryCode: code, limit: String(limit), offset: String(offset),
  });
  params.append("hotelTypeIds", "206");
  const url = `${LITEAPI_BASE}/data/hotels?${params.toString()}`;
  const r = await fetch(url, { headers: { "X-API-Key": apiKey, Accept: "application/json" } });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, status: r.status, error: t.slice(0, 200), hotels: [] };
  }
  const body = await r.json();
  return { ok: true, status: 200, hotels: Array.isArray(body?.data) ? body.data : [] };
}

// Haversine distance in km
function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

type AirportCentroid = { code: string; iata: string | null; name: string | null; lat: number; lng: number; country: string | null };

async function loadAirportCentroids(sb: any): Promise<AirportCentroid[]> {
  // Derive per-airport centroids from the existing resort table — we
  // don't have a dedicated airports table. Falls back gracefully when
  // a country has no airport mapping yet.
  const { data } = await sb.from("resorts")
    .select("airport_code, airport_iata, airport_name, country, latitude, longitude")
    .not("airport_code", "is", null)
    .not("latitude", "is", null)
    .not("longitude", "is", null);
  const byCode = new Map<string, { lat_sum: number; lng_sum: number; n: number; iata: string | null; name: string | null; country: string | null }>();
  for (const r of (data ?? [])) {
    const code = String(r.airport_code).trim();
    const lat = Number(r.latitude), lng = Number(r.longitude);
    if (!code || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const e = byCode.get(code) ?? { lat_sum: 0, lng_sum: 0, n: 0, iata: r.airport_iata, name: r.airport_name, country: r.country };
    e.lat_sum += lat; e.lng_sum += lng; e.n += 1;
    byCode.set(code, e);
  }
  const out: AirportCentroid[] = [];
  for (const [code, e] of byCode.entries()) {
    out.push({ code, iata: e.iata, name: e.name, country: e.country, lat: e.lat_sum / e.n, lng: e.lng_sum / e.n });
  }
  return out;
}

function nearestAirport(lat: number, lng: number, country: string | null, airports: AirportCentroid[]): AirportCentroid | null {
  // Prefer airports in the same country; fall back to anywhere when none
  // match (e.g. small island first-of-country insert).
  const sameCountry = country ? airports.filter(a => a.country === country) : [];
  const pool = sameCountry.length > 0 ? sameCountry : airports;
  if (pool.length === 0) return null;
  let best: AirportCentroid | null = null;
  let bestDist = Infinity;
  for (const a of pool) {
    const d = distanceKm(lat, lng, a.lat, a.lng);
    if (d < bestDist) { bestDist = d; best = a; }
  }
  return best;
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ version: VERSION, error: "POST only" }), { status: 405, headers });

  const startedAt = Date.now();

  try {
    const body = await req.json().catch(() => ({}));
    const filterCodes: string[] | null = Array.isArray(body.countries) ? body.countries : null;
    const maxPerRun = Number(body.max_per_run ?? 500);
    const dryRun = Boolean(body.dry_run);
    const countries = filterCodes
      ? COUNTRY_CODES.filter(c => filterCodes.includes(c.code))
      : COUNTRY_CODES;

    const apiKey = findApiKey();
    if (!apiKey) throw new Error("LiteAPI key missing");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    // Existing liteapi_hotel_ids we already have — used to skip dupes.
    const { data: existing } = await sb.from("resorts")
      .select("liteapi_hotel_id").not("liteapi_hotel_id", "is", null);
    const haveSet = new Set((existing ?? []).map((r: any) => String(r.liteapi_hotel_id)));

    const airports = await loadAirportCentroids(sb);

    const summary = {
      processed_countries: [] as string[],
      hotels_scanned: 0,
      hotels_new: 0,
      hotels_inserted: 0,
      hotels_skipped_dupe: 0,
      hotels_skipped_no_coords: 0,
      airports_used: airports.length,
      wall_time_budget_hit: false,
      rate_limit_hit: false,
      last_error: undefined as string | undefined,
    };

    let runningInsertCount = 0;

    for (const c of countries) {
      if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) {
        summary.wall_time_budget_hit = true;
        break;
      }
      if (runningInsertCount >= maxPerRun) break;

      const toInsert: any[] = [];
      let offset = 0;
      const limit = 1000;
      let pages = 0;

      while (pages < 10 && Date.now() - startedAt < WALL_CLOCK_BUDGET_MS) {
        const res = await fetchHotels(apiKey, c.code, offset, limit);
        if (!res.ok) {
          summary.last_error = `${c.code}: ${res.status} ${res.error ?? ""}`;
          if (res.status === 429) { summary.rate_limit_hit = true; }
          break;
        }
        for (const h of res.hotels) {
          summary.hotels_scanned++;
          const id = String(h?.id ?? h?.hotelId ?? "");
          if (!id) continue;
          if (haveSet.has(id)) { summary.hotels_skipped_dupe++; continue; }
          // We require coordinates to do airport mapping. Without coords
          // the resort would never appear in search since process_search_batch
          // requires airport_code; better to skip than insert a useless row.
          const lat = Number(h?.latitude ?? h?.lat);
          const lng = Number(h?.longitude ?? h?.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) { summary.hotels_skipped_no_coords++; continue; }
          summary.hotels_new++;
          const nearest = nearestAirport(lat, lng, c.name, airports);
          toInsert.push({
            liteapi_hotel_id: id,
            resort_name: String(h?.name ?? "").trim() || `Resort ${id}`,
            country: c.name,
            latitude: lat,
            longitude: lng,
            audience: "Family",
            airport_code: nearest?.code ?? null,
            airport_iata: nearest?.iata ?? null,
            airport_name: nearest?.name ?? null,
            data_quality: { source: "liteapi_ingest_v1", ingested_at: new Date().toISOString() },
          });
          haveSet.add(id); // prevent double-insert within the same run
        }
        pages++;
        if (res.hotels.length < limit) break;
        offset += limit;
        await sleep(PER_REQUEST_DELAY_MS);
      }

      summary.processed_countries.push(c.code);

      if (!dryRun && toInsert.length > 0) {
        // Cap inserts per country at the remaining run budget.
        const remaining = Math.max(0, maxPerRun - runningInsertCount);
        const slice = toInsert.slice(0, remaining);
        if (slice.length > 0) {
          const CHUNK = 100;
          for (let i = 0; i < slice.length; i += CHUNK) {
            const batch = slice.slice(i, i + CHUNK);
            const { error: insErr } = await sb.from("resorts").insert(batch);
            if (insErr) {
              summary.last_error = `insert ${c.code}: ${insErr.message}`;
              break;
            }
            summary.hotels_inserted += batch.length;
            runningInsertCount += batch.length;
          }
        }
      } else if (dryRun) {
        summary.hotels_inserted += toInsert.length; // simulated
      }

      if (summary.rate_limit_hit) break;
      await sleep(PER_REQUEST_DELAY_MS);
    }

    // Chain self if we hit a budget cap and more countries remain.
    const remainingCountries = countries.filter(c => !summary.processed_countries.includes(c.code)).map(c => c.code);
    let chained = false;
    if (remainingCountries.length > 0 && !summary.rate_limit_hit && !dryRun) {
      const p = fetch(`${supabaseUrl}/functions/v1/ingest_liteapi_hotels`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
        body: JSON.stringify({ countries: remainingCountries, max_per_run: maxPerRun }),
      });
      const er = (globalThis as any).EdgeRuntime;
      if (er?.waitUntil) er.waitUntil(p.catch((e) => console.error("[ingest_liteapi_hotels chain]", e)));
      else p.catch((e) => console.error("[ingest_liteapi_hotels chain]", e));
      chained = true;
    }

    return new Response(JSON.stringify({
      version: VERSION,
      dry_run: dryRun,
      chained,
      remaining_countries: remainingCountries,
      elapsed_ms: Date.now() - startedAt,
      summary,
    }, null, 2), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({
      version: VERSION, error: String((e as any)?.message ?? e),
    }), { status: 500, headers });
  }
});
