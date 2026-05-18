// get_hotel_offers
//
// Returns the stored hotel_rate_offers for a single package_id, sorted by
// total_price ascending. Used by the detail-modal "Room options" section so
// users can see the actual room/board variants behind a result card instead
// of just a count.
//
// GET /functions/v1/get_hotel_offers?package_id=<uuid>&limit=10
// Body shape:
//   { package_id, offers: [{...trimmed columns...}], count, resort, catalog_rooms }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "get_hotel_offers_v3_group_key";
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 24;

// v3 (2026-05-19):
//   Server now computes the rate ↔ catalog-room join and emits a
//   group_key + match_path per offer:
//     - "mapped_id"  : LiteAPI mappedRoomId ↔ resort_rooms.room_id direct
//     - "fuzzy_name" : exact-normalize then Jaccard token-overlap
//     - "synthetic"  : no catalog match, keyed on rate's own room_name
//   group_key collapses rate variants belonging to the same room into one
//   card on the client. Clients should group strictly on this key — no
//   client-side name normalization.
//
// v2 (2026-05-18):
//   Surface the LiteAPI hotel-level content + the standalone room catalog
//   we backfilled into resorts (liteapi_*) and resort_rooms.

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

const ROOM_NAME_STOPWORDS = new Set([
  "with", "and", "the", "of", "a", "an", "for", "or",
  "guests", "guest", "bed", "beds", "size", "type", "no",
]);

function normalizeRoomName(name: string | null | undefined): string {
  if (!name) return "";
  let s = String(name);
  // Iterate until stable: trailing parens "(FMDPO)", trailing supplier
  // code after dash " - DXDGV", trailing comma + descriptor ", 1 King".
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(/\s*\([^()]*\)\s*$/, "");
    s = s.replace(/\s*[-–]\s*[A-Z0-9 ]{2,}\s*$/, "");
    s = s.replace(/\s*,[^,]*$/, "");
    if (s === before) break;
  }
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function tokenizeRoomName(name: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!name) return out;
  for (const w of String(name).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)) {
    if (w.length > 1 && !/^\d+$/.test(w) && !ROOM_NAME_STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

function roomNameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const A = tokenizeRoomName(a);
  const B = tokenizeRoomName(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

const FUZZY_MATCH_THRESHOLD = 0.5;

type CatalogRoom = {
  room_id: string;
  room_name: string | null;
  [k: string]: any;
};

function fuzzyCatalogMatch(rateName: string | null, rooms: CatalogRoom[]): CatalogRoom | null {
  if (!rateName || rooms.length === 0) return null;
  let best: CatalogRoom | null = null;
  let bestScore = 0;
  for (const c of rooms) {
    const s = roomNameSimilarity(rateName, c.room_name);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return bestScore >= FUZZY_MATCH_THRESHOLD ? best : null;
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

    // v3: include mapped_room_id on each rate offer so we can attempt the
    // id-based join. Will be NULL for the 330k legacy rows we've already
    // persisted; new rows from start_pricing v11 / top_up_hotels_worker v2
    // will carry it.
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

    // Build catalog lookups for the join: by room_id (mapped_id path) and
    // by normalized name (fuzzy_name path). Catalog room_id is text so
    // string-compare both sides.
    const catalogById = new Map<string, CatalogRoom>();
    const catalogByNorm = new Map<string, CatalogRoom>();
    for (const c of catalogRooms) {
      if (c.room_id != null) catalogById.set(String(c.room_id), c);
      const n = normalizeRoomName(c.room_name);
      if (n && !catalogByNorm.has(n)) catalogByNorm.set(n, c);
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

    // v3: compute group_key + match_path per offer. Precedence:
    //   1. mapped_room_id (string) lookup against resort_rooms.room_id
    //   2. exact-normalize, then Jaccard token overlap (≥ 0.5)
    //   3. synthetic — keyed on the rate's own normalized name
    // The client groups strictly on group_key and stamps match_path as a
    // data attribute for QA. Card content gracefully degrades when match
    // is "synthetic" (no catalog data attached).
    const matchStats: Record<string, number> = { mapped_id: 0, fuzzy_name: 0, synthetic: 0 };
    for (const o of deduped) {
      let matchedCatalog: CatalogRoom | null = null;
      let matchPath: "mapped_id" | "fuzzy_name" | "synthetic" = "synthetic";

      const mapped = o.mapped_room_id != null ? String(o.mapped_room_id) : null;
      if (mapped && catalogById.has(mapped)) {
        matchedCatalog = catalogById.get(mapped)!;
        matchPath = "mapped_id";
      } else {
        const exactKey = normalizeRoomName(o.room_name);
        const exact = exactKey ? catalogByNorm.get(exactKey) : null;
        if (exact) {
          matchedCatalog = exact;
          matchPath = "fuzzy_name";
        } else {
          const fuzzy = fuzzyCatalogMatch(o.room_name, catalogRooms);
          if (fuzzy) {
            matchedCatalog = fuzzy;
            matchPath = "fuzzy_name";
          }
        }
      }

      if (matchedCatalog) {
        o.group_key = `cat:${matchedCatalog.room_id}`;
        o.match_path = matchPath;
        o.matched_room_id = String(matchedCatalog.room_id);
      } else {
        const nk = normalizeRoomName(o.room_name);
        o.group_key = `synth:${nk || "unknown"}`;
        o.match_path = matchPath;
        o.matched_room_id = null;
      }
      matchStats[matchPath]++;
    }

    return new Response(JSON.stringify({
      version: VERSION,
      package_id,
      count: deduped.length,
      offers: deduped,
      resort,
      catalog_rooms: catalogRooms,
      match_stats: matchStats,  // {mapped_id, fuzzy_name, synthetic} for QA
    }), { status: 200, headers });

  } catch (e) {
    return new Response(JSON.stringify({
      version: VERSION,
      error: String((e as any)?.message ?? e),
    }), { status: 500, headers });
  }
});
