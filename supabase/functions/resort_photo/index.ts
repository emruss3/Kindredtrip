// Proxy to fetch a Google Places photo by photo_reference.
// Keeps the Google API key server-side. Returns the image bytes.
//
// Usage: GET /functions/v1/resort_photo?ref=ATxxxxx&w=480
// Responds with the image (status 200) or 404 if missing.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "GET, OPTIONS",
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders() });
  if (req.method !== "GET") return new Response("Use GET", { status: 405, headers: corsHeaders() });

  try {
    const url = new URL(req.url);
    const ref = url.searchParams.get("ref");
    const w = Math.min(parseInt(url.searchParams.get("w") ?? "480", 10), 1600);
    if (!ref) return new Response("missing ref", { status: 400, headers: corsHeaders() });

    const apiKey = Deno.env.get("GOOGLE_PLACES_API_KEY");
    if (!apiKey) return new Response("server not configured", { status: 500, headers: corsHeaders() });

    // Google's photo endpoint redirects to the actual image URL.
    // Fetch with redirect: 'follow' (default) and stream back the bytes.
    const u = new URL("https://maps.googleapis.com/maps/api/place/photo");
    u.searchParams.set("maxwidth", String(w));
    u.searchParams.set("photo_reference", ref);
    u.searchParams.set("key", apiKey);

    const r = await fetch(u.toString());
    if (!r.ok || !r.body) {
      return new Response("not found", { status: 404, headers: corsHeaders() });
    }

    return new Response(r.body, {
      status: 200,
      headers: {
        ...corsHeaders(),
        "content-type": r.headers.get("content-type") ?? "image/jpeg",
        // Browser: cache for 30 days. CDN (Vercel/Cloudflare/Supabase): cache for 30 days.
        // immutable: tell browser not to revalidate during freshness window.
        "cache-control": "public, max-age=2592000, s-maxage=2592000, immutable",
        // Vercel-specific override: same 30 days at the edge.
        "cdn-cache-control": "public, max-age=2592000",
      },
    });
  } catch (e) {
    return new Response(String((e as any)?.message ?? e), { status: 500, headers: corsHeaders() });
  }
});
