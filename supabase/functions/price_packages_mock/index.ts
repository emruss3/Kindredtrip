import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "price_packages_mock_v2_rating100";

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

function seededRand(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function nightsBetween(a: string, b: string): number {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.max(1, Math.round(ms / 86400000));
}

// Ratings are on a 0-100 scale. Distribution: avg ~86, range 57-99.
function starTierBase(rating: number | null): number {
  if (rating == null) return 320;
  if (rating >= 95) return 720;
  if (rating >= 92) return 540;
  if (rating >= 88) return 425;
  if (rating >= 84) return 340;
  if (rating >= 80) return 270;
  if (rating >= 75) return 220;
  return 180;
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ version: VERSION, error: "Use POST" }), { status: 405, headers });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const search_id = String(body.search_id ?? "");
    if (!search_id) return new Response(JSON.stringify({ version: VERSION, error: "search_id required" }), { status: 400, headers });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    const { data: search, error: sErr } = await sb.from("searches").select("*").eq("search_id", search_id).maybeSingle();
    if (sErr) throw sErr;
    if (!search) return new Response(JSON.stringify({ version: VERSION, error: "Search not found" }), { status: 404, headers });

    const adults = Number(search.adults ?? 2);
    const childAges: number[] = search.child_ages ?? [];
    const children = childAges.length;
    const familySize = adults + children;
    const childPriceFactor = 0.75;
    const fullFareEquivalents = adults + (children * childPriceFactor);
    const nights = nightsBetween(search.date_start, search.date_end);

    const { data: airportTiers } = await sb
      .from("mock_flight_pricing")
      .select("airport_code, base_price_min, base_price_max, typical_stops, typical_duration_hours");
    const airportTier = new Map<string, any>();
    for (const r of airportTiers ?? []) airportTier.set(r.airport_code, r);

    const { data: countryMods } = await sb
      .from("mock_hotel_pricing_country")
      .select("country, price_multiplier");
    const countryMult = new Map<string, number>();
    for (const r of countryMods ?? []) countryMult.set(r.country, Number(r.price_multiplier));

    const { data: pkgs, error: pErr } = await sb
      .from("packages")
      .select(`package_id, search_id, resort_id, dest_airport_iata,
               resorts ( resort_name, country, avg_user_rating, direct_flight )`)
      .eq("search_id", search_id);
    if (pErr) throw pErr;
    if (!pkgs?.length) return new Response(JSON.stringify({ version: VERSION, message: "No packages to price" }), { status: 200, headers });

    const flightPriceByAirport = new Map<string, { perPerson: number; stops: number; durationHours: number | null }>();
    const airportSeed = (code: string) => `flt:${search.origin_iata}:${code}:${search.date_start}`;

    for (const pkg of pkgs) {
      const code = pkg.dest_airport_iata;
      if (!code || flightPriceByAirport.has(code)) continue;
      const tier = airportTier.get(code);
      if (!tier) {
        const seedRand = seededRand(airportSeed(code));
        const perPerson = Math.round(640 + seedRand * 220);
        flightPriceByAirport.set(code, { perPerson, stops: 1, durationHours: 7.0 });
        continue;
      }
      const seedRand = seededRand(airportSeed(code));
      const perPerson = Math.round(
        Number(tier.base_price_min) + seedRand * (Number(tier.base_price_max) - Number(tier.base_price_min))
      );
      flightPriceByAirport.set(code, {
        perPerson, stops: tier.typical_stops ?? 1, durationHours: tier.typical_duration_hours ?? null,
      });
    }

    const updates: any[] = [];
    const nowIso = new Date().toISOString();

    for (const pkg of pkgs) {
      const r = (pkg as any).resorts;
      const code = pkg.dest_airport_iata;
      const fInfo = code ? flightPriceByAirport.get(code) : null;
      if (!fInfo) continue;

      const flightTotal = Math.round(fInfo.perPerson * fullFareEquivalents);

      const baseNight = starTierBase(r?.avg_user_rating);
      const countryMul = countryMult.get(r?.country ?? "") ?? 1.0;

      let occupancyMul = 1.0;
      if (familySize >= 7) occupancyMul = 1.55;
      else if (familySize >= 5) occupancyMul = 1.30;
      else if (familySize >= 3) occupancyMul = 1.05;

      const variationSeed = seededRand(`htl:${pkg.resort_id}:${search.date_start}`);
      const variation = 0.85 + variationSeed * 0.30;

      const hotelTotal = Math.round(baseNight * countryMul * nights * occupancyMul * variation);
      const totalPrice = flightTotal + hotelTotal;

      updates.push({
        package_id: pkg.package_id,
        flight_price: flightTotal,
        hotel_price: hotelTotal,
        total_price: totalPrice,
        stops: fInfo.stops,
        duration_hours: fInfo.durationHours,
        flight_supplier: "mock",
        hotel_supplier: "mock",
        flight_priced_at: nowIso,
        hotel_priced_at: nowIso,
        priced_at: nowIso,
      });
    }

    const CHUNK = 50;
    let updated = 0;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const slice = updates.slice(i, i + CHUNK);
      await Promise.all(slice.map(u => {
        const { package_id, ...vals } = u;
        return sb.from("packages").update(vals).eq("package_id", package_id);
      }));
      updated += slice.length;
    }

    await sb.from("search_jobs").update({
      flights_done: true, updated_at: nowIso,
    }).eq("search_id", search_id);

    const prices = updates.map(u => u.total_price);
    return new Response(JSON.stringify({
      version: VERSION,
      search_id,
      packages_priced: updated,
      family_size: familySize,
      nights,
      price_summary: {
        min: prices.length ? Math.min(...prices) : null,
        max: prices.length ? Math.max(...prices) : null,
        avg: prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null,
      },
    }), { status: 200, headers });

  } catch (e) {
    console.error("price_packages_mock error:", e);
    return new Response(JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }), { status: 500, headers });
  }
});
