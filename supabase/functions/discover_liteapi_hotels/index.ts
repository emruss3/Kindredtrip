// discover_liteapi_hotels
//
// One-shot discovery: for each addressable Caribbean / Central / South
// American country, fetch LiteAPI's hotel list and report (a) total
// count and (b) how many would be net-new vs. our existing resorts
// table. Lets us see the ingest volume before committing inserts.
//
// POST /functions/v1/discover_liteapi_hotels  body: { countries?: string[] }
//   countries: optional ISO-3166 alpha-2 list; defaults to the full
//              addressable set (Cuba + Brazil excluded).
//
// Returns: { per_country: [{country, code, liteapi_total, already_have,
//                            net_new}], totals }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "discover_liteapi_hotels_v3_star_filter";

// Read a hotel's star rating from whatever field LiteAPI uses in the
// /data/hotels list response (it has varied across versions).
function hotelStars(h: any): number {
  const v = h?.stars ?? h?.starRating ?? h?.star_rating ?? h?.rating?.stars ?? null;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";

// ISO 3166-1 alpha-2 codes for our addressable resort countries. Cuba
// (CU) and Brazil (BR) are intentionally excluded per product policy.
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

async function fetchHotels(apiKey: string, code: string, offset: number, limit: number, hotelTypeIds: number[] | null) {
  const params = new URLSearchParams({
    countryCode: code,
    limit: String(limit),
    offset: String(offset),
  });
  if (hotelTypeIds && hotelTypeIds.length) {
    // LiteAPI accepts repeated `hotelTypeIds` params for multi-select
    for (const id of hotelTypeIds) params.append("hotelTypeIds", String(id));
  }
  const url = `${LITEAPI_BASE}/data/hotels?${params.toString()}`;
  const r = await fetch(url, {
    headers: { "X-API-Key": apiKey, Accept: "application/json" },
  });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, status: r.status, error: t.slice(0, 200), hotels: [] };
  }
  const body = await r.json();
  const hotels = Array.isArray(body?.data) ? body.data : [];
  return { ok: true, status: 200, hotels };
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ version: VERSION, error: "POST only" }), { status: 405, headers });

  try {
    const body = await req.json().catch(() => ({}));
    const filterCodes: string[] | null = Array.isArray(body.countries) ? body.countries : null;
    // hotel_type_ids default to [206] (Resorts) — matches what our
    // curated existing catalogue is tagged as. Override to [] to scan
    // all hotel types.
    const hotelTypeIds: number[] = Array.isArray(body.hotel_type_ids)
      ? body.hotel_type_ids.map(Number).filter(Number.isFinite)
      : [206];
    // Minimum star rating for candidate hotels. Product policy: only add
    // 4-star-or-higher resorts. (Family-fit + sleeps-5 are applied later,
    // in the detail-enrichment pass — they need room-level data the list
    // endpoint doesn't carry.)
    const minStars: number = Number.isFinite(Number(body.min_stars)) ? Number(body.min_stars) : 4;
    const countries = filterCodes
      ? COUNTRY_CODES.filter((c) => filterCodes.includes(c.code))
      : COUNTRY_CODES;

    const apiKey = findApiKey();
    if (!apiKey) throw new Error("LiteAPI key missing");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    // Existing liteapi ids we already have
    const { data: existing } = await sb.from("resorts")
      .select("liteapi_hotel_id")
      .not("liteapi_hotel_id", "is", null);
    const haveSet = new Set((existing ?? []).map((r: any) => String(r.liteapi_hotel_id)));

    const perCountry: any[] = [];
    let totalLiteapi = 0;
    let totalNetNew = 0;
    let lastError: string | undefined;

    let rawSample: string[] | null = null;
    for (const c of countries) {
      let offset = 0;
      const limit = 1000;
      const seenIds: Set<string> = new Set();
      // net-new candidates meeting the star floor: id -> {name, stars, city}
      const candidates = new Map<string, { name: string; stars: number; city: string | null }>();
      let pages = 0;
      while (pages < 10) {
        const res = await fetchHotels(apiKey, c.code, offset, limit, hotelTypeIds.length ? hotelTypeIds : null);
        if (!res.ok) {
          lastError = `${c.code}: ${res.status} ${res.error ?? ""}`;
          break;
        }
        for (const h of res.hotels) {
          const id = String(h?.id ?? h?.hotelId ?? "");
          if (!id) continue;
          seenIds.add(id);
          // capture the field shape of the first hotel we ever see, so we
          // can confirm which attributes the list endpoint exposes
          if (!rawSample) rawSample = Object.keys(h);
          const stars = hotelStars(h);
          if (stars >= minStars && !haveSet.has(id)) {
            candidates.set(id, {
              name: String(h?.name ?? ""),
              stars,
              city: h?.city ?? h?.cityName ?? null,
            });
          }
        }
        pages++;
        if (res.hotels.length < limit) break;
        offset += limit;
      }
      const liteapi_total = seenIds.size;
      const already_have = Array.from(seenIds).filter((id) => haveSet.has(id)).length;
      const net_new = liteapi_total - already_have;
      const net_new_starred = candidates.size;
      const sample = Array.from(candidates.values())
        .sort((a, b) => b.stars - a.stars)
        .slice(0, 8)
        .map((x) => `${x.name}${x.city ? " — " + x.city : ""} (${x.stars}★)`);
      perCountry.push({
        country: c.name, code: c.code,
        liteapi_total, already_have, net_new,
        net_new_4star_plus: net_new_starred,
        sample,
        pages,
      });
      totalLiteapi += liteapi_total;
      totalNetNew += net_new_starred;
    }

    perCountry.sort((a, b) => b.net_new - a.net_new);

    return new Response(JSON.stringify({
      version: VERSION,
      countries_scanned: countries.length,
      hotel_type_ids_filter: hotelTypeIds,
      min_stars: minStars,
      list_field_sample: rawSample,
      totals: {
        net_new_4star_plus: totalNetNew,
      },
      per_country: perCountry,
      last_error: lastError,
    }, null, 2), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({
      version: VERSION,
      error: String((e as any)?.message ?? e),
    }), { status: 500, headers });
  }
});
