// get_resort_reviews
//
// Returns the family-signal summary (resort_family_signals) plus a page
// of raw reviews (resort_reviews_raw) for a single resort. Caller can
// pass resort_id directly OR a package_id (we'll resolve the resort).
//
// GET /functions/v1/get_resort_reviews?resort_id=<uuid>&limit=20
// GET /functions/v1/get_resort_reviews?package_id=<uuid>&limit=20
//
// Response:
//   {
//     version, resort_id,
//     signals: { total_reviews, family_review_count, family_avg_score,
//                family_score_delta, kids_club_signal, kids_club_mentions,
//                pool_signal, pool_mentions, beach_toddler_signal, ...
//                top_family_pros[], top_family_cons[], signal_confidence },
//     reviews: [ { review_id, average_score, reviewer_name,
//                  reviewer_country, traveler_type, traveler_type_norm,
//                  review_date, headline, language, pros, cons, source },
//                ... ]
//   }
//
// When the resort has no reviews loaded yet, both `signals` and `reviews`
// are null/[] — the client should render an empty state and skip the
// section. Reviews are ordered by review_date DESC.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "get_resort_reviews_v1";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

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
    let resort_id: string | null = null;
    let package_id: string | null = null;
    let limit = DEFAULT_LIMIT;

    if (req.method === "GET") {
      const url = new URL(req.url);
      resort_id = url.searchParams.get("resort_id");
      package_id = url.searchParams.get("package_id");
      const l = Number(url.searchParams.get("limit"));
      if (Number.isFinite(l) && l > 0) limit = Math.min(l, MAX_LIMIT);
    } else if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      resort_id = body.resort_id ?? null;
      package_id = body.package_id ?? null;
      const l = Number(body.limit);
      if (Number.isFinite(l) && l > 0) limit = Math.min(l, MAX_LIMIT);
    } else {
      return new Response(JSON.stringify({ version: VERSION, error: "Use GET or POST" }), { status: 405, headers });
    }

    if (!resort_id && !package_id) {
      return new Response(JSON.stringify({ version: VERSION, error: "resort_id or package_id required" }), { status: 400, headers });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    // Resolve resort_id from package_id when needed
    if (!resort_id && package_id) {
      const { data: pkg, error: pErr } = await sb
        .from("packages")
        .select("resort_id")
        .eq("package_id", package_id)
        .maybeSingle();
      if (pErr) throw pErr;
      if (!pkg?.resort_id) {
        return new Response(JSON.stringify({ version: VERSION, error: "package not found or has no resort_id" }), { status: 404, headers });
      }
      resort_id = pkg.resort_id;
    }

    // Parallel fetch — signals (single row) + reviews (page)
    const [signalsRes, reviewsRes] = await Promise.all([
      sb.from("resort_family_signals")
        .select(`
          resort_id, liteapi_hotel_id, total_reviews,
          family_review_count, family_avg_score, non_family_avg_score,
          family_score_delta,
          kids_club_signal, kids_club_mentions,
          pool_signal, pool_mentions,
          beach_toddler_signal, beach_toddler_mentions,
          connecting_room_signal, connecting_room_mentions,
          food_picky_signal, food_picky_mentions,
          noise_signal, noise_mentions,
          top_family_pros, top_family_cons,
          signal_confidence, computed_at
        `)
        .eq("resort_id", resort_id)
        .maybeSingle(),
      sb.from("resort_reviews_raw")
        .select(`
          review_id, average_score, reviewer_name, reviewer_country,
          traveler_type, traveler_type_norm, review_date, headline,
          language, pros, cons, source
        `)
        .eq("resort_id", resort_id)
        .order("review_date", { ascending: false, nullsFirst: false })
        .limit(limit),
    ]);

    if (signalsRes.error) throw signalsRes.error;
    if (reviewsRes.error) throw reviewsRes.error;

    return new Response(JSON.stringify({
      version: VERSION,
      resort_id,
      signals: signalsRes.data ?? null,
      reviews: reviewsRes.data ?? [],
      count: (reviewsRes.data ?? []).length,
    }), { status: 200, headers });
  } catch (e: any) {
    console.error("[get_resort_reviews]", e);
    return new Response(JSON.stringify({
      version: VERSION,
      error: e?.message || String(e),
    }), { status: 500, headers });
  }
});
