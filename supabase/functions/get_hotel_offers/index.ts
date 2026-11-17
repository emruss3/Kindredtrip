// get_hotel_offers v6 — adds room_parts (per-room breakdown of multi-room offers)
//
// Based on the deployed v5 source (hotelImages + pricing_settling keyed on
// hotel_supplier). v6 only adds `room_parts`, read from
// raw_offer._room_parts written by start_pricing v23 / top_up_hotels_worker
// v15. Each entry: { occ, name, total, adults, children_ages, max_occupancy,
// board_type, board_name, refundable_tag, mapped_room_id }. Null for
// single-room offers and for multi-room offers cached before v23.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "get_hotel_offers_v6_room_parts";
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 24;

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

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

type CatalogRoom = { room_id: string; room_name: string | null; [k: string]: any };

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
    if (!package_id) return new Response(JSON.stringify({ version: VERSION, error: "package_id required" }), { status: 400, headers });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    const offersP = sb.from("hotel_rate_offers").select(`offer_id, package_id, room_name, mapped_room_id, board_type, board_name, is_all_inclusive, refundable, refundable_tag, max_occupancy, adult_count, child_count, total_price, per_night, currency, cancellation_deadline, perks, has_promotions, supplier, room_parts:raw_offer->_room_parts`).eq("package_id", package_id).order("total_price", { ascending: true }).limit(MAX_LIMIT);
    const pkgP = sb.from("packages").select("resort_id, hotel_supplier").eq("package_id", package_id).maybeSingle();

    const [{ data, error }, { data: pkgRow, error: pkgErr }] = await Promise.all([offersP, pkgP]);
    if (error) throw error;
    if (pkgErr) throw pkgErr;

    let resort: any = null;
    let catalogRooms: CatalogRoom[] = [];
    let hotelImages: any[] = [];
    if (pkgRow?.resort_id) {
      const [{ data: resortRow }, { data: rooms }] = await Promise.all([
        sb.from("resorts").select("resort_id, resort_name, liteapi_description, liteapi_important_info, liteapi_checkin_time, liteapi_checkout_time, liteapi_policies, cap_raw_detail").eq("resort_id", pkgRow.resort_id).maybeSingle(),
        sb.from("resort_rooms").select("room_id, room_name, description, room_size_sqm, bed_types, bed_relation, max_adults, max_children, max_occupancy, room_amenities, views, photos").eq("resort_id", pkgRow.resort_id).order("max_occupancy", { ascending: false, nullsFirst: false }),
      ]);
      if (resortRow) {
        const raw = resortRow.cap_raw_detail as any;
        if (Array.isArray(raw?.hotelImages)) {
          hotelImages = raw.hotelImages
            .map((img: any) => ({ url: img?.url ?? img?.urlHd ?? null, hd_url: img?.urlHd ?? img?.url ?? null }))
            .filter((p: any) => p.url || p.hd_url);
        }
        delete resortRow.cap_raw_detail;
      }
      resort = resortRow ?? null;
      catalogRooms = (rooms ?? []) as CatalogRoom[];
    }

    const catalogById = new Map<string, CatalogRoom>();
    for (const c of catalogRooms) {
      if (c.room_id != null) catalogById.set(String(c.room_id), c);
    }

    const seen = new Set<string>();
    const deduped: any[] = [];
    for (const o of data ?? []) {
      const key = [o.room_name ?? "", o.board_type ?? "", o.refundable === true ? "RFN" : (o.refundable === false ? "NRFN" : "?"), o.max_occupancy ?? "?", Math.round(Number(o.total_price) || 0)].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      if (!Array.isArray(o.room_parts)) o.room_parts = null;
      deduped.push(o);
      if (deduped.length >= limit) break;
    }

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

    // Orphan signal: package shows live-priced hotel_supplier but its
    // rate-offers cache is empty. UI uses it to show a "pricing settling"
    // notice instead of an empty grid.
    const pricingSettling = deduped.length === 0 && pkgRow?.hotel_supplier === "liteapi";

    return new Response(JSON.stringify({
      version: VERSION, package_id,
      count: deduped.length, offers: deduped,
      resort, catalog_rooms: catalogRooms,
      hotel_images: hotelImages,
      pricing_settling: pricingSettling,
      match_stats: matchStats,
    }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }), { status: 500, headers });
  }
});
