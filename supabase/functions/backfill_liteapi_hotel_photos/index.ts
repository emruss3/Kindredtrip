// backfill_liteapi_hotel_photos
//
// One-shot / cron-able backfill of hotel-level photos from LiteAPI's
// /data/hotel?hotelId=X endpoint into resorts.liteapi_hotel_photos.
// Mirrors the photo-URL extraction in get_room_photos so the cached
// shape matches what the trip-detail UI already understands.
//
// POST /functions/v1/backfill_liteapi_hotel_photos
// Body (all optional):
//   {
//     limit?: number,              // max resorts to process (default 60)
//     resort_ids?: string[],       // only these resorts
//     refetch?: boolean,           // re-fetch even if already cached
//     stale_days?: number,         // refetch rows older than N days (default 90)
//     concurrency?: number,        // parallel in-flight LiteAPI calls (default 4)
//     per_resort_limit?: number    // max photos saved per resort (default 50)
//   }
//
// Response:
//   { version, processed, updated, errors[], skipped_unmatched,
//     skipped_unchanged, total_photos }
//
// Throttling: LiteAPI is generous on /data/hotel reads but we keep
// concurrency low (4) and pace inside batches to avoid sudden bursts.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "backfill_liteapi_hotel_photos_v2";
const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";
const DEFAULT_LIMIT = 60;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_STALE_DAYS = 90;
const DEFAULT_PER_RESORT_LIMIT = 50;
const DEFAULT_DELAY_MS = 150;
const RETRY_MAX = 2;
const RETRY_BACKOFF_BASE_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

function findApiKey(): string | null {
  for (const n of ["LiteAPI", "LITEAPI", "LITEAPI_SANDBOX_KEY", "LITEAPI_API_KEY"]) {
    const v = Deno.env.get(n);
    if (v && v.length > 10) return v;
  }
  return null;
}

// Defensive URL extraction — LiteAPI's photo payload comes in a few
// shapes across hotels. Mirrors get_room_photos' extractPhotoUrls.
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

async function fetchHotelPhotos(
  hotelId: string,
  apiKey: string,
  perResortLimit: number,
): Promise<{ photos: string[]; upstream_status: number; error: string | null }> {
  const url = `${LITEAPI_BASE}/data/hotel?hotelId=${encodeURIComponent(hotelId)}`;
  // LiteAPI returns 429-like 4290 in body or an HTTP 429. Retry with
  // exponential backoff so a transient spike doesn't permanently mark
  // a resort as fetched-with-no-photos.
  for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
    try {
      const r = await fetch(url, {
        method: "GET",
        headers: { "X-API-Key": apiKey, Accept: "application/json" },
      });
      // LiteAPI sometimes returns HTTP 200 with an error object in body.
      const bodyText = await r.text();
      let parsed: any = {};
      try { parsed = JSON.parse(bodyText); } catch { /* keep raw text */ }
      const liteapiErrCode = parsed?.error?.code;
      const isRateLimited = r.status === 429
        || liteapiErrCode === 4290
        || /too many requests/i.test(bodyText);
      if (isRateLimited && attempt < RETRY_MAX) {
        await sleep(RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt));
        continue;
      }
      if (!r.ok) {
        return { photos: [], upstream_status: r.status, error: bodyText.slice(0, 200) || `HTTP ${r.status}` };
      }
      if (liteapiErrCode) {
        return { photos: [], upstream_status: r.status, error: bodyText.slice(0, 200) };
      }
      const data = parsed?.data ?? parsed;
      const seen = new Set<string>();
      const merged: string[] = [];
      for (const src of [data?.hotelImages, data?.images, data?.photos, data?.image_urls]) {
        for (const u of extractPhotoUrls(src)) {
          if (typeof u !== "string") continue;
          const trimmed = u.trim();
          if (!trimmed || seen.has(trimmed)) continue;
          seen.add(trimmed);
          merged.push(trimmed);
          if (merged.length >= perResortLimit) break;
        }
        if (merged.length >= perResortLimit) break;
      }
      return { photos: merged, upstream_status: r.status, error: null };
    } catch (e) {
      if (attempt < RETRY_MAX) {
        await sleep(RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt));
        continue;
      }
      return { photos: [], upstream_status: 0, error: String((e as any)?.message ?? e).slice(0, 200) };
    }
  }
  return { photos: [], upstream_status: 0, error: "exhausted retries" };
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  if (req.method !== "POST")
    return new Response(JSON.stringify({ version: VERSION, error: "Use POST" }), {
      status: 405,
      headers,
    });

  try {
    const body = await req.json().catch(() => ({}));
    const limit = Math.min(Math.max(Number(body.limit) || DEFAULT_LIMIT, 1), 600);
    const resortIds: string[] | null = Array.isArray(body.resort_ids) ? body.resort_ids : null;
    const refetch = !!body.refetch;
    const staleDays = Math.max(Number(body.stale_days) || DEFAULT_STALE_DAYS, 1);
    const concurrency = Math.min(Math.max(Number(body.concurrency) || DEFAULT_CONCURRENCY, 1), 12);
    const perResortLimit = Math.min(
      Math.max(Number(body.per_resort_limit) || DEFAULT_PER_RESORT_LIMIT, 1),
      120,
    );
    const delayMs = Math.min(Math.max(Number(body.delay_ms) ?? DEFAULT_DELAY_MS, 0), 2000);
    // Also re-process rows we already touched but failed on (typically
    // the 4290 rate-limited rows) when the caller asks for it.
    const retryErrors = !!body.retry_errors;

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const apiKey = findApiKey();
    if (!supabaseUrl || !serviceRoleKey)
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    if (!apiKey) throw new Error("LiteAPI key missing");

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Candidate set: LiteAPI-matched resorts. Without refetch, we skip
    // anything already populated and not stale. Order: never-fetched
    // first, then oldest fetched.
    let q = supabase
      .from("resorts")
      .select("resort_id,liteapi_hotel_id,liteapi_hotel_photos_fetched_at")
      .eq("liteapi_match_status", "matched")
      .not("liteapi_hotel_id", "is", null);
    if (resortIds && resortIds.length) q = q.in("resort_id", resortIds);
    if (!refetch) {
      const staleCutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();
      // Postgrest "or": never fetched (null) OR fetched before cutoff.
      // When retry_errors=true, ALSO pick up rows that were touched but
      // never landed photos (typically rate-limited on the prior run).
      const ors = [
        "liteapi_hotel_photos_fetched_at.is.null",
        `liteapi_hotel_photos_fetched_at.lt.${staleCutoff}`,
        ...(retryErrors ? ["and(liteapi_hotel_photos.is.null,liteapi_hotel_photos_error.not.is.null)"] : []),
      ];
      q = q.or(ors.join(","));
    }
    const { data: candidates, error: cErr } = await q
      .order("liteapi_hotel_photos_fetched_at", { ascending: true, nullsFirst: true })
      .limit(limit);
    if (cErr) throw cErr;

    let updated = 0;
    let totalPhotos = 0;
    let skippedUnmatched = 0;
    const errors: { resort_id: string; error: string }[] = [];

    // Pull liteapi_hotel_id required — anything else surfaced as
    // skipped_unmatched (shouldn't happen given the filter).
    const work = (candidates ?? []).filter((r) => {
      if (!r.liteapi_hotel_id) { skippedUnmatched++; return false; }
      return true;
    });

    // Bounded concurrency pool — n parallel fetches at a time.
    let cursor = 0;
    async function worker() {
      while (true) {
        const idx = cursor++;
        if (idx >= work.length) return;
        const r = work[idx];
        const res = await fetchHotelPhotos(r.liteapi_hotel_id!, apiKey!, perResortLimit);
        const nowIso = new Date().toISOString();
        const patch: Record<string, unknown> = {
          liteapi_hotel_photos_fetched_at: nowIso,
          liteapi_hotel_photos_error: res.error,
        };
        if (res.photos.length > 0) {
          patch.liteapi_hotel_photos = res.photos;
          totalPhotos += res.photos.length;
          updated++;
        }
        const { error: upErr } = await supabase
          .from("resorts")
          .update(patch)
          .eq("resort_id", r.resort_id);
        if (upErr) errors.push({ resort_id: r.resort_id, error: String(upErr.message ?? upErr).slice(0, 200) });
        else if (res.error) errors.push({ resort_id: r.resort_id, error: res.error });
        if (delayMs > 0 && cursor < work.length) await sleep(delayMs);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    return new Response(
      JSON.stringify({
        version: VERSION,
        processed: work.length,
        updated,
        total_photos: totalPhotos,
        skipped_unmatched: skippedUnmatched,
        errors,
      }),
      { headers },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ version: VERSION, error: msg }),
      { status: 500, headers },
    );
  }
});
