// Built-in Deno.serve (no deno.land/std import) for bundler reliability.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "generate_booking_redirect_v8_multiroom";

// v7 (2026-06-29): NEVER construct Booking hotel-page URLs from resort
// names/slugs — slug guessing 404s (e.g. "Wyndham Grand Cancun All Inclusive
// Resort & Villas"). Hotel deep links now come ONLY from a verified property
// URL: packages.hotel_booking_url first, then resorts.booking_property_url.
// We append the stay/occupancy params to that verified URL and affiliate-wrap
// it. If no verified URL exists we fall back to a Booking searchresults search
// and report supplier=booking_search_fallback so the UI can label the button
// "Search on Booking.com" instead of "Book hotel on Booking.com".

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

// Strip booking-poisoning junk from resort names (parenthetical age/policy
// notes, audience tags) so the FALLBACK search resolves to the real hotel.
function cleanResortName(raw: string): string {
  let s = String(raw ?? "");
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.replace(/\[[^\]]*\]/g, " ");
  s = s.replace(/\b(adults?\s*only|couples?\s*only|clothing\s*optional|nude(\s*areas)?|non[-\s]?refundable|all\s*ages|\d{1,2}\s*\+)\b/gi, " ");
  s = s.replace(/[-–—,]\s*$/g, " ");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

function wrapTp(targetUrl: string, marker: string): string {
  const tpUrl = new URL("https://tp.media/r");
  tpUrl.searchParams.set("marker", marker);
  tpUrl.searchParams.set("p", "4115");
  tpUrl.searchParams.set("u", targetUrl);
  return tpUrl.toString();
}

// Append stay + occupancy to a (verified) Booking property URL, preserving
// whatever path/query the verified URL already has.
function roomsFor(adults: number, childAges: number[]): number {
  // Mirror of the pricing pipeline's 2-room split for parties >= 5.
  const party = adults + childAges.filter((a) => a >= 2).length;
  return party >= 5 && adults >= 2 ? 2 : 1;
}

function appendStayParams(rawUrl: string, opts: {
  dateStart: string; dateEnd: string; adults: number; childAges: number[];
}): string {
  const u = new URL(rawUrl);
  u.searchParams.set("checkin", opts.dateStart);
  u.searchParams.set("checkout", opts.dateEnd);
  u.searchParams.set("group_adults", String(opts.adults));
  u.searchParams.set("group_children", String(opts.childAges.length));
  u.searchParams.delete("age");
  for (const a of opts.childAges) u.searchParams.append("age", String(a));
  u.searchParams.set("no_rooms", String(roomsFor(opts.adults, opts.childAges)));
  u.searchParams.set("selected_currency", "USD");
  return u.toString();
}

// Fallback only: Booking destination search (never 404s, availability can lag).
function buildSearchFallbackUrl(opts: {
  resortName: string; city: string | null; country: string | null;
  dateStart: string; dateEnd: string; adults: number; childAges: number[];
}): string {
  const queryParts = [cleanResortName(opts.resortName)];
  if (opts.city) queryParts.push(opts.city);
  if (opts.country) queryParts.push(opts.country);
  const params = new URLSearchParams();
  params.set("ss", queryParts.filter(Boolean).join(", "));
  params.set("checkin", opts.dateStart);
  params.set("checkout", opts.dateEnd);
  params.set("group_adults", String(opts.adults));
  params.set("group_children", String(opts.childAges.length));
  for (const a of opts.childAges) params.append("age", String(a));
  params.set("no_rooms", String(roomsFor(opts.adults, opts.childAges)));
  params.set("selected_currency", "USD");
  return `https://www.booking.com/searchresults.html?${params.toString()}`;
}

// Aviasales (Travelpayouts) flight-search deep link from route + dates + pax.
function ddmm(iso: string): string {
  const d = new Date(iso);
  return String(d.getUTCDate()).padStart(2, "0") + String(d.getUTCMonth() + 1).padStart(2, "0");
}
function buildAviasalesUrl(o: {
  origin: string; dest: string; dateStart: string; dateEnd: string; pax: number; marker: string;
}): string | null {
  const O = String(o.origin || "").toUpperCase();
  const D = String(o.dest || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(O) || !/^[A-Z]{3}$/.test(D)) return null;
  const pax = Math.min(9, Math.max(1, Math.floor(o.pax || 1)));
  const code = `${O}${ddmm(o.dateStart)}${D}${ddmm(o.dateEnd)}${pax}`;
  return `https://www.aviasales.com/search/${code}?marker=${encodeURIComponent(o.marker)}`;
}

Deno.serve(async (req) => {
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
    if (click_type !== "flight" && click_type !== "hotel") {
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
        package_id, search_id, resort_id, dest_airport_iata,
        flight_booking_url, hotel_booking_url,
        flight_price, hotel_price, total_price,
        resorts ( resort_name, country, area, booking_property_url, booking_status )
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
    let verified = false;

    if (click_type === "flight") {
      const childAges = Array.isArray(search.child_ages) ? search.child_ages : [];
      const seatedPax = Number(search.adults ?? 2) + childAges.filter((a: any) => Number(a) >= 2).length;
      target_url = pkg.flight_booking_url || buildAviasalesUrl({
        origin: String(search.origin_iata ?? ""),
        dest: String(pkg.dest_airport_iata ?? ""),
        dateStart: String(search.date_start),
        dateEnd: String(search.date_end),
        pax: seatedPax,
        marker: tpMarker,
      });
      supplier = "aviasales";
      total_price_at_click = pkg.flight_price ? Number(pkg.flight_price) : null;
      if (!target_url) {
        return new Response(JSON.stringify({ version: VERSION, error: "Could not build a flight booking link (missing or invalid airport codes for this route)." }), { status: 400, headers });
      }
    } else {
      const resort = (pkg as any).resorts;
      const childAges: number[] = Array.isArray(search.child_ages) ? search.child_ages : [];
      const stay = {
        dateStart: String(search.date_start),
        dateEnd: String(search.date_end),
        adults: Number(search.adults ?? 2),
        childAges,
      };
      // Verified property URL only: package-level override, then resort mapping.
      const verifiedUrl: string | null =
        (pkg.hotel_booking_url && String(pkg.hotel_booking_url)) ||
        (resort?.booking_property_url && String(resort.booking_property_url)) ||
        null;

      if (verifiedUrl) {
        target_url = wrapTp(appendStayParams(verifiedUrl, stay), tpMarker);
        supplier = "booking_property";
        verified = true;
      } else {
        target_url = wrapTp(buildSearchFallbackUrl({
          resortName: resort?.resort_name ?? "",
          city: resort?.area ?? null,
          country: resort?.country ?? null,
          ...stay,
        }), tpMarker);
        supplier = "booking_search_fallback";
        verified = false;
      }
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
    if (clickErr) console.error("outbound_clicks insert error:", clickErr);

    return new Response(JSON.stringify({
      version: VERSION,
      package_id, click_type, supplier, verified,
      redirect_url: target_url,
    }), { status: 200, headers });

  } catch (e) {
    console.error("generate_booking_redirect error:", e);
    return new Response(JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }), { status: 500, headers });
  }
});
