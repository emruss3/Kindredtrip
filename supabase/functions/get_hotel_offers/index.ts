// get_hotel_offers
//
// Returns the stored hotel_rate_offers for a single package_id, sorted by
// total_price ascending. Used by the detail-modal "Room options" section so
// users can see the actual room/board variants behind a result card instead
// of just a count.
//
// Why a dedicated function (vs querying hotel_rate_offers directly from the
// browser): keeps the anon role from needing SELECT on the offers table,
// keeps the row payload trim (we strip raw_offer etc.), and lets us add
// later logic (e.g. deduping room+board+occupancy combos, filtering by
// refundable, capping to N).
//
// GET /functions/v1/get_hotel_offers?package_id=<uuid>&limit=10
// Body shape:
//   { package_id, offers: [{...trimmed columns...}], count }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "get_hotel_offers_v2_catalog";
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 24;

// v2 (2026-05-18):
//   Surface the LiteAPI hotel-level content + the standalone room catalog
//   we backfilled into resorts (liteapi_*) and resort_rooms. The detail
//   page should render real descriptions, bed configs, and room sizes,
//   not just rate-offer names.
//
//   The rate-offer ↔ catalog-room join is unreliable (10% match by name,
//   opaque rate room_type_ids), so catalog_rooms is returned as a
//   standalone list, not joined to offers.

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
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

    // Fire the three reads in parallel: rate offers, resort row (with the
    // new liteapi_* content cols), and resort_rooms catalog.
    const offersP = sb
      .from("hotel_rate_offers")
      .select(`
        offer_id, package_id, room_name, board_type, board_name,
        is_all_inclusive, refundable, refundable_tag, max_occupancy,
        adult_count, child_count, total_price, per_night, currency,
        cancellation_deadline, perks, has_promotions, supplier
      `)
      .eq("package_id", package_id)
      .order("total_price", { ascending: true })
      .limit(MAX_LIMIT);

    const pkgP = sb
      .from("packages")
      .select("resort_id")
      .eq("package_id", package_id)
      .maybeSingle();

    const [{ data, error }, { data: pkgRow, error: pkgErr }] = await Promise.all([offersP, pkgP]);
    if (error) throw error;
    if (pkgErr) throw pkgErr;

    let resort: any = null;
    let catalogRooms: any[] = [];
    if (pkgRow?.resort_id) {
      const [{ data: resortRow }, { data: rooms }] = await Promise.all([
        sb.from("resorts")
          .select("resort_id, resort_name, liteapi_description, liteapi_important_info, liteapi_checkin_time, liteapi_checkout_time, liteapi_policies")
          .eq("resort_id", pkgRow.resort_id)
          .maybeSingle(),
        sb.from("resort_rooms")
          .select("room_id, room_name, description, room_size_sqm, bed_types, bed_relation, max_adults, max_children, max_occupancy, room_amenities, views, photos")
          .eq("resort_id", pkgRow.resort_id)
          .order("max_occupancy", { ascending: false, nullsFirst: false }),
      ]);
      resort = resortRow ?? null;
      catalogRooms = rooms ?? [];
    }

    // De-dupe near-identical offers (same room name + board + refundable +
    // occupancy at the same price) so the UI doesn't show three copies of
    // "Standard 1 King" varying only by cancellation date.
    const seen = new Set<string>();
    const deduped: any[] = [];
    for (const o of data ?? []) {
      const key = [
        o.room_name ?? "",
        o.board_type ?? "",
        o.refundable === true ? "RFN" : (o.refundable === false ? "NRFN" : "?"),
        o.max_occupancy ?? "?",
        Math.round(Number(o.total_price) || 0),
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(o);
      if (deduped.length >= limit) break;
    }

    return new Response(JSON.stringify({
      version: VERSION,
      package_id,
      count: deduped.length,
      offers: deduped,
      resort,
      catalog_rooms: catalogRooms,
    }), { status: 200, headers });

  } catch (e) {
    return new Response(JSON.stringify({
      version: VERSION,
      error: String((e as any)?.message ?? e),
    }), { status: 500, headers });
  }
});
