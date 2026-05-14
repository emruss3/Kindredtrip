// get_flight_offers
//
// Returns flight offers for a single package_id, plus three curated picks
// for the detail-modal "Top picks" row:
//   - best:     the offer that drives the package's current flight_price
//   - cheapest: absolute cheapest, regardless of stops/duration
//   - easiest:  shortest total duration, prefer fewer stops
//
// We resolve the route via packages.flight_route_id, then read
// flight_offers ordered by total_price ASC. If that route has no offers
// (rare — happens when the package was mock-priced or the worker hasn't
// finished), we fall back to looking up any route with the same
// origin+dest+dates+pax in flight_search_routes and use whichever has
// the most recent offers.
//
// GET /functions/v1/get_flight_offers?package_id=<uuid>&limit=15
// Response:
//   { package_id, route, count, source, offers: [...], picks: { best, cheapest, easiest } }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "get_flight_offers_v3";
const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;

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
    let limit = DEFAULT_LIMIT;

    if (req.method === "GET") {
      const url = new URL(req.url);
      package_id = url.searchParams.get("package_id");
      const l = parseInt(url.searchParams.get("limit") ?? "", 10);
      if (Number.isFinite(l) && l > 0) limit = Math.min(l, MAX_LIMIT);
    } else if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      package_id = body.package_id ?? null;
      const l = Number(body.limit);
      if (Number.isFinite(l) && l > 0) limit = Math.min(l, MAX_LIMIT);
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
      .select(`
        package_id, search_id, flight_route_id, flight_offer_id, flight_supplier, dest_airport_iata,
        searches ( origin_iata, date_start, date_end, adults, child_ages )
      `)
      .eq("package_id", package_id)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!pkg) {
      return new Response(JSON.stringify({ version: VERSION, error: "package not found" }), { status: 404, headers });
    }

    let routeId: string | null = pkg.flight_route_id ?? null;
    let routeMeta: any = null;
    let source: "package_route" | "fallback_source_route" = "package_route";

    if (routeId) {
      const { data: r } = await sb
        .from("flight_search_routes")
        .select("route_id, origin_iata, dest_iata, departure_date, return_date, adults, children, infants")
        .eq("route_id", routeId)
        .maybeSingle();
      routeMeta = r ?? null;
    }

    const OFFER_SELECT = `
      offer_id, total_price, currency, per_adult, per_child,
      primary_airline_code, primary_airline_name, airline_codes,
      outbound_stops, return_stops, total_duration_minutes,
      outbound_duration_minutes, return_duration_minutes,
      outbound_departure_time, outbound_arrival_time,
      return_departure_time, return_arrival_time,
      outbound_layover_airports, return_layover_airports,
      refundable, carry_on_included, checked_bag_included,
      fare_family, provider
    `;

    let offers: any[] = [];
    if (routeId) {
      const { data: o, error: oErr } = await sb
        .from("flight_offers")
        .select(OFFER_SELECT)
        .eq("route_id", routeId)
        .order("total_price", { ascending: true })
        .limit(limit);
      if (oErr) throw oErr;
      offers = o ?? [];
    }

    // Fallback: same origin/dest/dates from a sibling route (another
    // search that priced the same itinerary). Useful when this package
    // is mock-priced but cached liteapi data exists for the route.
    // Fallback: same origin/dest/dates from a sibling route. Useful when
    // the package's own flight_route_id points at a duplicate route row
    // whose flight_offers were attached to a sibling instead — production
    // has 2-3 routes per (origin,dest,date) and only one carries the
    // actual offer rows. We pull every matching sibling and pick the one
    // whose flight_offers table actually has rows (highest count wins).
    if (offers.length === 0 && pkg.dest_airport_iata) {
      const s = (pkg as any).searches;
      if (s?.origin_iata && s?.date_start && s?.date_end) {
        const { data: sibs } = await sb
          .from("flight_search_routes")
          .select("route_id, origin_iata, dest_iata, departure_date, return_date, adults, children, infants, fetched_at")
          .eq("origin_iata", s.origin_iata)
          .eq("dest_iata", pkg.dest_airport_iata)
          .eq("departure_date", s.date_start)
          .eq("return_date", s.date_end)
          .eq("status", "done")
          .order("fetched_at", { ascending: false })
          .limit(10);
        const siblings = (sibs ?? []).filter((r: any) => r.route_id !== routeId);
        for (const sib of siblings) {
          const { data: fo } = await sb
            .from("flight_offers")
            .select(OFFER_SELECT)
            .eq("route_id", sib.route_id)
            .order("total_price", { ascending: true })
            .limit(limit);
          if (fo && fo.length > 0) {
            offers = fo;
            routeMeta = sib;
            source = "fallback_source_route";
            break;
          }
        }
      }
    }

    if (offers.length === 0) {
      return new Response(JSON.stringify({
        version: VERSION, package_id, route: routeMeta, count: 0, source, offers: [], picks: null,
      }), { status: 200, headers });
    }

    const trimmedOffers = offers.map(trim);
    const cheapest = trimmedOffers[0]!;
    const best = trimmedOffers.find(o => o!.offer_id === pkg.flight_offer_id) ?? cheapest;

    const easiest = [...trimmedOffers].sort((a, b) => {
      const da = Number(a!.total_duration_minutes ?? 9999);
      const db = Number(b!.total_duration_minutes ?? 9999);
      if (da !== db) return da - db;
      const sa = Number(a!.outbound_stops ?? 9) + Number(a!.return_stops ?? 9);
      const sbn = Number(b!.outbound_stops ?? 9) + Number(b!.return_stops ?? 9);
      if (sa !== sbn) return sa - sbn;
      return Number(a!.total_price ?? 0) - Number(b!.total_price ?? 0);
    })[0]!;

    return new Response(JSON.stringify({
      version: VERSION,
      package_id,
      route: routeMeta,
      count: trimmedOffers.length,
      source,
      offers: trimmedOffers,
      picks: {
        best,
        cheapest: best.offer_id === cheapest.offer_id ? null : cheapest,
        easiest: (easiest.offer_id === best.offer_id || easiest.offer_id === cheapest.offer_id) ? null : easiest,
      },
    }), { status: 200, headers });

  } catch (e) {
    return new Response(JSON.stringify({
      version: VERSION, error: String((e as any)?.message ?? e),
    }), { status: 500, headers });
  }
});
