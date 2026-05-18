import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "get_packages_v13_leg_durations";

// v13 (2026-05-18):
//   Attach per-leg flight durations + stops from flight_offers so the
//   frontend can treat outbound and inbound as two separate travel days
//   instead of summing them. Falls back silently for mock packages where
//   no flight_offers row exists.
//
// v12 (2026-05-19):
//   Include resorts.airport_transfer_minutes so the frontend's flight
//   friction score can use real numeric transfer time instead of the
//   text-only airport_transfer_notes.
//
// v10 (2026-05-14):
//   Added the package-level fields the frontend filter / modal relies
//   on but that were missing from the SELECT in v9:
//     - has_any_ai, has_any_refundable
//     - hotel_offer_count, hotel_offer_id
//     - flight_offer_count, flight_offer_id, flight_route_id
//     - cheapest_offer_id, cheapest_ai_offer_id, cheapest_ai_total
//     - cheapest_refundable_offer_id, cheapest_refundable_total
//     - max_offer_occupancy
//   Without has_any_ai, the frontend AI filter dropped every
//   liteapi-priced package because `undefined !== true` is always true.
//
// v9 (2026-05-13) — kept: live_only=true default with warmup fallback
//   (skipped when strict_live_only=true).

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, GET, OPTIONS",
  };
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });

  try {
    let search_id: string | null = null;
    let limit = 25;
    let offset = 0;
    let only_priced = false;
    let live_only = true;
    let strict_live_only = false;
    let sort_by: "score" | "price_asc" | "price_desc" = "score";

    if (req.method === "GET") {
      const url = new URL(req.url);
      search_id = url.searchParams.get("search_id");
      limit = Math.min(parseInt(url.searchParams.get("limit") ?? "25", 10), 1000);
      offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
      only_priced = url.searchParams.get("only_priced") === "true";
      const lo = url.searchParams.get("live_only");
      if (lo === "false" || lo === "0") live_only = false;
      const slo = url.searchParams.get("strict_live_only");
      if (slo === "true" || slo === "1") strict_live_only = true;
      const sb = url.searchParams.get("sort_by");
      if (sb === "price_asc" || sb === "price_desc" || sb === "score") sort_by = sb;
    } else if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      search_id = body.search_id ?? null;
      limit = Math.min(body.limit ?? 25, 1000);
      offset = body.offset ?? 0;
      only_priced = body.only_priced === true;
      if (body.live_only === false) live_only = false;
      if (body.strict_live_only === true) strict_live_only = true;
      if (["score", "price_asc", "price_desc"].includes(body.sort_by)) sort_by = body.sort_by;
    } else {
      return new Response(JSON.stringify({ version: VERSION, error: "Use GET or POST" }), { status: 405, headers });
    }

    if (!search_id) {
      return new Response(JSON.stringify({ version: VERSION, error: "search_id required" }), { status: 400, headers });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    const { data: search, error: sErr } = await sb
      .from("searches").select("*").eq("search_id", search_id).maybeSingle();
    if (sErr) throw sErr;
    if (!search) return new Response(JSON.stringify({ version: VERSION, error: "Search not found" }), { status: 404, headers });

    const { data: job } = await sb
      .from("search_jobs").select("status, flights_done, error")
      .eq("search_id", search_id).maybeSingle();

    const { data: stats } = await sb
      .from("packages")
      .select("flight_price, hotel_price, total_price, flight_supplier, hotel_supplier", { count: "exact" })
      .eq("search_id", search_id);

    const total = stats?.length ?? 0;
    const with_flight = stats?.filter((p: any) => p.flight_price != null).length ?? 0;
    const with_hotel = stats?.filter((p: any) => p.hotel_price != null).length ?? 0;
    const fully_priced = stats?.filter((p: any) => p.total_price != null).length ?? 0;
    const live_packages = stats?.filter((p: any) =>
      p.hotel_supplier === "liteapi" && p.flight_supplier === "liteapi"
    ).length ?? 0;
    const mock_packages = total - live_packages;

    let effective_live_only = live_only;
    let is_warming_up = false;
    if (live_only && !strict_live_only) {
      if (live_packages === 0 && fully_priced > 0) {
        effective_live_only = false;
        is_warming_up = true;
      }
    }

    let q = sb
      .from("packages")
      .select(`
        package_id,
        search_id,
        resort_id,
        dest_airport_iata,
        depart_date,
        return_date,
        currency,
        total_price,
        flight_price,
        hotel_price,
        flight_supplier,
        hotel_supplier,
        flight_priced_at,
        hotel_priced_at,
        stops,
        duration_hours,
        score_total,
        highlights,
        warnings,
        hotel_booking_url,
        flight_booking_url,
        priced_at,
        has_any_ai,
        has_any_refundable,
        hotel_offer_count,
        hotel_offer_id,
        flight_offer_count,
        flight_offer_id,
        flight_route_id,
        cheapest_offer_id,
        cheapest_ai_offer_id,
        cheapest_ai_total,
        cheapest_refundable_offer_id,
        cheapest_refundable_total,
        max_offer_occupancy,
        resorts (
          resort_name,
          country,
          area,
          airport_code,
          airport_name,
          avg_user_rating,
          review_count,
          cap_star_rating,
          hotel_brand,
          hotel_style,
          audience,
          amenities_text,
          special_room_options_text,
          food_beach_party_text,
          beds,
          rooms_count,
          year_built,
          year_renovated,
          floors,
          airport_transfer_notes,
          airport_transfer_minutes,
          beach_quality_score,
          on_beach,
          accepts_infants,
          babysitting_available,
          creche_min_age,
          kids_club_available,
          kids_club_min_age,
          kids_club_max_age,
          kids_club_included,
          kids_club_notes,
          family_room_max_occupancy,
          connecting_rooms_available,
          water_park,
          swim_up_rooms,
          data_quality,
          direct_flight,
          direct_usd_2026,
          value_ratio,
          guaranteed_connecting_rooms,
          high_rise,
          google_place_id,
          photo_refs,
          photo_attributions,
          cap_has_kids_club,
          cap_has_family_room,
          cap_has_water_park,
          cap_has_connecting,
          cap_has_suite,
          cap_has_villa,
          cap_max_room_occupancy,
          cap_facilities
        )
      `, { count: "exact" })
      .eq("search_id", search_id);

    if (only_priced || effective_live_only || is_warming_up) {
      q = q.not("total_price", "is", null);
    }
    if (effective_live_only) {
      q = q.eq("hotel_supplier", "liteapi").eq("flight_supplier", "liteapi");
    }
    if (sort_by === "price_asc") {
      q = q.order("total_price", { ascending: true, nullsFirst: false });
    } else if (sort_by === "price_desc") {
      q = q.order("total_price", { ascending: false, nullsFirst: false });
    } else {
      q = q.order("score_total", { ascending: false, nullsFirst: false });
    }
    q = q.range(offset, offset + limit - 1);

    const { data: packages, error: pErr, count } = await q;
    if (pErr) throw pErr;

    // Attach per-leg flight durations / stops from flight_offers so the
    // frontend can treat outbound and inbound as separate travel days.
    // packages.flight_offer_id has no FK to flight_offers so we do this
    // as a batched secondary fetch instead of a PostgREST nested select.
    const offerIds = (packages ?? [])
      .map((p: any) => p.flight_offer_id)
      .filter((id: any) => typeof id === "string" && id.length > 0);
    if (offerIds.length > 0) {
      const { data: offers } = await sb
        .from("flight_offers")
        .select("offer_id, outbound_duration_minutes, return_duration_minutes, outbound_stops, return_stops")
        .in("offer_id", offerIds);
      const offerMap = new Map<string, any>();
      for (const o of (offers ?? [])) offerMap.set(o.offer_id, o);
      for (const p of (packages ?? [])) {
        const fo = offerMap.get(p.flight_offer_id);
        if (fo) {
          p.outbound_minutes = fo.outbound_duration_minutes ?? null;
          p.return_minutes   = fo.return_duration_minutes ?? null;
          p.outbound_stops   = fo.outbound_stops ?? null;
          p.return_stops     = fo.return_stops ?? null;
        }
      }
    }

    return new Response(
      JSON.stringify({
        version: VERSION,
        search_id,
        search: {
          origin_iata: search.origin_iata,
          date_start: search.date_start,
          date_end: search.date_end,
          adults: search.adults,
          children: search.children,
          child_ages: search.child_ages,
          budget_total: search.budget_total,
        },
        job: job ?? null,
        summary: {
          total_packages: total,
          with_flight_price: with_flight,
          with_hotel_price: with_hotel,
          fully_priced,
          live_packages,
          mock_packages,
          pricing_complete_pct: total > 0 ? Math.round((fully_priced / total) * 100) : 0,
          live_pct: total > 0 ? Math.round((live_packages / total) * 100) : 0,
        },
        pagination: {
          limit, offset,
          total_returned: packages?.length ?? 0,
          total_matching: count ?? 0,
        },
        sort_by,
        only_priced,
        live_only,
        effective_live_only,
        is_warming_up,
        packages: packages ?? [],
      }),
      { status: 200, headers },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }),
      { status: 500, headers },
    );
  }
});
