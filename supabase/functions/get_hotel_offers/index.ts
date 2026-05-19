// get_hotel_offers v4
//
// Returns the stored hotel_rate_offers for a single package_id, sorted by
// total_price ascending. Used by the detail-modal "Room options" section.
//
// GET /functions/v1/get_hotel_offers?package_id=<uuid>&limit=10
// Body shape:
//   { package_id, offers, count, resort, catalog_rooms, match_stats }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "get_hotel_offers_v4_id_only";
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 24;

// v4 (2026-05-19):
//   Fuzzy matching removed. Grouping is now strictly two-tier:
//     - "mapped_id"   LiteAPI rate.mappedRoomId resolves to a
//                      resort_rooms.room_id row  →  group_key cat:<id>
//     - "synthetic"   no mapped_room_id or no matching resort_rooms row
//                      →  group_key synth:<normalized_name>
//   No fuzzy/Jaccard tier. Pre-flag cached offers render sparse honest
//   cards (rate name + price) until they re-cache naturally.
//
// v3: introduced server-side join (mapped_id → fuzzy_name → synthetic).
//   Fuzzy was a bridge while roomMapping:true wasn't on all paths;
//   that's now resolved, so fuzzy is gone.

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

// Normalization is used ONLY to key synthetic groups, not to match
// against catalog rooms. Strict id-only join means a rate without a
// mapped_room_id never inherits catalog content from a "similar" name.
function normalizeRoomName(name: string | null | undefined): string {
  if (!name) return "";
  let s = String(name);
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(/\s*\([^()]*\)\s*$/, "");
    s = s.replace(/\s*[-–]\s*[A-Z0-9 ]{2,}\s*$/, "");
    s = s.replace(/\s*,[^,]*$/, "");
    if (s === before) break;
  }
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

type CatalogRoom = {
  room_id: string;
  room_name: string | null;
  [k: string]: any;
};

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

    const offersP = sb
      .from("hotel_rate_offers")
      .select(`
        offer_id, package_id, room_name, mapped_room_id, board_type, board_name,
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
    let catalogRooms: CatalogRoom[] = [];
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
      catalogRooms = (rooms ?? []) as CatalogRoom[];
    }

    // Catalog lookup is id-only now. We do NOT build a normalized-name
    // index against the catalog — that was the fuzzy fallback path and
    // it's gone.
    const catalogById = new Map<string, CatalogRoom>();
    for (const c of catalogRooms) {
      if (c.room_id != null) catalogById.set(String(c.room_id), c);
    }

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

    // Two-tier grouping. Strict precedence:
    //   1. mapped_room_id is non-null AND resolves to a resort_rooms row
    //      → match_path "mapped_id", group_key "cat:<room_id>"
    //   2. otherwise → match_path "synthetic", group_key "synth:<normalized_name>"
    // An offer with a mapped_room_id that DOESN'T resolve also goes
    // synthetic — we don't infer; we either have the id or we don't.
    const matchStats: Record<string, number> = { mapped_id: 0, synthetic: 0 };
    for (const o of deduped) {
      const mapped = o.mapped_room_id != null ? String(o.mapped_room_id) : null;
      const matched = mapped ? catalogById.get(mapped) : null;
      if (matched) {
        o.group_key = `cat:${matched.room_id}`;
        o.match_path = "mapped_id";
        o.matched_room_id = String(matched.room_id);
        matchStats.mapped_id++;
      } else {
        const nk = normalizeRoomName(o.room_name);
        o.group_key = `synth:${nk || "unknown"}`;
        o.match_path = "synthetic";
        o.matched_room_id = null;
        matchStats.synthetic++;
      }
    }

    return new Response(JSON.stringify({
      version: VERSION,
      package_id,
      count: deduped.length,
      offers: deduped,
      resort,
      catalog_rooms: catalogRooms,
      match_stats: matchStats,
    }), { status: 200, headers });

  } catch (e) {
    return new Response(JSON.stringify({
      version: VERSION,
      error: String((e as any)?.message ?? e),
    }), { status: 500, headers });
  }
});
