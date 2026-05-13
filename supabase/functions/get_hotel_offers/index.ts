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

const VERSION = "get_hotel_offers_v1";
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 24;

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

    const { data, error } = await sb
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

    if (error) throw error;

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
    }), { status: 200, headers });

  } catch (e) {
    return new Response(JSON.stringify({
      version: VERSION,
      error: String((e as any)?.message ?? e),
    }), { status: 500, headers });
  }
});
