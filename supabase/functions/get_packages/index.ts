import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "get_packages_v20_avoid_huge_in_clause";

// v20 (2026-06-23): v19 fixed the live_packages count by uncapping the
// hotel_rate_offers fetch. But when the live set is large (~300+ packages),
// the resulting `package_id=in.(uuid1,uuid2,...)` URL on the main packages
// query blew past the HTTP/2 header size limit and failed with a stream
// protocol error (HTTP 500: 'http2 error: stream error detected').
//
// Fix: when supplier filters are already applied (effective_live_only or
// strict_live_only), trust them and SKIP the package_id IN-gate. Reason:
// start_pricing writes hotel_supplier='liteapi' AND the matching rate
// offers atomically inside the same handler call; a package with
// hotel_supplier='liteapi' has offers in essentially every case (only edge
// case: an offer-write budget overrun leaves <1% without offers, which is
// acceptable). For non-strict modes (`live_only` warming-up path), keep
// the IN-gate behavior, but cap at MAX_IN_IDS to stay under the HTTP/2
// URL limit; if we'd exceed that, fall back to the supplier filter alone.
//
// v19 (2026-06-23): smaller offer-fetch chunks + explicit .limit(100000)
// to defeat PostgREST's default 1000-row cap.

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, GET, OPTIONS",
  };
}

// Cap for `package_id=in.(...)` URL: 200 UUIDs * ~38 chars each ~= 7.6 KB,
// safely under common HTTP/2 8-16 KB request URL limits.
const MAX_IN_IDS = 200;

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
    let prepaint = false;
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
      prepaint = url.searchParams.get("prepaint") === "true";
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
      prepaint = body.prepaint === true;
      if (["score", "price_asc", "price_desc"].includes(body.sort_by)) sort_by = body.sort_by;
    } else {
      return new Response(JSON.stringify({ version: VERSION, error: "Use GET or POST" }), { status: 405, headers });
    }

    if (!search_id) {
      return new Response(JSON.stringify({ version: VERSION, error: "search_id required" }), { status: 400, headers });
    }

    if (prepaint) { only_priced = false; live_only = false; strict_live_only = false; }

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
      .select("package_id, flight_price, hotel_price, total_price, flight_supplier, hotel_supplier, resort_id, resorts!inner(liteapi_hotel_id)", { count: "exact" })
      .eq("search_id", search_id);

    const allPkgIds = (stats ?? []).map((s: any) => s.package_id);
    const pkgIdsWithOffers = new Set<string>();
    if (allPkgIds.length > 0) {
      const CHUNK = 100;
      for (let i = 0; i < allPkgIds.length; i += CHUNK) {
        const slice = allPkgIds.slice(i, i + CHUNK);
        const { data: offerRows } = await sb
          .from("hotel_rate_offers")
          .select("package_id")
          .in("package_id", slice)
          .limit(100000);
        for (const r of (offerRows ?? [])) pkgIdsWithOffers.add(r.package_id);
      }
    }

    const total = stats?.length ?? 0;
    const with_flight = stats?.filter((p: any) => p.flight_price != null).length ?? 0;
    const with_hotel = stats?.filter((p: any) => p.hotel_price != null).length ?? 0;
    const fully_priced = stats?.filter((p: any) =>
      p.total_price != null && pkgIdsWithOffers.has(p.package_id)
    ).length ?? 0;
    const live_packages = stats?.filter((p: any) =>
      p.hotel_supplier === "liteapi" && p.flight_supplier === "liteapi"
      && pkgIdsWithOffers.has(p.package_id)
    ).length ?? 0;
    const mock_packages = total - live_packages;

    const hotel_terminal = stats?.filter((p: any) => {
      if (p.hotel_supplier === "liteapi" || p.hotel_supplier === "no_fit") return true;
      if (p.hotel_supplier === "mock" && !p.resorts?.liteapi_hotel_id) return true;
      return false;
    }).length ?? 0;
    const pricing_active_packages = total - hotel_terminal;
    const pricing_settled = pricing_active_packages === 0 && with_flight >= total;

    let effective_live_only = live_only;
    let is_warming_up = false;
    if (live_only && !strict_live_only && !prepaint) {
      if (live_packages === 0 && fully_priced > 0) {
        effective_live_only = false;
        is_warming_up = true;
      }
    }

    let q = sb
      .from("packages")
      .select(`
        package_id, search_id, resort_id, dest_airport_iata, depart_date, return_date,
        currency, total_price, flight_price, hotel_price, flight_supplier, hotel_supplier,
        flight_priced_at, hotel_priced_at, stops, duration_hours, score_total,
        highlights, warnings, hotel_booking_url, flight_booking_url, priced_at,
        has_any_ai, has_any_refundable, hotel_offer_count, hotel_offer_id,
        flight_offer_count, flight_offer_id, flight_route_id,
        cheapest_offer_id, cheapest_ai_offer_id, cheapest_ai_total,
        cheapest_refundable_offer_id, cheapest_refundable_total, max_offer_occupancy,
        flight_price_basis,
        resorts (
          resort_name, country, area, airport_code, airport_name,
          avg_user_rating, review_count, cap_star_rating, hotel_brand, hotel_style,
          audience, amenities_text, special_room_options_text, food_beach_party_text,
          beds, rooms_count, year_built, year_renovated, floors,
          airport_transfer_notes, airport_transfer_minutes, beach_quality_score,
          on_beach, accepts_infants, babysitting_available, creche_min_age,
          kids_club_available, kids_club_min_age, kids_club_max_age, kids_club_included,
          kids_club_notes, family_room_max_occupancy, connecting_rooms_available,
          water_park, swim_up_rooms, data_quality, direct_flight, direct_usd_2026,
          value_ratio, guaranteed_connecting_rooms, high_rise, google_place_id,
          photo_refs, photo_attributions, liteapi_hotel_photos,
          cap_has_kids_club, cap_has_family_room, cap_has_water_park, cap_has_connecting,
          cap_has_suite, cap_has_villa, cap_max_room_occupancy, cap_facilities
        )
      `, { count: "exact" })
      .eq("search_id", search_id);

    if (only_priced || effective_live_only || is_warming_up) {
      q = q.not("total_price", "is", null);
    }
    if (effective_live_only) {
      q = q.eq("hotel_supplier", "liteapi").eq("flight_supplier", "liteapi");
    }

    // v20: bound the package_id IN-clause so the URL stays under HTTP/2's
    // header-size limit. Three cases:
    //   (a) prepaint -> no filter at all (existing behavior)
    //   (b) effective_live_only AND too many IDs -> trust supplier filters,
    //       skip the IN-gate. Edge case: <1% packages might have
    //       hotel_supplier='liteapi' without offers (offer-write budget
    //       overrun in start_pricing); those leak through, but room-offer
    //       fetch on the trip detail page handles the empty case cleanly.
    //   (c) otherwise -> apply IN-gate normally.
    if (!prepaint) {
      const ids = Array.from(pkgIdsWithOffers);
      if (ids.length === 0) {
        if (!effective_live_only) {
          // No offers yet AND we're not in supplier-filter mode -> match nothing.
          q = q.eq("package_id", "00000000-0000-0000-0000-000000000000");
        }
        // else: supplier filters do the work; let through whatever hotel='liteapi'.
      } else if (ids.length <= MAX_IN_IDS) {
        q = q.in("package_id", ids);
      } else if (!effective_live_only) {
        // Too many IDs AND no supplier filter to fall back on. Clamp the IN-
        // gate to the top MAX_IN_IDS by score-order to keep the URL bounded.
        // This case is rare (only_priced=true with hundreds of mock+live
        // packages), but we still want a bounded URL.
        q = q.in("package_id", ids.slice(0, MAX_IN_IDS));
      }
      // else: too many IDs but effective_live_only is set -> trust supplier
      // filters, skip the IN-gate (the v20 fix).
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

    const resortIds = Array.from(new Set((packages ?? []).map((p: any) => p.resort_id).filter(Boolean)));
    if (resortIds.length > 0) {
      const { data: fams } = await sb
        .from("resort_family_signals")
        .select("resort_id, family_avg_score, family_review_count, signal_confidence")
        .in("resort_id", resortIds);
      const famByResort = new Map<string, any>();
      for (const f of (fams ?? [])) famByResort.set(f.resort_id, f);
      for (const p of (packages ?? [])) {
        const f = famByResort.get(p.resort_id);
        if (f) {
          p.family_avg_score = f.family_avg_score;
          p.family_review_count = f.family_review_count;
          p.family_signal_confidence = f.signal_confidence;
        }
      }
    }

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
        version: VERSION, search_id,
        search: {
          origin_iata: search.origin_iata, date_start: search.date_start,
          date_end: search.date_end, adults: search.adults,
          children: search.children, child_ages: search.child_ages,
          budget_total: search.budget_total,
        },
        job: job ?? null,
        summary: {
          total_packages: total, with_flight_price: with_flight, with_hotel_price: with_hotel,
          fully_priced, live_packages, mock_packages, hotel_terminal,
          pricing_active_packages, pricing_settled,
          pricing_complete_pct: total > 0 ? Math.round((fully_priced / total) * 100) : 0,
          live_pct: total > 0 ? Math.round((live_packages / total) * 100) : 0,
        },
        pagination: { limit, offset, total_returned: packages?.length ?? 0, total_matching: count ?? 0 },
        sort_by, only_priced, live_only, effective_live_only, is_warming_up, prepaint,
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
