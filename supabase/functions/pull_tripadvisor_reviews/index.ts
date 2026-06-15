// pull_tripadvisor_reviews v1
//
// Goes direct to TripAdvisor Content API (NOT the LiteAPI relay) to pull
// the family-traveler review slice for resorts that have a known
// tripadvisor_location_id. Internal-signal-only — the reviews and
// sentiment never render to the user, so we don't trigger TripAdvisor's
// terms requirement to link back to TA's site. The output is a private
// signal fed into family_fit scoring.
//
// Why this is distinct from pull_resort_reviews (the LiteAPI puller):
//   - keyed on tripadvisor_location_id (the -d<digits>- id from the seed
//     spreadsheet), not liteapi_hotel_id
//   - reviews get source='tripadvisor_direct' so they're distinguishable
//     from the 14k LiteAPI-relayed reviews already tagged 'tripadvisor'
//   - sentiment lands in resort_tripadvisor_family_sentiment (one row
//     per resort) instead of resort_review_sentiment, to avoid clobbering
//     the LiteAPI-derived sentiment
//
// Endpoint shape (TripAdvisor Content API, partner v2.0):
//   GET /api/partner/2.0/location/{location_id}/reviews
//     ?key=<api_key>&limit=5&language=en
// Returns at most ~5 reviews per call by design, but the response also
// carries the aggregate stats (num_reviews, rating) and a
// trip_type-binned `subratings`/`review_rating_count`/`trip_type_count`
// — that's what feeds the family slice.
//
// POST body: {
//   max_resorts?: number (default 8),
//   depth?: number (internal, chained iteration counter),
// }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "pull_tripadvisor_reviews_v1";
const TA_BASE = "https://api.content.tripadvisor.com/api/v1";
const DEFAULT_MAX_RESORTS = 8;
const WALL_CLOCK_BUDGET_MS = 40_000;
const MAX_CHAIN_DEPTH = 200; // 832 jobs / 8 per call = ~104 chained calls
const PARALLEL = 2;

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

function findApiKey(): string | null {
  for (const n of ["TRIPADVISOR_API_KEY", "TRIPADVISOR_KEY", "TA_API_KEY", "TA_KEY", "TripAdvisor"]) {
    const v = Deno.env.get(n);
    if (v && v.length > 10) return v;
  }
  return null;
}

function shortHash(s: string): string {
  let h1 = 0xcbf29ce4, h2 = 0x84222325;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c & 0xff;
    h2 ^= (c >> 8) & 0xff;
    h1 = Math.imul(h1, 0x01000193);
    h2 = Math.imul(h2, 0x01000193);
  }
  const toHex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return toHex(h1) + toHex(h2);
}

function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// TA Content API returns reviews with `trip_type` ∈ {FAMILY, COUPLES,
// FRIENDS, SOLO, BUSINESS} and aggregate `trip_type_count` array.
// Normalize the per-review tag so the family slice is one bucket.
function normalizeTaTripType(raw: any): string {
  const t = String(raw ?? "").toLowerCase().trim();
  if (!t) return "unknown";
  if (t.includes("family") || t === "with_family") return "family";
  if (t.includes("couple")) return "couple";
  if (t.includes("friend")) return "friends";
  if (t.includes("solo")) return "solo";
  if (t.includes("business")) return "business";
  return "other";
}

async function fetchTaReviews(apiKey: string, locationId: string) {
  // limit=5 is the TA Content API maximum per call. We rely on the
  // aggregate trip_type_count for the family slice (it includes counts
  // across the FULL review corpus, not just the 5 returned here).
  const url = new URL(`${TA_BASE}/location/${locationId}/reviews`);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("limit", "5");
  url.searchParams.set("language", "en");
  try {
    const r = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json", Referer: "https://kindredtrips.com" },
    });
    if (r.status === 429) return { status: 429, rateLimited: true, body: null as any };
    if (!r.ok) {
      const t = await r.text();
      return { status: r.status, rateLimited: false, body: null as any, error: t.slice(0, 200) };
    }
    const body = await r.json();
    return { status: r.status, rateLimited: false, body };
  } catch (e) {
    return { status: 0, rateLimited: false, body: null as any, error: String((e as any)?.message ?? e) };
  }
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ version: VERSION, error: "POST only" }), { status: 405, headers });
  }

  const tStart = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const maxResorts = Number(body.max_resorts ?? DEFAULT_MAX_RESORTS);
    const depth = Number(body.depth ?? 0);

    const apiKey = findApiKey();
    if (!apiKey) {
      return new Response(JSON.stringify({
        version: VERSION,
        error: "TRIPADVISOR_API_KEY secret not set on this Supabase project. " +
               "Add via: supabase secrets set TRIPADVISOR_API_KEY=... or the dashboard.",
      }), { status: 503, headers });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    const { data: jobs, error: jErr } = await sb
      .from("tripadvisor_review_jobs")
      .select("resort_id, tripadvisor_location_id, attempts")
      .eq("status", "pending")
      .lt("attempts", 3)
      .order("updated_at", { ascending: true })
      .limit(maxResorts);
    if (jErr) throw jErr;

    if (!jobs || jobs.length === 0) {
      return new Response(JSON.stringify({
        version: VERSION, depth, processed: 0, done: true,
        message: "no pending TripAdvisor review jobs",
      }), { status: 200, headers });
    }

    await sb.from("tripadvisor_review_jobs")
      .update({ status: "fetching", updated_at: new Date().toISOString() })
      .in("resort_id", jobs.map(j => j.resort_id));

    let totalReviewsStored = 0;
    let totalFamilyReviewsStored = 0;
    let resortsDone = 0, resortsNoReviews = 0, resortsFailed = 0;
    let rateLimited = false;
    const errors: string[] = [];

    for (let i = 0; i < jobs.length; i += PARALLEL) {
      if (Date.now() - tStart > WALL_CLOCK_BUDGET_MS) break;
      if (rateLimited) break;

      const wave = jobs.slice(i, i + PARALLEL);
      const results = await Promise.all(wave.map(async (job) => {
        const res = await fetchTaReviews(apiKey, job.tripadvisor_location_id);
        return { job, res };
      }));

      for (const { job, res } of results) {
        if (res.rateLimited) {
          rateLimited = true;
          await sb.from("tripadvisor_review_jobs").update({
            status: "pending",
            attempts: (job.attempts ?? 0) + 1,
            last_error: "rate limited (429)",
            updated_at: new Date().toISOString(),
          }).eq("resort_id", job.resort_id);
          continue;
        }

        if (!res.body) {
          resortsFailed++;
          errors.push(`${job.tripadvisor_location_id}: ${(res as any).error ?? res.status}`);
          await sb.from("tripadvisor_review_jobs").update({
            status: "failed",
            attempts: (job.attempts ?? 0) + 1,
            last_error: `${res.status}: ${(res as any).error ?? "no body"}`,
            updated_at: new Date().toISOString(),
          }).eq("resort_id", job.resort_id);
          continue;
        }

        const payload = res.body;
        const reviews: any[] = Array.isArray(payload?.data) ? payload.data : [];

        // Per-review rows go into resort_reviews_raw with the new source tag
        let familyCountThisCall = 0;
        if (reviews.length > 0) {
          const rows = reviews.map((rv) => {
            const title = typeof rv?.title === "string" ? rv.title : "";
            const text = typeof rv?.text === "string" ? rv.text : "";
            const userName = rv?.user?.username ?? null;
            const date = rv?.published_date ?? null;
            const tripType = normalizeTaTripType(rv?.trip_type);
            if (tripType === "family") familyCountThisCall++;
            const dedupeBasis = [
              userName ?? "", date ?? "", title.slice(0, 80), text.slice(0, 180),
            ].join("|");
            return {
              resort_id: job.resort_id,
              liteapi_hotel_id: null,   // not relevant for TA-direct rows
              dedupe_key: shortHash("ta:" + dedupeBasis),
              average_score: num(rv?.rating),
              reviewer_name: userName,
              reviewer_country: rv?.user?.user_location?.name ?? null,
              traveler_type: rv?.trip_type ?? null,
              traveler_type_norm: tripType,
              review_date: date,
              headline: title || null,
              language: rv?.lang ?? "en",
              pros: text || null,
              cons: null,
              source: "tripadvisor_direct",
            };
          });
          const seen = new Set<string>();
          const uniqueRows = rows.filter(r => {
            if (seen.has(r.dedupe_key)) return false;
            seen.add(r.dedupe_key);
            return true;
          });
          const { error: insErr } = await sb
            .from("resort_reviews_raw")
            .upsert(uniqueRows, { onConflict: "resort_id,dedupe_key", ignoreDuplicates: true });
          if (insErr) {
            errors.push(`raw insert ${job.tripadvisor_location_id}: ${insErr.message}`);
          } else {
            totalReviewsStored += uniqueRows.length;
            totalFamilyReviewsStored += familyCountThisCall;
          }
        }

        // Resort-level aggregate sentiment derived from TA's response.
        // trip_type_count is the count of reviews across the FULL corpus
        // bucketed by trip_type — that's the canonical family slice.
        const totalReviewCount = num(payload?.num_reviews);
        const totalRating = num(payload?.rating);
        let familyCount: number | null = null;
        const ttc: any[] = Array.isArray(payload?.trip_type_count) ? payload.trip_type_count
                        : Array.isArray(payload?.tripTypeCount) ? payload.tripTypeCount : [];
        for (const t of ttc) {
          const name = String(t?.name ?? t?.trip_type ?? "").toLowerCase();
          if (name.includes("family")) {
            familyCount = num(t?.value ?? t?.count);
            break;
          }
        }
        if (totalReviewCount !== null || familyCount !== null) {
          const { error: sentErr } = await sb
            .from("resort_tripadvisor_family_sentiment")
            .upsert({
              resort_id: job.resort_id,
              tripadvisor_location_id: job.tripadvisor_location_id,
              total_review_count: totalReviewCount,
              total_avg_rating: totalRating,
              family_review_count: familyCount ?? 0,
              // family_avg_rating from the limited sample only — placeholder
              // until we make a second call with prefercontributorcountry
              // or trip_type=family. The aggregate count is the primary
              // signal we feed family_fit.
              family_avg_rating: null,
              refreshed_at: new Date().toISOString(),
            }, { onConflict: "resort_id" });
          if (sentErr) errors.push(`sentiment ${job.tripadvisor_location_id}: ${sentErr.message}`);
        }

        const updateRow: any = {
          updated_at: new Date().toISOString(),
          reviews_pulled: reviews.length,
          family_reviews_pulled: familyCountThisCall,
        };
        if (reviews.length === 0) {
          updateRow.status = "no_reviews";
          resortsNoReviews++;
        } else {
          updateRow.status = "done";
          resortsDone++;
        }
        await sb.from("tripadvisor_review_jobs").update(updateRow).eq("resort_id", job.resort_id);
      }
    }

    // Anything we marked 'fetching' but didn't process (wall-clock break)
    // gets returned to the pending queue for the chained call.
    await sb.from("tripadvisor_review_jobs")
      .update({ status: "pending", updated_at: new Date().toISOString() })
      .eq("status", "fetching");

    const { count: stillPending } = await sb.from("tripadvisor_review_jobs")
      .select("resort_id", { count: "exact", head: true })
      .eq("status", "pending")
      .lt("attempts", 3);

    let chained = false;
    if (!rateLimited && (stillPending ?? 0) > 0 && depth + 1 < MAX_CHAIN_DEPTH) {
      const p = fetch(`${supabaseUrl}/functions/v1/pull_tripadvisor_reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
        body: JSON.stringify({ max_resorts: maxResorts, depth: depth + 1 }),
      });
      const er = (globalThis as any).EdgeRuntime;
      if (er?.waitUntil) er.waitUntil(p.catch((e) => console.error("chain error:", e)));
      else p.catch((e) => console.error("chain error:", e));
      chained = true;
    }

    return new Response(JSON.stringify({
      version: VERSION,
      depth,
      elapsed_ms: Date.now() - tStart,
      jobs_claimed: jobs.length,
      resorts_done: resortsDone,
      resorts_no_reviews: resortsNoReviews,
      resorts_failed: resortsFailed,
      reviews_stored: totalReviewsStored,
      family_reviews_stored: totalFamilyReviewsStored,
      rate_limited: rateLimited,
      still_pending: stillPending,
      chained,
      errors: errors.slice(0, 5),
    }, null, 2), { status: 200, headers });

  } catch (e) {
    return new Response(JSON.stringify({
      version: VERSION, error: String((e as any)?.message ?? e),
    }), { status: 500, headers });
  }
});
