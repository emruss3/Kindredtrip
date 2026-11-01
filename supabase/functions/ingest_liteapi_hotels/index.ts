// ingest_liteapi_hotels — v2 (catalog rules + full field capture)
//
// Pulls LiteAPI's hotel list for the addressable countries and inserts
// properties that pass the family-beach catalog rules and aren't already
// in `resorts`. v1 only looked at hotelTypeId=206 ("Resort") and wrote
// name/coords/airport; brand-name family hotels (Ritz Cayman, Hyatt
// Regency Aruba, Westin St. John…) are typed "Hotel" and were invisible.
//
// Catalog rules (all configurable per call, defaults below):
//   - stars >= min_stars               (default 4)
//   - reviewCount >= min_reviews       (default 50; kills one-off villas/condos)
//   - has a beach or pool facility     (default true; kills airport/business hotels)
//   - not already present by liteapi_hotel_id
//   - has coordinates (needed for airport mapping)
// Adults-only properties are NOT rejected — they're tagged audience=
// 'Adults Only' (from the name or the "Adult only" facility) so
// process_search_batch excludes them from family searches exactly like
// the curated rows.
//
// Facility ids → names come from public.liteapi_facilities (seeded from
// cap_raw_detail), not from constants in this file. Airports come from
// public.airports (nearest airport in the same country).
//
// Captured per row: liteapi_hotel_id/name/match_*, resort_name, country,
// area (city), lat/lng, hotel_brand (chain), cap_star_rating,
// cap_hotel_type, avg_user_rating (0-100), review_count, liteapi_description,
// liteapi_hotel_photos (main photo), audience, airport_*, on_beach,
// kids_club_available, water_park, cap_has_pool, data_quality.
// Rooms/occupancy/cribs come later from enrich_liteapi_caps.
//
// POST /functions/v1/ingest_liteapi_hotels  body: {
//   countries?: string[],         // ISO-3166 alpha-2; defaults to full set
//   dry_run?: boolean,            // DEFAULT TRUE — returns candidates, inserts nothing
//   max_per_run?: number,         // insert cap per invocation (default 300)
//   min_stars?: number,           // default 4
//   min_reviews?: number,         // default 50
//   require_beach_or_pool?: boolean, // default true
//   hotel_type_ids?: number[],    // default [] = all types
//   return_rejects?: boolean,     // include per-hotel reject reasons (default false)
// }
//
// Chains itself (non-dry-run only) if countries remain after the wall-clock budget.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "ingest_liteapi_hotels_v2_catalog_rules";
const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";
const PER_REQUEST_DELAY_MS = 300;
const WALL_CLOCK_BUDGET_MS = 40_000;

// ISO 3166-1 alpha-2 → display name used in resorts.country. Cuba (CU,
// OFAC) and Brazil (BR, not Caribbean) are intentionally absent; Ecuador/
// Peru/US were dropped from v1's list for the same reason (see the
// 20260615 exclusion migrations). Names must match existing resorts.country
// spellings so filters don't fork ("Curaçao", "Grand Cayman").
const COUNTRY_CODES: Array<{ code: string; name: string }> = [
  { code: "MX", name: "Mexico" },
  { code: "DO", name: "Dominican Republic" },
  { code: "JM", name: "Jamaica" },
  { code: "PR", name: "Puerto Rico" },
  { code: "BS", name: "Bahamas" },
  { code: "TC", name: "Turks and Caicos" },
  { code: "KY", name: "Grand Cayman" },
  { code: "AW", name: "Aruba" },
  { code: "CW", name: "Curaçao" },
  { code: "BQ", name: "Bonaire" },
  { code: "BB", name: "Barbados" },
  { code: "LC", name: "Saint Lucia" },
  { code: "AG", name: "Antigua and Barbuda" },
  { code: "KN", name: "Saint Kitts and Nevis" },
  { code: "AI", name: "Anguilla" },
  { code: "SX", name: "Sint Maarten" },
  { code: "MF", name: "Saint Martin" },
  { code: "VI", name: "US Virgin Islands" },
  { code: "VG", name: "British Virgin Islands" },
  { code: "GD", name: "Grenada" },
  { code: "VC", name: "Saint Vincent and the Grenadines" },
  { code: "DM", name: "Dominica" },
  { code: "MQ", name: "Martinique" },
  { code: "GP", name: "Guadeloupe" },
  { code: "TT", name: "Trinidad and Tobago" },
  { code: "BM", name: "Bermuda" },
  { code: "BZ", name: "Belize" },
  { code: "CR", name: "Costa Rica" },
  { code: "PA", name: "Panama" },
  { code: "HN", name: "Honduras" },
  { code: "GT", name: "Guatemala" },
  { code: "NI", name: "Nicaragua" },
  { code: "SV", name: "El Salvador" },
  { code: "CO", name: "Colombia" },
  { code: "HT", name: "Haiti" },
];

// US Virgin Islands rows in the curated catalog are split by island.
function usviCountryName(city: string | null, name: string): string {
  const s = `${city ?? ""} ${name}`.toLowerCase();
  if (/croix|christiansted|frederiksted/.test(s)) return "Saint Croix";
  if (/st\.?\s*john|cruz bay|coral bay/.test(s)) return "Saint John";
  return "Saint Thomas";
}

const ADULTS_ONLY_RE = /adults?[\s-]*only|couples?[\s-]*only|au[\s-]*naturel|\b18\+|over\s*18|adults?[\s-]*exclusive/i;

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

function findApiKey(): { name: string; key: string } | null {
  const names = ["LiteAPI", "LITEAPI", "liteapi", "Liteapi", "LITEAPI_SANDBOX_KEY", "LITEAPI_API_KEY",
    "LITEAPI_KEY", "LITEAPI_SANDBOX", "LITEAPI_SAND", "LITE_API_KEY", "SAND_API_KEY", "LITE_API", "LITEAPI_SECRET"];
  for (const n of names) {
    const v = Deno.env.get(n);
    if (v && v.length >= 10) return { name: n, key: v };
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchHotels(apiKey: string, code: string, offset: number, limit: number, hotelTypeIds: number[]) {
  const params = new URLSearchParams({ countryCode: code, limit: String(limit), offset: String(offset) });
  for (const id of hotelTypeIds) params.append("hotelTypeIds", String(id));
  const r = await fetch(`${LITEAPI_BASE}/data/hotels?${params.toString()}`, {
    headers: { "X-API-Key": apiKey, Accept: "application/json" },
  });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, status: r.status, error: t.slice(0, 200), hotels: [] as any[] };
  }
  const body = await r.json();
  return { ok: true, status: 200, hotels: Array.isArray(body?.data) ? body.data : [] as any[] };
}

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371, toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

type Airport = { iata: string; name: string | null; country: string | null; lat: number; lng: number };

async function loadAirports(sb: any): Promise<Airport[]> {
  const { data, error } = await sb.from("airports").select("iata_code, airport_name, country, lat, lng");
  if (error) throw new Error(`airports: ${error.message}`);
  return (data ?? [])
    .filter((a: any) => a.iata_code && Number.isFinite(Number(a.lat)) && Number.isFinite(Number(a.lng)))
    .map((a: any) => ({ iata: a.iata_code, name: a.airport_name, country: a.country, lat: Number(a.lat), lng: Number(a.lng) }));
}

function nearestAirport(lat: number, lng: number, country: string, airports: Airport[]): { ap: Airport; km: number } | null {
  const same = airports.filter((a) => a.country === country);
  const pool = same.length ? same : airports;
  let best: { ap: Airport; km: number } | null = null;
  for (const ap of pool) {
    const km = distanceKm(lat, lng, ap.lat, ap.lng);
    if (!best || km < best.km) best = { ap, km };
  }
  return best;
}

type FacilityMap = Map<number, string>;
async function loadFacilities(sb: any): Promise<FacilityMap> {
  const { data, error } = await sb.from("liteapi_facilities").select("facility_id, name");
  if (error) throw new Error(`liteapi_facilities: ${error.message}`);
  const m: FacilityMap = new Map();
  for (const r of data ?? []) m.set(Number(r.facility_id), String(r.name));
  return m;
}

const BEACH_RE = /\bbeach\b|beachfront/i;
const POOL_RE = /swimming pool|outdoor pool|indoor pool|infinity pool|heated pool|salt-water pool|children'?s pool|kids'? pool|\bpool\b(?!\s*table)/i;
const KIDS_CLUB_RE = /children'?s club|kids'? club|supervised childcare/i;
const WATER_PARK_RE = /water ?park|waterslide|water slide/i;
const ADULT_FAC_RE = /^adult only$|adults?[\s-]*only/i;

function facilityNames(ids: unknown, map: FacilityMap): string[] {
  if (!Array.isArray(ids)) return [];
  const out: string[] = [];
  for (const id of ids) {
    const n = map.get(Number(id));
    if (n) out.push(n);
  }
  return out;
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ version: VERSION, error: "POST only" }), { status: 405, headers });

  const startedAt = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const filterCodes: string[] | null = Array.isArray(body.countries) && body.countries.length ? body.countries : null;
    const dryRun: boolean = body.dry_run !== false; // default TRUE
    const maxPerRun: number = Number.isFinite(Number(body.max_per_run)) ? Number(body.max_per_run) : 300;
    const minStars: number = Number.isFinite(Number(body.min_stars)) ? Number(body.min_stars) : 4;
    const minReviews: number = Number.isFinite(Number(body.min_reviews)) ? Number(body.min_reviews) : 50;
    const requireBeachOrPool: boolean = body.require_beach_or_pool !== false;
    const hotelTypeIds: number[] = Array.isArray(body.hotel_type_ids) ? body.hotel_type_ids.map(Number).filter(Number.isFinite) : [];
    const returnRejects: boolean = body.return_rejects === true;

    const countries = filterCodes ? COUNTRY_CODES.filter((c) => filterCodes.includes(c.code)) : COUNTRY_CODES;

    const found = findApiKey();
    if (!found) throw new Error("LiteAPI key missing");
    const apiKey = found.key;

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    const { data: existing, error: exErr } = await sb.from("resorts").select("liteapi_hotel_id").not("liteapi_hotel_id", "is", null);
    if (exErr) throw exErr;
    const haveSet = new Set((existing ?? []).map((r: any) => String(r.liteapi_hotel_id)));

    const [airports, facilities] = await Promise.all([loadAirports(sb), loadFacilities(sb)]);
    if (airports.length === 0) throw new Error("public.airports is empty — seed it before ingesting");
    if (facilities.size === 0) throw new Error("public.liteapi_facilities is empty — seed it before ingesting");

    const summary = {
      rules: { min_stars: minStars, min_reviews: minReviews, require_beach_or_pool: requireBeachOrPool, hotel_type_ids: hotelTypeIds },
      processed_countries: [] as string[],
      hotels_scanned: 0,
      already_have: 0,
      rejected: { stars: 0, reviews: 0, no_beach_or_pool: 0, no_coords: 0, no_airport: 0 },
      candidates: 0,
      inserted: 0,
      adults_only_tagged: 0,
      airports_loaded: airports.length,
      facilities_loaded: facilities.size,
      api_key_env: found.name,
      wall_time_budget_hit: false,
      rate_limit_hit: false,
      last_error: undefined as string | undefined,
    };

    const candidates: any[] = [];
    const rejects: any[] = [];
    let inserted = 0;

    for (const c of countries) {
      if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) { summary.wall_time_budget_hit = true; break; }
      if (inserted >= maxPerRun && !dryRun) break;

      const toInsert: any[] = [];
      let offset = 0, pages = 0;
      const limit = 1000;
      let countryFailed = false;

      while (pages < 10) {
        const res = await fetchHotels(apiKey, c.code, offset, limit, hotelTypeIds);
        if (!res.ok) {
          summary.last_error = `${c.code}: ${res.status} ${res.error ?? ""}`;
          if (res.status === 429) summary.rate_limit_hit = true;
          countryFailed = true;
          break;
        }
        for (const h of res.hotels) {
          summary.hotels_scanned++;
          const id = String(h?.id ?? h?.hotelId ?? "");
          if (!id) continue;
          if (haveSet.has(id)) { summary.already_have++; continue; }

          const name = String(h?.name ?? "").trim();
          const city: string | null = h?.city ?? null;
          const stars = Number(h?.stars ?? h?.starRating ?? 0) || 0;
          const reviews = Number(h?.reviewCount ?? 0) || 0;
          const rating10 = Number(h?.rating ?? 0) || 0;
          const lat = Number(h?.latitude ?? h?.lat), lng = Number(h?.longitude ?? h?.lng);
          const facs = facilityNames(h?.facilityIds, facilities);
          const hasBeach = facs.some((f) => BEACH_RE.test(f));
          const hasPool = facs.some((f) => POOL_RE.test(f));
          const hasKidsClub = facs.some((f) => KIDS_CLUB_RE.test(f));
          const hasWaterPark = facs.some((f) => WATER_PARK_RE.test(f));
          const adultsOnly = ADULTS_ONLY_RE.test(name) || facs.some((f) => ADULT_FAC_RE.test(f));

          const reject = (reason: keyof typeof summary.rejected) => {
            summary.rejected[reason]++;
            if (returnRejects) rejects.push({ id, name, country: c.name, city, stars, reviews, reason });
          };

          if (stars < minStars) { reject("stars"); continue; }
          if (reviews < minReviews) { reject("reviews"); continue; }
          if (requireBeachOrPool && !hasBeach && !hasPool) { reject("no_beach_or_pool"); continue; }
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) { reject("no_coords"); continue; }

          const countryName = c.code === "VI" ? usviCountryName(city, name) : c.name;
          const near = nearestAirport(lat, lng, countryName, airports);
          if (!near) { reject("no_airport"); continue; }

          const audience = adultsOnly ? "Adults Only" : "Family";
          if (adultsOnly) summary.adults_only_tagged++;

          const row = {
            liteapi_hotel_id: id,
            liteapi_hotel_name: name,
            liteapi_match_status: "matched",
            liteapi_match_method: "ingest_v2",
            liteapi_match_score: 100,
            liteapi_synced_at: new Date().toISOString(),
            resort_name: name || `Resort ${id}`,
            country: countryName,
            area: city,
            latitude: lat,
            longitude: lng,
            hotel_brand: h?.chain ? String(h.chain) : null,
            cap_star_rating: stars || null,
            cap_hotel_type: h?.hotelTypeId != null ? String(h.hotelTypeId) : null,
            avg_user_rating: rating10 > 0 ? Math.round(rating10 * 10) : null, // resorts.avg_user_rating is 0-100
            review_count: reviews,
            liteapi_description: typeof h?.hotelDescription === "string" ? h.hotelDescription.slice(0, 8000) : null,
            liteapi_hotel_photos: h?.main_photo ? [{ url: String(h.main_photo), is_main: true, source: "liteapi_list" }] : null,
            audience,
            airport_iata: near.ap.iata,
            airport_code: near.ap.iata,
            airport_name: near.ap.name,
            on_beach: hasBeach ? true : null,
            cap_has_pool: hasPool,
            kids_club_available: hasKidsClub ? true : null,
            water_park: hasWaterPark ? true : null,
            data_quality: {
              source: VERSION,
              ingested_at: new Date().toISOString(),
              airport_km: Math.round(near.km),
              facility_count: facs.length,
              beach: hasBeach, pool: hasPool, kids_club: hasKidsClub, water_park: hasWaterPark,
              adults_only_signal: adultsOnly ? (ADULTS_ONLY_RE.test(name) ? "name" : "facility") : null,
            },
          };
          toInsert.push(row);
          haveSet.add(id);
          candidates.push({
            id, name, country: countryName, city, stars, rating: rating10, reviews, audience,
            airport: near.ap.iata, airport_km: Math.round(near.km), beach: hasBeach, pool: hasPool,
            kids_club: hasKidsClub, water_park: hasWaterPark, chain: h?.chain ?? null,
          });
        }
        pages++;
        if (res.hotels.length < limit) break;
        offset += limit;
        await sleep(PER_REQUEST_DELAY_MS);
      }

      if (countryFailed) { if (summary.rate_limit_hit) break; else continue; }
      summary.processed_countries.push(c.code);
      summary.candidates += toInsert.length;

      if (!dryRun && toInsert.length > 0) {
        const remaining = Math.max(0, maxPerRun - inserted);
        const slice = toInsert.slice(0, remaining);
        for (let i = 0; i < slice.length; i += 100) {
          const batch = slice.slice(i, i + 100);
          const { error: insErr } = await sb.from("resorts").insert(batch);
          if (insErr) { summary.last_error = `insert ${c.code}: ${insErr.message}`; break; }
          inserted += batch.length;
        }
      }
      await sleep(PER_REQUEST_DELAY_MS);
    }
    summary.inserted = inserted;

    const remainingCountries = countries.filter((c) => !summary.processed_countries.includes(c.code)).map((c) => c.code);
    let chained = false;
    if (remainingCountries.length > 0 && !summary.rate_limit_hit && !dryRun && inserted < maxPerRun) {
      const p = fetch(`${supabaseUrl}/functions/v1/ingest_liteapi_hotels`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
        body: JSON.stringify({
          countries: remainingCountries, dry_run: false, max_per_run: maxPerRun,
          min_stars: minStars, min_reviews: minReviews, require_beach_or_pool: requireBeachOrPool, hotel_type_ids: hotelTypeIds,
        }),
      });
      const er = (globalThis as any).EdgeRuntime;
      if (er?.waitUntil) er.waitUntil(p.catch((e) => console.error("[ingest chain]", e)));
      else p.catch((e) => console.error("[ingest chain]", e));
      chained = true;
    }

    return new Response(JSON.stringify({
      version: VERSION,
      dry_run: dryRun,
      chained,
      remaining_countries: remainingCountries,
      elapsed_ms: Date.now() - startedAt,
      summary,
      candidates,
      rejects: returnRejects ? rejects : undefined,
    }, null, 2), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }), { status: 500, headers });
  }
});
