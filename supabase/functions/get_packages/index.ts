import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "get_packages_v3_limit_1000";

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
    let sort_by: "score" | "price_asc" | "price_desc" = "score";

    if (req.method === "GET") {
      const url = new URL(req.url);
      search_id = url.searchParams.get("search_id");
      limit = Math.min(parseInt(url.searchParams.get("limit") ?? "25", 10), 1000);
      offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
      only_priced = url.searchParams.get("only_priced") === "true";
      const sb = url.searchParams.get("sort_by");
      if (sb === "price_asc" || sb === "price_desc" || sb === "score") sort_by = sb;
    } else if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      search_id = body.search_id ?? null;
      limit = Math.min(body.limit ?? 25, 1000);
      offset = body.offset ?? 0;
      only_priced = body.only_priced === true;
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
      .from("searches")
      .select("*")
      .eq("search_id", search_id)
      .maybeSingle();
    if (sErr) throw sErr;
    if (!search) return new Response(JSON.stringify({ version: VERSION, error: "Search not found" }), { status: 404, headers });

    const { data: job } = await sb
      .from("search_jobs")
      .select("status, flights_done, error")
      .eq("search_id", search_id)
      .maybeSingle();

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
        resorts (
          resort_name,
          country,
          area,
          airport_code,
          avg_user_rating,
          review_count,
          hotel_brand,
          hotel_style,
          amenities_text,
          special_room_options_text,
          food_beach_party_text,
          beds,
          rooms_count,
          year_built,
          year_renovated,
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
          guaranteed_connecting_rooms,
          high_rise
        )
      `, { count: "exact" })
      .eq("search_id", search_id);

    if (only_priced) {
      q = q.not("total_price", "is", null);
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

    const { data: stats } = await sb
      .from("packages")
      .select("flight_price, hotel_price, total_price", { count: "exact" })
      .eq("search_id", search_id);

    const total = stats?.length ?? 0;
    const with_flight = stats?.filter((p: any) => p.flight_price != null).length ?? 0;
    const with_hotel = stats?.filter((p: any) => p.hotel_price != null).length ?? 0;
    const fully_priced = stats?.filter((p: any) => p.total_price != null).length ?? 0;

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
          pricing_complete_pct: total > 0 ? Math.round((fully_priced / total) * 100) : 0,
        },
        pagination: {
          limit,
          offset,
          total_returned: packages?.length ?? 0,
          total_matching: count ?? 0,
        },
        sort_by,
        only_priced,
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
