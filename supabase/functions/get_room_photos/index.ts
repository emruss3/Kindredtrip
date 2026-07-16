// get_room_photos
//
// Fetches LiteAPI's hotel detail endpoint to extract per-room photos
// AND descriptive details (description, amenities, bed types, room
// size, occupancy split). Returns two maps keyed by roomTypeId so the
// trip-detail "Room options" UI can show an expanded panel with
// pictures + information.
//
// GET /functions/v1/get_room_photos?hotel_id=lp1234abc
// Response shape:
//   {
//     hotel_id: "lp1234abc",
//     hotel_photos: ["url1", "url2", ...],     // hotel-level fallback
//     room_photos: { "roomTypeId": ["url1", ...], ... },
//     room_details: {
//       "roomTypeId": {
//         description: "...",
//         amenities: ["Wi-Fi", "Mini bar", ...],
//         beds: [{ type: "King", quantity: 1 }, ...],
//         bed_summary: "1 King bed",       // human-friendly
//         size: { value: 28, unit: "sqm" } | null,
//         max_occupancy: 4,
//         max_adults: 2,
//         max_children: 2,
//         view: "Ocean view" | null
//       }, ...
//     },
//     count: 12
//   }
//
// LiteAPI's response shape from /data/hotel?hotelId=X varies; we
// defensively probe both top-level fields and roomTypes/rooms.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const VERSION = "get_room_photos_v2";
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

// Pull a human-readable list of amenity names from whatever shape
// LiteAPI gives us (strings, {name}, {amenity}, {label}).
function extractAmenityNames(maybe: any): string[] {
  if (!Array.isArray(maybe)) return [];
  const out: string[] = [];
  for (const a of maybe) {
    if (!a) continue;
    if (typeof a === "string") out.push(a);
    else if (typeof a === "object") {
      const n = a.name || a.amenity || a.label || a.title || a.type;
      if (typeof n === "string") out.push(n);
    }
  }
  // Dedupe + tidy
  return Array.from(new Set(out.map(s => s.trim()).filter(Boolean))).slice(0, 30);
}

// LiteAPI's bedTypes is usually an array of { quantity, bedType: "King" }.
// Normalize and produce a short summary like "1 King + 1 Sofa bed".
function extractBeds(rt: any): { beds: any[]; bed_summary: string | null } {
  const candidates = rt?.bedTypes ?? rt?.beds ?? rt?.bed_types ?? null;
  if (!Array.isArray(candidates) || candidates.length === 0) return { beds: [], bed_summary: null };
  const beds: any[] = [];
  for (const b of candidates) {
    if (!b) continue;
    if (typeof b === "string") { beds.push({ type: b, quantity: 1 }); continue; }
    const type = b.bedType || b.type || b.name || b.label;
    const quantity = Number(b.quantity ?? b.count ?? b.qty ?? 1) || 1;
    if (type) beds.push({ type: String(type), quantity });
  }
  if (beds.length === 0) return { beds: [], bed_summary: null };
  const summary = beds
    .map(b => `${b.quantity > 1 ? `${b.quantity} ` : ""}${b.type}${b.quantity > 1 ? "s" : ""}`)
    .join(" + ");
  return { beds, bed_summary: summary };
}

// Pick the first non-trivial description-like field.
function extractDescription(rt: any): string | null {
  for (const k of ["description", "shortDescription", "longDescription", "summary", "details"]) {
    const v = rt?.[k];
    if (typeof v === "string" && v.trim().length >= 20) return v.trim().slice(0, 1500);
  }
  return null;
}

function extractSize(rt: any): { value: number; unit: string } | null {
  // Common shapes: roomSize: { value: 28, unit: "sqm" }, sizeInfo, size: 28
  const cand = rt?.roomSize ?? rt?.sizeInfo ?? rt?.size ?? null;
  if (!cand) return null;
  if (typeof cand === "number" && Number.isFinite(cand)) return { value: cand, unit: "sqm" };
  if (typeof cand === "object") {
    const v = Number(cand.value ?? cand.size ?? cand.amount);
    const u = cand.unit || cand.measurement || "sqm";
    if (Number.isFinite(v) && v > 0) return { value: v, unit: String(u) };
  }
  return null;
}

function extractView(rt: any): string | null {
  // Sometimes a "view" attribute, sometimes baked into the name.
  if (typeof rt?.view === "string" && rt.view.trim()) return rt.view.trim();
  const nm = rt?.roomName || rt?.name || "";
  const m = String(nm).match(/(ocean|sea|garden|pool|mountain|city|partial|courtyard|beachfront|sunset|lagoon) view/i);
  return m ? m[0].replace(/^./, c => c.toUpperCase()) : null;
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
        room_photos: {}, room_details: {}, hotel_photos: [], count: 0,
        upstream_status: r.status, upstream_error: t.slice(0, 200),
      }), { status: 200, headers });
    }
    const body = await r.json();
    const data = body?.data ?? body;

    const hotelPhotos = Array.from(new Set([
      ...extractPhotoUrls(data?.hotelImages),
      ...extractPhotoUrls(data?.images),
      ...extractPhotoUrls(data?.photos),
      ...extractPhotoUrls(data?.image_urls),
    ])).slice(0, 24);

    const roomPhotos: Record<string, string[]> = {};
    const roomDetails: Record<string, any> = {};
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

      const { beds, bed_summary } = extractBeds(rt);
      roomDetails[id] = {
        description: extractDescription(rt),
        amenities: extractAmenityNames(rt.amenities ?? rt.amenitiesData ?? rt.roomAmenities),
        beds, bed_summary,
        size: extractSize(rt),
        max_occupancy: Number(rt.maxOccupancy ?? rt.max_occupancy) || null,
        max_adults: Number(rt.maxAdults ?? rt.max_adults) || null,
        max_children: Number(rt.maxChildren ?? rt.max_children) || null,
        view: extractView(rt),
      };
    }

    const count = Object.values(roomPhotos).reduce((n, arr) => n + arr.length, 0);

    return new Response(JSON.stringify({
      version: VERSION,
      hotel_id: hotelId,
      hotel_photos: hotelPhotos,
      room_photos: roomPhotos,
      room_details: roomDetails,
      count,
    }), { status: 200, headers });

  } catch (e) {
    return new Response(JSON.stringify({
      version: VERSION, error: String((e as any)?.message ?? e),
    }), { status: 500, headers });
  }
});
