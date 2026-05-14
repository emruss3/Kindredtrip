// get_room_photos
//
// Fetches LiteAPI's hotel detail endpoint to extract room-level
// photo URLs. Returns a map of roomTypeId -> [photo URLs] so the
// frontend's room option cards can show actual room images instead
// of rotating the resort's generic photos.
//
// GET /functions/v1/get_room_photos?hotel_id=lp1234abc
// Response shape:
//   {
//     hotel_id: "lp1234abc",
//     hotel_photos: ["url1", "url2", ...],     // hotel-level fallback
//     room_photos: { "roomTypeId": ["url1", ...], ... },
//     count: 12
//   }
//
// LiteAPI's response shape from /data/hotel?hotelId=X varies; we
// defensively probe both top-level fields and roomTypes/rooms.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const VERSION = "get_room_photos_v1";
const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

function findApiKey(): string | null {
  for (const n of ["LiteAPI", "LITEAPI", "LITEAPI_SANDBOX_KEY", "LITEAPI_API_KEY"]) {
    const v = Deno.env.get(n);
    if (v && v.length > 10) return v;
  }
  return null;
}

// LiteAPI's hotel detail responses use a mix of field shapes between
// the sandbox and live envs. This walks common candidates and pulls
// the first array of strings/objects-with-url it finds.
function extractPhotoUrls(maybe: any): string[] {
  if (!maybe) return [];
  if (typeof maybe === "string") return [maybe];
  if (!Array.isArray(maybe)) return [];
  const out: string[] = [];
  for (const item of maybe) {
    if (!item) continue;
    if (typeof item === "string") out.push(item);
    else if (typeof item === "object") {
      const u = item.url || item.uri || item.href || item.link || item.image || item.src;
      if (typeof u === "string") out.push(u);
    }
  }
  return out;
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });

  try {
    let hotelId: string | null = null;
    if (req.method === "GET") {
      hotelId = new URL(req.url).searchParams.get("hotel_id");
    } else if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      hotelId = body.hotel_id ?? null;
    } else {
      return new Response(JSON.stringify({ version: VERSION, error: "Use GET or POST" }), { status: 405, headers });
    }
    if (!hotelId) {
      return new Response(JSON.stringify({ version: VERSION, error: "hotel_id required" }), { status: 400, headers });
    }

    const apiKey = findApiKey();
    if (!apiKey) throw new Error("LiteAPI key missing");

    const url = `${LITEAPI_BASE}/data/hotel?hotelId=${encodeURIComponent(hotelId)}`;
    const r = await fetch(url, {
      method: "GET",
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
    });
    if (!r.ok) {
      const t = await r.text();
      return new Response(JSON.stringify({
        version: VERSION, hotel_id: hotelId,
        room_photos: {}, hotel_photos: [], count: 0,
        upstream_status: r.status, upstream_error: t.slice(0, 200),
      }), { status: 200, headers });
    }
    const body = await r.json();
    const data = body?.data ?? body;

    // Hotel-level photos (defensive — try several common keys).
    const hotelPhotos = Array.from(new Set([
      ...extractPhotoUrls(data?.hotelImages),
      ...extractPhotoUrls(data?.images),
      ...extractPhotoUrls(data?.photos),
      ...extractPhotoUrls(data?.image_urls),
    ])).slice(0, 24);

    // Room-level photos. Try both "rooms" and "roomTypes" arrays;
    // each item can have id/roomTypeId and images/photos/roomImages.
    const roomPhotos: Record<string, string[]> = {};
    const roomArrays: any[] = [];
    if (Array.isArray(data?.rooms)) roomArrays.push(...data.rooms);
    if (Array.isArray(data?.roomTypes)) roomArrays.push(...data.roomTypes);
    for (const rt of roomArrays) {
      if (!rt) continue;
      const id = String(rt.id ?? rt.roomTypeId ?? rt.room_type_id ?? "");
      if (!id) continue;
      const photos = Array.from(new Set([
        ...extractPhotoUrls(rt.images),
        ...extractPhotoUrls(rt.photos),
        ...extractPhotoUrls(rt.roomImages),
      ])).slice(0, 8);
      if (photos.length) roomPhotos[id] = photos;
    }

    const count = Object.values(roomPhotos).reduce((n, arr) => n + arr.length, 0);

    return new Response(JSON.stringify({
      version: VERSION,
      hotel_id: hotelId,
      hotel_photos: hotelPhotos,
      room_photos: roomPhotos,
      count,
    }), { status: 200, headers });

  } catch (e) {
    return new Response(JSON.stringify({
      version: VERSION, error: String((e as any)?.message ?? e),
    }), { status: 500, headers });
  }
});
