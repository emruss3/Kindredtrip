// verify_room_mapping
//
// One-shot diagnostic. Hits /hotels/rates with roomMapping:true for a single
// hotel and reports whether mappedRoomId is actually populated on the
// sandbox key. Cross-checks the returned ids against this hotel's
// resort_rooms.room_id values to confirm the join is real.
//
// GET /functions/v1/verify_room_mapping?hotel_id=lp3093a
//
// Returns JSON with:
//   - hotel_id, room_types_returned, rates_returned
//   - rates_with_mapped_id (count + percent)
//   - sample_mapped_ids (first 10)
//   - catalog_room_ids (from resort_rooms for this hotel)
//   - intersection_count (mapped ids ∩ catalog ids)
//   - sample_rates (offerId, name, boardName, mappedRoomId) — first 5
//
// Not user-facing; left in place after verification so we can re-run if
// LiteAPI behavior changes.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "verify_room_mapping_v1";
const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "GET, OPTIONS",
  };
}

function findApiKey(): string | null {
  for (const n of ["LiteAPI", "LITEAPI", "LITEAPI_SANDBOX_KEY", "LITEAPI_API_KEY"]) {
    const v = Deno.env.get(n);
    if (v && v.length > 10) return v;
  }
  return null;
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });

  try {
    const url = new URL(req.url);
    const hotelId = url.searchParams.get("hotel_id") || "lp3093a";
    const checkin = url.searchParams.get("checkin") || "2026-08-15";
    const checkout = url.searchParams.get("checkout") || "2026-08-22";
    const adults = Number(url.searchParams.get("adults") ?? "2");
    const childrenAgesParam = url.searchParams.get("children_ages") || "";
    const childrenAges = childrenAgesParam ? childrenAgesParam.split(",").map(s => Number(s.trim())).filter(n => Number.isFinite(n)) : [];

    const apiKey = findApiKey();
    if (!apiKey) throw new Error("LiteAPI key missing");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    // Fetch catalog room ids for this hotel for cross-check.
    const { data: resort } = await sb
      .from("resorts")
      .select("resort_id, resort_name")
      .eq("liteapi_hotel_id", hotelId)
      .maybeSingle();
    const { data: catalogRooms } = resort?.resort_id
      ? await sb.from("resort_rooms")
          .select("room_id, room_name")
          .eq("resort_id", resort.resort_id)
      : { data: [] as any[] };
    const catalogIdSet = new Set<string>();
    for (const c of (catalogRooms ?? [])) {
      if (c.room_id != null) catalogIdSet.add(String(c.room_id));
    }

    // Hit LiteAPI with the new flag.
    const apiResp = await fetch(`${LITEAPI_BASE}/hotels/rates`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        hotelIds: [hotelId],
        checkin, checkout,
        currency: "USD",
        guestNationality: "US",
        occupancies: [{ adults, children: childrenAges }],
        timeout: 8,
        roomMapping: true,
      }),
    });
    const apiStatus = apiResp.status;
    const apiBody = await apiResp.text();
    let parsed: any = null;
    try { parsed = JSON.parse(apiBody); } catch { /* */ }
    if (!apiResp.ok) {
      return new Response(JSON.stringify({
        version: VERSION, hotel_id: hotelId,
        api_status: apiStatus,
        api_error: apiBody.slice(0, 500),
      }, null, 2), { status: 200, headers });
    }

    const data = Array.isArray(parsed?.data) ? parsed.data : [];
    const hotel = data[0] || null;
    const roomTypes: any[] = Array.isArray(hotel?.roomTypes) ? hotel.roomTypes : [];

    let totalRates = 0;
    let ratesWithMapped = 0;
    const sampleMappedIds = new Set<string>();
    const sampleRates: any[] = [];
    const allMappedIds = new Set<string>();
    let wrapperMappedSeen = 0;

    for (const rt of roomTypes) {
      if (rt?.mappedRoomId != null) wrapperMappedSeen++;
      const rates: any[] = Array.isArray(rt?.rates) ? rt.rates : [];
      for (const rate of rates) {
        totalRates++;
        const m = rate?.mappedRoomId ?? rt?.mappedRoomId ?? null;
        if (m != null) {
          ratesWithMapped++;
          const ms = String(m);
          allMappedIds.add(ms);
          if (sampleMappedIds.size < 10) sampleMappedIds.add(ms);
        }
        if (sampleRates.length < 5) {
          sampleRates.push({
            offerId: rt?.offerId ?? null,
            roomTypeId: rt?.roomTypeId ?? null,
            wrapperMappedRoomId: rt?.mappedRoomId ?? null,
            rateMappedRoomId: rate?.mappedRoomId ?? null,
            name: rate?.name ?? null,
            boardName: rate?.boardName ?? null,
            rateId: rate?.rateId ?? null,
          });
        }
      }
    }

    let intersection = 0;
    const intersectionSamples: string[] = [];
    for (const m of allMappedIds) {
      if (catalogIdSet.has(m)) {
        intersection++;
        if (intersectionSamples.length < 5) intersectionSamples.push(m);
      }
    }

    return new Response(JSON.stringify({
      version: VERSION,
      hotel_id: hotelId,
      resort_name: resort?.resort_name ?? null,
      catalog_room_count: catalogIdSet.size,
      catalog_room_ids_sample: Array.from(catalogIdSet).slice(0, 10),
      room_types_returned: roomTypes.length,
      rates_returned: totalRates,
      rates_with_mapped_id: ratesWithMapped,
      rates_with_mapped_id_pct: totalRates > 0 ? Math.round((ratesWithMapped / totalRates) * 100) : 0,
      wrapper_level_mapped_seen: wrapperMappedSeen,
      distinct_mapped_ids: allMappedIds.size,
      sample_mapped_ids: Array.from(sampleMappedIds),
      intersection_with_catalog: intersection,
      intersection_samples: intersectionSamples,
      verdict: ratesWithMapped > 0 && intersection > 0
        ? "✓ roomMapping flag works AND ids join to resort_rooms"
        : ratesWithMapped > 0
          ? "⚠ roomMapping returned ids but they don't intersect resort_rooms"
          : "✗ roomMapping flag did not populate mappedRoomId on this hotel",
      sample_rates: sampleRates,
    }, null, 2), { status: 200, headers });

  } catch (e) {
    return new Response(JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }), { status: 500, headers });
  }
});
