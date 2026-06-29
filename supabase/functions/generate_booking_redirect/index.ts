import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "generate_booking_redirect_v6_hotel_page_deeplink";

// Country name -> ISO-3166-1 alpha-2 for Booking hotel-page deep links
// (booking.com/hotel/<cc>/<slug>.html). Covers the catalog's countries plus
// common name variants seen in the resorts table.
const COUNTRY_CC: Record<string, string> = {
  "mexico": "mx", "dominican republic": "do", "jamaica": "jm", "saint lucia": "lc",
  "st lucia": "lc", "barbados": "bb", "costa rica": "cr", "antigua and barbuda": "ag",
  "antigua": "ag", "aruba": "aw", "colombia": "co", "turks and caicos": "tc",
  "bahamas": "bs", "the bahamas": "bs", "curacao": "cw", "curaçao": "cw", "belize": "bz",
  "grenada": "gd", "honduras": "hn", "panama": "pa", "sint maarten": "sx",
  "saint martin": "mf", "st martin": "mf", "british virgin islands": "vg",
  "guatemala": "gt", "ecuador": "ec", "peru": "pe", "us virgin islands": "vi",
  "u.s. virgin islands": "vi", "saint thomas": "vi", "st thomas": "vi",
  "saint vincent and the grenadines": "vc", "saint vincent": "vc", "bermuda": "bm",
  "cayman islands": "ky", "grand cayman": "ky", "el salvador": "sv", "bonaire": "bq",
  "haiti": "ht", "martinique": "mq", "dominica": "dm", "nicaragua": "ni",
  "saint kitts and nevis": "kn", "guadeloupe": "gp", "trinidad and tobago": "tt",
};

function countryCode(country: string | null): string | null {
  if (!country) return null;
  return COUNTRY_CC[country.trim().toLowerCase()] ?? null;
}

// Booking hotel-page slug from the hotel name. Booking slugs are a
// deterministic slugify of the official name (accents folded, & -> "and",
// "all inclusive" dropped, non-alphanumerics -> "-"). Verified against live
// Booking URLs, e.g. "Sensira Resort & Spa Riviera Maya" ->
// "sensira-resort-and-spa-riviera-maya".
function bookingSlug(rawName: string): string {
  return cleanResortName(rawName)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\ball[\s-]?inclusive\b/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Aviasales (Travelpayouts) flight-search deep link. We don't store a
// per-fare booking URL — flight_booking_url is null and LiteAPI flight
// offers carry no deep link — so we construct an Aviasales search from the
// route + dates + passenger count, affiliate-tagged with our TP marker.
// Format: ORIGIN + DDMM(depart) + DEST + DDMM(return) + passengers.
// Returns null if either IATA is malformed (caller surfaces an error).
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

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

// Strip booking-poisoning junk from resort names (parenthetical age/policy
// notes, audience tags, refundability notes) so Booking's search resolves
// to the real hotel.
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

// Fallback when we can't resolve the country code to a Booking hotel-page
// slug: a destination results LIST (never 404s, but availability can lag).
function buildSearchResultsUrl(opts: {
  resortName: string; city: string | null; country: string | null;
  dateStart: string; dateEnd: string; adults: number; childAges: number[]; marker: string;
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
  params.set("no_rooms", "1");
  params.set("selected_currency", "USD");
  return wrapTp(`https://www.booking.com/searchresults.html?${params.toString()}`, opts.marker);
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
}): string {
  // v6: deep-link to the Booking HOTEL PAGE, not the searchresults flat list.
  // Evidence (production): the flat list returns "Unavailable on our site for
  // your selected dates" for hotels whose live availability the aggregate
  // search engine hasn't cached, while the hotel page does a live query and
  // shows the same dates as available. The hotel-page slug is a deterministic
  // slugify of the name, so we can build it directly. Full occupancy
  // (adults + children + ages) is sent so families see the correct rooms and
  // any "free child stay" pricing. Falls back to a results list only when the
  // country code can't be resolved (so we never produce a worse link than v5).
  const cc = countryCode(opts.country);
  const slug = bookingSlug(opts.resortName);
  if (!cc || !slug) {
    return buildSearchResultsUrl(opts);
  }
  const url = new URL(`https://www.booking.com/hotel/${cc}/${slug}.html`);
  url.searchParams.set("checkin", opts.dateStart);
  url.searchParams.set("checkout", opts.dateEnd);
  url.searchParams.set("group_adults", String(opts.adults));
  url.searchParams.set("group_children", String(opts.childAges.length));
  for (const a of opts.childAges) url.searchParams.append("age", String(a));
  url.searchParams.set("no_rooms", "1");
  url.searchParams.set("selected_currency", "USD");
  return wrapTp(url.toString(), opts.marker);
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
        resorts ( resort_name, country, area )
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
      // Prefer a stored fare URL if one ever exists; otherwise construct an
      // Aviasales search deep link from the route + dates (the normal path
      // today, since flight_booking_url is not populated).
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
      target_url = buildBookingHotelUrl({
        resortName: resort?.resort_name ?? "",
        city: resort?.area ?? null,
        country: resort?.country ?? null,
        dateStart: String(search.date_start),
        dateEnd: String(search.date_end),
        adults: Number(search.adults ?? 2),
        childAges: search.child_ages ?? [],
        marker: tpMarker,
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
    if (clickErr) console.error("outbound_clicks insert error:", clickErr);

    return new Response(JSON.stringify({
      version: VERSION,
      package_id, click_type, supplier,
      redirect_url: target_url,
    }), { status: 200, headers });

  } catch (e) {
    console.error("generate_booking_redirect error:", e);
    return new Response(JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }), { status: 500, headers });
  }
});
