import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "generate_booking_redirect_v1";

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

function buildBookingHotelUrl(opts: {
  resortName: string;
  city: string | null;
  country: string | null;
  dateStart: string;
  dateEnd: string;
  adults: number;
  childAges: number[];
  marker: string;
  useDirect: boolean;
  directAid?: string;
}) {
  const queryParts = [opts.resortName];
  if (opts.city) queryParts.push(opts.city);
  if (opts.country) queryParts.push(opts.country);
  const ss = queryParts.filter(Boolean).join(" ");

  const params = new URLSearchParams();
  params.set("ss", ss);
  params.set("checkin", opts.dateStart);
  params.set("checkout", opts.dateEnd);
  params.set("group_adults", String(opts.adults));
  params.set("group_children", String(opts.childAges.length));
  for (const age of opts.childAges) {
    params.append("age", String(age));
  }
  params.set("no_rooms", "1");
  params.set("selected_currency", "USD");

  if (opts.useDirect && opts.directAid) {
    params.set("aid", opts.directAid);
    params.set("label", "kindredtrips-mvp");
    return `https://www.booking.com/searchresults.html?${params.toString()}`;
  }

  const targetUrl = `https://www.booking.com/searchresults.html?${params.toString()}`;
  const tpUrl = new URL("https://tp.media/r");
  tpUrl.searchParams.set("marker", opts.marker);
  tpUrl.searchParams.set("p", "4115");
  tpUrl.searchParams.set("u", targetUrl);
  return tpUrl.toString();
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ version: VERSION, error: "Use POST" }), { status: 405, headers });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const package_id = String(body.package_id ?? "");
    const click_type = String(body.click_type ?? "");
    const session_id = body.session_id ?? null;
    const user_agent_family = body.user_agent_family ?? null;
    const referer = body.referer ?? null;

    if (!package_id || !click_type) {
      return new Response(JSON.stringify({ version: VERSION, error: "package_id and click_type required" }), { status: 400, headers });
    }
    if (!"flight hotel".includes(click_type)) {
      return new Response(JSON.stringify({ version: VERSION, error: "click_type must be 'flight' or 'hotel'" }), { status: 400, headers });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const tpMarker = Deno.env.get("TRAVELPAYOUTS_MARKER");
    if (!tpMarker) throw new Error("Missing TRAVELPAYOUTS_MARKER secret");

    const sb = createClient(supabaseUrl, serviceRoleKey);

    const { data: pkg, error: pErr } = await sb
      .from("packages")
      .select(`
        package_id,
        search_id,
        resort_id,
        flight_booking_url,
        hotel_booking_url,
        flight_price,
        hotel_price,
        total_price,
        resorts (
          resort_name,
          country,
          area
        )
      `)
      .eq("package_id", package_id)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!pkg) return new Response(JSON.stringify({ version: VERSION, error: "Package not found" }), { status: 404, headers });

    const { data: search, error: sErr } = await sb
      .from("searches")
      .select("date_start, date_end, adults, children, child_ages, origin_iata")
      .eq("search_id", pkg.search_id)
      .maybeSingle();
    if (sErr) throw sErr;
    if (!search) return new Response(JSON.stringify({ version: VERSION, error: "Search not found" }), { status: 404, headers });

    let target_url: string | null = null;
    let supplier: string | null = null;
    let total_price_at_click: number | null = null;

    if (click_type === "flight") {
      target_url = pkg.flight_booking_url;
      supplier = "aviasales";
      total_price_at_click = pkg.flight_price ? Number(pkg.flight_price) : null;
      if (!target_url) {
        return new Response(JSON.stringify({ version: VERSION, error: "No flight booking URL available for this package" }), { status: 400, headers });
      }
    } else {
      const resort = (pkg as any).resorts;
      target_url = buildBookingHotelUrl({
        resortName: resort?.resort_name ?? "",
        city: resort?.area ?? null,
        country: resort?.country ?? null,
        dateStart: String(search.date_start),
        dateEnd: String(search.date_end),
        adults: Number(search.adults ?? 2),
        childAges: search.child_ages ?? [],
        marker: tpMarker,
        useDirect: false,
      });
      supplier = "booking_via_tp";
      total_price_at_click = pkg.hotel_price ? Number(pkg.hotel_price) : null;
    }

    const { error: clickErr } = await sb.from("outbound_clicks").insert({
      search_id: pkg.search_id,
      package_id: pkg.package_id,
      resort_id: pkg.resort_id,
      click_type,
      target_url,
      supplier,
      deep_link_url: target_url,
      total_price_at_click,
      affiliate_marker: tpMarker,
      session_id,
      user_agent_family,
      referer,
    });
    if (clickErr) {
      console.error("outbound_clicks insert error:", clickErr);
    }

    return new Response(JSON.stringify({
      version: VERSION,
      package_id,
      click_type,
      supplier,
      redirect_url: target_url,
    }), { status: 200, headers });

  } catch (e) {
    console.error("generate_booking_redirect error:", e);
    return new Response(JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }), { status: 500, headers });
  }
});
