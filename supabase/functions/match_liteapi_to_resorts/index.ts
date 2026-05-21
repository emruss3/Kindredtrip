// match_liteapi_to_resorts
//
// For every existing resort with liteapi_hotel_id IS NULL in an
// addressable country, look up LiteAPI's full hotel list for that
// country and try to link it to an existing LiteAPI id by name + geo
// proximity. This runs BEFORE ingest_liteapi_hotels so we don't
// duplicate properties whose names drifted between our catalogue and
// LiteAPI's (e.g. "Iberostar Bavaro" vs "Iberostar Selection Bavaro
// Punta Cana").
//
// Match score:
//   - Normalized token Jaccard similarity (drop common suffixes, parens,
//     accents, brand boilerplate, punctuation)
//   - Haversine distance in km
//   - Accept when name_sim >= 0.55 AND distance <= 3 km, OR
//     name_sim >= 0.80 AND distance <= 8 km (relaxed for resorts where
//     our lat/lng is the airport not the hotel)
//
// POST /functions/v1/match_liteapi_to_resorts  body: {
//   countries?: string[],    // ISO-3166 alpha-2; defaults to full set
//   dry_run?: boolean,       // simulate without updating (default true)
// }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "match_liteapi_to_resorts_v2_airport_anchor";
const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";
const PER_REQUEST_DELAY_MS = 250;
const WALL_CLOCK_BUDGET_MS = 45_000;

const COUNTRY_CODES: Array<{ code: string; name: string }> = [
  { code: "MX", name: "Mexico" }, { code: "DO", name: "Dominican Republic" }, { code: "JM", name: "Jamaica" },
  { code: "LC", name: "Saint Lucia" }, { code: "BB", name: "Barbados" }, { code: "CR", name: "Costa Rica" },
  { code: "AG", name: "Antigua and Barbuda" }, { code: "AW", name: "Aruba" }, { code: "CO", name: "Colombia" },
  { code: "TC", name: "Turks and Caicos" }, { code: "BS", name: "Bahamas" }, { code: "CW", name: "Curaçao" },
  { code: "BZ", name: "Belize" }, { code: "GD", name: "Grenada" }, { code: "HN", name: "Honduras" },
  { code: "PA", name: "Panama" }, { code: "SX", name: "Sint Maarten" }, { code: "MF", name: "Saint Martin" },
  { code: "VG", name: "British Virgin Islands" }, { code: "GT", name: "Guatemala" }, { code: "EC", name: "Ecuador" },
  { code: "PE", name: "Peru" }, { code: "VI", name: "US Virgin Islands" }, { code: "VC", name: "Saint Vincent and the Grenadines" },
  { code: "BM", name: "Bermuda" }, { code: "KY", name: "Cayman Islands" }, { code: "SV", name: "El Salvador" },
  { code: "BQ", name: "Bonaire" }, { code: "HT", name: "Haiti" }, { code: "MQ", name: "Martinique" },
  { code: "DM", name: "Dominica" }, { code: "NI", name: "Nicaragua" }, { code: "KN", name: "Saint Kitts and Nevis" },
  { code: "GP", name: "Guadeloupe" }, { code: "TT", name: "Trinidad and Tobago" },
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

// Drop brand-collection suffixes, accents, punctuation, common
// "Resort"/"Hotel"/"by X" boilerplate. Lowercase tokens for Jaccard.
const STOPWORDS = new Set([
  "the","and","a","resort","resorts","hotel","hotels","spa","by","an","all","inclusive","allinclusive",
  "collection","autograph","tribute","trademark","curio","unbound","luxury","luxe","beach","bay",
  "the","resort","spa","suites","suite","villas","villa","residences","residence","at","de","la","el",
  "los","las","golf","club","grand","royal","royale","royalton","grande","premium","platinum","family",
  "preferred","reserve","reserved","palace","palms","palm","pool","ocean","sea","resorts","y","del","con","oasis"
]);
function strip(s: string): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")  // strip diacritics
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")        // remove parens
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")      // non-alnum → space
    .replace(/\s+/g, " ")
    .trim();
}
function tokenize(name: string): string[] {
  return strip(name).split(" ").filter(t => t && !STOPWORDS.has(t));
}
function jaccard(aTokens: string[], bTokens: string[]): number {
  if (!aTokens.length || !bTokens.length) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}
function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

async function fetchHotels(apiKey: string, code: string, offset: number, limit: number) {
  // No type / star filter on the match pass — we want LiteAPI's full
  // inventory in the country so we can find name twins regardless of
  // how they're classified.
  const params = new URLSearchParams({ countryCode: code, limit: String(limit), offset: String(offset) });
  const url = `${LITEAPI_BASE}/data/hotels?${params.toString()}`;
  const r = await fetch(url, { headers: { "X-API-Key": apiKey, Accept: "application/json" } });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, status: r.status, error: t.slice(0, 200), hotels: [] };
  }
  const body = await r.json();
  return { ok: true, status: 200, hotels: Array.isArray(body?.data) ? body.data : [] };
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ version: VERSION, error: "POST only" }), { status: 405, headers });

  const startedAt = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const filterCodes: string[] | null = Array.isArray(body.countries) ? body.countries : null;
    const dryRun = body.dry_run !== false;  // default TRUE — explicit opt-in to write
    const countries = filterCodes
      ? COUNTRY_CODES.filter(c => filterCodes.includes(c.code))
      : COUNTRY_CODES;

    const apiKey = findApiKey();
    if (!apiKey) throw new Error("LiteAPI key missing");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    // Existing liteapi ids in use, so we never re-link a hotel id that
    // already maps to a different resort.
    const { data: usedIds } = await sb.from("resorts").select("liteapi_hotel_id").not("liteapi_hotel_id", "is", null);
    const usedIdSet = new Set((usedIds ?? []).map((r: any) => String(r.liteapi_hotel_id)));

    const summary: any = {
      processed_countries: [], unmatched_input: 0, candidates_scanned: 0,
      linked: 0, ambiguous: 0, no_candidate: 0,
      wall_time_budget_hit: false, rate_limit_hit: false,
      last_error: undefined,
      matches: [] as any[],
    };

    for (const c of countries) {
      if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) { summary.wall_time_budget_hit = true; break; }

      // Our unmatched rows for this country — keep coord-less rows
      // (most of them, in fact). v1 dropped them silently via a geo
      // gate, which is why DR+JM linked only 5/119.
      const { data: ours } = await sb.from("resorts")
        .select("resort_id, resort_name, country, latitude, longitude, airport_code")
        .eq("country", c.name)
        .is("liteapi_hotel_id", null);
      const unmatched = (ours ?? []);
      summary.unmatched_input += unmatched.length;

      // Airport centroid lookup for the country, derived from our own
      // already-coord'd resorts. Lets us anchor coord-less rows in a
      // ~25 km radius of their airport when comparing to LiteAPI's
      // (always-coord'd) candidates.
      const airportCentroids = new Map<string, { lat: number; lng: number }>();
      const { data: airportRows } = await sb.from("resorts")
        .select("airport_code, latitude, longitude")
        .eq("country", c.name)
        .not("airport_code", "is", null)
        .not("latitude", "is", null)
        .not("longitude", "is", null);
      const tally = new Map<string, { latSum: number; lngSum: number; n: number }>();
      for (const r of (airportRows ?? [])) {
        const code = String(r.airport_code).trim();
        const lat = Number(r.latitude), lng = Number(r.longitude);
        if (!code || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const e = tally.get(code) ?? { latSum: 0, lngSum: 0, n: 0 };
        e.latSum += lat; e.lngSum += lng; e.n += 1;
        tally.set(code, e);
      }
      for (const [code, e] of tally.entries()) {
        airportCentroids.set(code, { lat: e.latSum / e.n, lng: e.lngSum / e.n });
      }

      if (unmatched.length === 0) { summary.processed_countries.push(c.code); continue; }

      // LiteAPI full inventory for this country
      const liteHotels: any[] = [];
      let offset = 0, pages = 0;
      const limit = 1000;
      while (pages < 5 && Date.now() - startedAt < WALL_CLOCK_BUDGET_MS) {
        const res = await fetchHotels(apiKey, c.code, offset, limit);
        if (!res.ok) {
          summary.last_error = `${c.code}: ${res.status} ${res.error ?? ""}`;
          if (res.status === 429) summary.rate_limit_hit = true;
          break;
        }
        for (const h of res.hotels) liteHotels.push(h);
        pages++;
        if (res.hotels.length < limit) break;
        offset += limit;
        await sleep(PER_REQUEST_DELAY_MS);
      }
      if (summary.rate_limit_hit) break;
      summary.candidates_scanned += liteHotels.length;

      // Pre-tokenize LiteAPI candidates
      const liteTok = liteHotels.map((h: any) => ({
        h,
        id: String(h?.id ?? h?.hotelId ?? ""),
        tokens: tokenize(h?.name ?? ""),
        lat: Number(h?.latitude ?? h?.lat),
        lng: Number(h?.longitude ?? h?.lng),
      })).filter((x) => x.id && Number.isFinite(x.lat) && Number.isFinite(x.lng) && !usedIdSet.has(x.id));

      for (const ours_row of unmatched) {
        const ourTokens = tokenize(ours_row.resort_name);
        const ourLat = Number(ours_row.latitude);
        const ourLng = Number(ours_row.longitude);
        const hasOurCoords = Number.isFinite(ourLat) && Number.isFinite(ourLng);
        // Coord-less rows: anchor to airport centroid so we can still
        // require the candidate be in the right region (not just the
        // right country — DR alone has Punta Cana + Puerto Plata +
        // Samaná zones >100 km apart).
        const apt = ours_row.airport_code ? airportCentroids.get(String(ours_row.airport_code).trim()) : null;
        const anchorLat = hasOurCoords ? ourLat : (apt?.lat ?? null);
        const anchorLng = hasOurCoords ? ourLng : (apt?.lng ?? null);
        // Geo radius is 8 km for own-coords (precise), 25 km for
        // airport-anchor (regional only).
        const geoRadiusKm = hasOurCoords ? 8 : 25;

        let best: any = null;
        let bestScore = 0;
        for (const cand of liteTok) {
          let dKm = Infinity;
          if (anchorLat != null && anchorLng != null) {
            dKm = distanceKm(anchorLat as number, anchorLng as number, cand.lat, cand.lng);
            if (dKm > geoRadiusKm) continue;
          }
          // else: no anchor available, accept any geo and rely entirely on name
          const sim = jaccard(ourTokens, cand.tokens);
          // Tiered acceptance:
          //   - own-coord precise: sim >= 0.55 within 3 km OR sim >= 0.80 within 8 km
          //   - airport-anchored:  sim >= 0.80 within 25 km
          //   - no anchor at all:  sim >= 0.90 (very strict, name-only fallback)
          let acceptable = false;
          if (hasOurCoords) {
            acceptable = (sim >= 0.55 && dKm <= 3) || (sim >= 0.80 && dKm <= 8);
          } else if (anchorLat != null) {
            acceptable = sim >= 0.80 && dKm <= 25;
          } else {
            acceptable = sim >= 0.90;
          }
          if (!acceptable) continue;
          const score = sim * 100 - (Number.isFinite(dKm) ? dKm * 0.5 : 0);
          if (score > bestScore) { bestScore = score; best = { cand, sim, dKm }; }
        }

        if (best) {
          summary.matches.push({
            country: c.name,
            ours: ours_row.resort_name,
            liteapi: best.cand.h?.name,
            liteapi_id: best.cand.id,
            name_sim: Number(best.sim.toFixed(3)),
            distance_km: Number(best.dKm.toFixed(2)),
          });
          if (!dryRun) {
            await sb.from("resorts").update({
              liteapi_hotel_id: best.cand.id,
              data_quality: { source: "liteapi_match_v1", matched_at: new Date().toISOString(),
                              name_sim: Number(best.sim.toFixed(3)), distance_km: Number(best.dKm.toFixed(2)) },
            }).eq("resort_id", ours_row.resort_id);
            usedIdSet.add(best.cand.id);  // prevent the same id from matching another row
          }
          summary.linked++;
        } else {
          summary.no_candidate++;
        }
      }

      summary.processed_countries.push(c.code);
      await sleep(PER_REQUEST_DELAY_MS);
    }

    // Trim matches output for response size
    if (summary.matches.length > 100) {
      summary.matches_truncated_to = 100;
      summary.matches = summary.matches.slice(0, 100);
    }

    return new Response(JSON.stringify({
      version: VERSION, dry_run: dryRun, elapsed_ms: Date.now() - startedAt, summary,
    }, null, 2), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({
      version: VERSION, error: String((e as any)?.message ?? e),
    }), { status: 500, headers });
  }
});
