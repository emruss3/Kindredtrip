// get_flight_offers
//
// Returns up to N flight offers for a single package_id, filtered down
// to three useful picks for the detail-modal "Flight options" section:
//   - Best overall: the cheapest offer that's also reasonably easy (used
//     as the "Best overall" card; same offer that drives total_price).
//   - Cheapest: absolute cheapest, regardless of stops/duration.
//   - Easiest with kids: shortest total duration, prefer nonstop.
//
// We resolve the route via packages.flight_route_id, then read
// flight_offers ordered by total_price ASC. To keep the response tiny
// (the table has ~150 offers per route), we read TOP_N=40 by price and
// compute the picks in memory.
//
// GET /functions/v1/get_flight_offers?package_id=<uuid>
// Body: { package_id, route: { origin_iata, dest_iata, ... },
//         picks: { best, cheapest, easiest } | { error } }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "get_flight_offers_v1";
const TOP_N_BY_PRICE = 40;

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

function trim(o: any) {
  if (!o) return null;
  return {
    offer_id: o.offer_id,
    total_price: o.total_price,
    currency: o.currency,
    per_adult: o.per_adult,
    per_child: o.per_child,
    primary_airline_code: o.primary_airline_code,
    primary_airline_name: o.primary_airline_name,
    airline_codes: o.airline_codes,
    outbound_stops: o.outbound_stops,
    return_stops: o.return_stops,
    total_duration_minutes: o.total_duration_minutes,
    outbound_duration_minutes: o.outbound_duration_minutes,
    return_duration_minutes: o.return_duration_minutes,
    outbound_departure_time: o.outbound_departure_time,
    outbound_arrival_time: o.outbound_arrival_time,
    return_departure_time: o.return_departure_time,
    return_arrival_time: o.return_arrival_time,
    outbound_layover_airports: o.outbound_layover_airports,
    return_layover_airports: o.return_layover_airports,
    refundable: o.refundable,
    carry_on_included: o.carry_on_included,
    checked_bag_included: o.checked_bag_included,
    fare_family: o.fare_family,
    provider: o.provider,
  };
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });

  try {
    let package_id: string | null = null;
    if (req.method === "GET") {
      const url = new URL(req.url);
      package_id = url.searchParams.get("package_id");
    } else if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      package_id = body.package_id ?? null;
    } else {
      return new Response(JSON.stringify({ version: VERSION, error: "Use GET or POST" }), { status: 405, headers });
    }

    if (!package_id) {
      return new Response(JSON.stringify({ version: VERSION, error: "package_id required" }), { status: 400, headers });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    const { data: pkg, error: pErr } = await sb
      .from("packages")
      .select("flight_route_id, flight_offer_id, flight_supplier")
      .eq("package_id", package_id)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!pkg) {
      return new Response(JSON.stringify({ version: VERSION, error: "package not found" }), { status: 404, headers });
    }
    if (pkg.flight_supplier !== "liteapi" || !pkg.flight_route_id) {
      return new Response(JSON.stringify({
        version: VERSION, package_id, supplier: pkg.flight_supplier, picks: null,
      }), { status: 200, headers });
    }

    const { data: route, error: rErr } = await sb
      .from("flight_search_routes")
      .select("route_id, origin_iata, dest_iata, departure_date, return_date")
      .eq("route_id", pkg.flight_route_id)
      .maybeSingle();
    if (rErr) throw rErr;

    const { data: offers, error: oErr } = await sb
      .from("flight_offers")
      .select(`
        offer_id, total_price, currency, per_adult, per_child,
        primary_airline_code, primary_airline_name, airline_codes,
        outbound_stops, return_stops, total_duration_minutes,
        outbound_duration_minutes, return_duration_minutes,
        outbound_departure_time, outbound_arrival_time,
        return_departure_time, return_arrival_time,
        outbound_layover_airports, return_layover_airports,
        refundable, carry_on_included, checked_bag_included,
        fare_family, provider
      `)
      .eq("route_id", pkg.flight_route_id)
      .order("total_price", { ascending: true })
      .limit(TOP_N_BY_PRICE);
    if (oErr) throw oErr;

    const list = offers ?? [];
    if (list.length === 0) {
      return new Response(JSON.stringify({ version: VERSION, package_id, route, picks: null, count: 0 }), { status: 200, headers });
    }

    // Cheapest is index 0 (already sorted by price).
    const cheapest = list[0];

    // Best overall: prefer the offer that drives the package's current
    // flight_price (matches the "Best overall" card on results). Fall
    // back to cheapest if we can't find it in the top window.
    const best = list.find(o => o.offer_id === pkg.flight_offer_id) ?? cheapest;

    // Easiest with kids: shortest total duration; break ties by fewer
    // total stops, then by price.
    const easiest = [...list].sort((a, b) => {
      const da = Number(a.total_duration_minutes ?? 9999);
      const db = Number(b.total_duration_minutes ?? 9999);
      if (da !== db) return da - db;
      const sa = Number(a.outbound_stops ?? 9) + Number(a.return_stops ?? 9);
      const sb_ = Number(b.outbound_stops ?? 9) + Number(b.return_stops ?? 9);
      if (sa !== sb_) return sa - sb_;
      return Number(a.total_price ?? 0) - Number(b.total_price ?? 0);
    })[0];

    return new Response(JSON.stringify({
      version: VERSION,
      package_id,
      route,
      count: list.length,
      picks: {
        best: trim(best),
        cheapest: best?.offer_id === cheapest?.offer_id ? null : trim(cheapest),
        easiest: (easiest?.offer_id === best?.offer_id || easiest?.offer_id === cheapest?.offer_id) ? null : trim(easiest),
      },
    }), { status: 200, headers });

  } catch (e) {
    return new Response(JSON.stringify({
      version: VERSION, error: String((e as any)?.message ?? e),
    }), { status: 500, headers });
  }
});
