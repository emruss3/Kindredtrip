// Backfills photo references AND lat/lng for resorts using the Google
// Places API. v2 (2026-06-08) also captures geometry.location so we
// can drive LiteAPI matching (which is keyed on lat/lng) without a
// separate geocoding pass.
//
// Flow per resort:
//   1) Text search by "<resort_name>, <area>, <country>" with type=lodging
//   2) Take top result, fetch Place Details with fields=photos,geometry/location
//   3) Save place_id + photo_references[] + html_attributions[] + lat/lng
//
// Process in batches; auto-chain the next batch until done.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "backfill_resort_photos_v2_geo";

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

async function googleTextSearch(apiKey: string, query: string) {
  const u = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
  u.searchParams.set("query", query);
  u.searchParams.set("type", "lodging");
  u.searchParams.set("key", apiKey);
  const res = await fetch(u.toString());
  const json = await res.json();
  return json;
}

async function googlePlaceDetails(apiKey: string, placeId: string) {
  const u = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  u.searchParams.set("place_id", placeId);
  // v2: ask for geometry/location too. Both photos and geometry/location
  // are in the "Basic" SKU tier — same billable price as photos alone.
  u.searchParams.set("fields", "photos,geometry/location,name");
  u.searchParams.set("key", apiKey);
  const res = await fetch(u.toString());
  const json = await res.json();
  return json;
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ version: VERSION, error: "Use POST" }), { status: 405, headers });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const batchSize = Math.min(parseInt(body.batch_size ?? 25, 10), 50);
    const onlyMissing = body.only_missing !== false; // default true
    const familyOnly = body.family_only !== false;   // default true
    const autoChain = body.auto_chain !== false;     // default true

    const apiKey = Deno.env.get("GOOGLE_PLACES_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ version: VERSION, error: "Missing GOOGLE_PLACES_API_KEY secret" }), { status: 500, headers });
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    let q = sb
      .from("resorts")
      .select("resort_id, resort_name, country, area, photos_fetched_at")
      .order("resort_id", { ascending: true })
      .limit(batchSize);

    if (familyOnly) q = q.eq("audience", "Family");
    if (onlyMissing) q = q.is("photos_fetched_at", null);

    const { data: resorts, error: rErr } = await q;
    if (rErr) throw rErr;

    if (!resorts || resorts.length === 0) {
      return new Response(JSON.stringify({
        version: VERSION,
        message: "Nothing left to backfill",
        processed: 0,
      }), { status: 200, headers });
    }

    let succeeded = 0;
    let failed = 0;
    const failures: Array<{ resort_id: string; resort_name: string; reason: string }> = [];
    const nowIso = new Date().toISOString();

    for (const r of resorts) {
      try {
        const queryParts = [r.resort_name];
        if (r.area) queryParts.push(r.area);
        if (r.country) queryParts.push(r.country);
        const query = queryParts.filter(Boolean).join(" ");

        const search = await googleTextSearch(apiKey, query);
        if (search.status !== "OK" || !search.results?.length) {
          // Mark as fetched so we don't retry forever; leave place_id null
          await sb.from("resorts").update({ photos_fetched_at: nowIso }).eq("resort_id", r.resort_id);
          failed++;
          failures.push({ resort_id: r.resort_id, resort_name: r.resort_name, reason: `search ${search.status}` });
          continue;
        }
        const top = search.results[0];
        const placeId = top.place_id;

        const details = await googlePlaceDetails(apiKey, placeId);
        if (details.status !== "OK") {
          await sb.from("resorts").update({
            google_place_id: placeId,
            photos_fetched_at: nowIso,
          }).eq("resort_id", r.resort_id);
          failed++;
          failures.push({ resort_id: r.resort_id, resort_name: r.resort_name, reason: `details ${details.status}` });
          continue;
        }

        const photos = details.result?.photos ?? [];
        const photo_refs = photos.map((p: any) => p.photo_reference).filter(Boolean).slice(0, 8);
        const photo_attributions = photos.map((p: any) => (p.html_attributions ?? []).join(" | ")).slice(0, 8);
        // v2: capture lat/lng from geometry.location (or fall back to
        // the textsearch top result, which also includes it).
        const loc = details.result?.geometry?.location ?? top.geometry?.location ?? null;
        const lat = Number(loc?.lat);
        const lng = Number(loc?.lng);
        const hasGeo = Number.isFinite(lat) && Number.isFinite(lng);
        const resolvedName = details.result?.name ?? top.name ?? null;

        const patch: Record<string, unknown> = {
          google_place_id: placeId,
          photo_refs: photo_refs.length ? photo_refs : null,
          photo_attributions: photo_attributions.length ? photo_attributions : null,
          photos_fetched_at: nowIso,
        };
        if (hasGeo) {
          patch.latitude = lat;
          patch.longitude = lng;
        }
        if (resolvedName) {
          patch.google_place_resolved_name = resolvedName;
          patch.google_place_verified_at = nowIso;
          patch.google_place_verification_status = "auto_text_search";
        }
        await sb.from("resorts").update(patch).eq("resort_id", r.resort_id);

        succeeded++;
      } catch (e) {
        failed++;
        failures.push({ resort_id: r.resort_id, resort_name: r.resort_name, reason: String((e as any)?.message ?? e) });
      }
    }

    // Auto-chain the next batch
    let chained = false;
    if (autoChain && resorts.length === batchSize) {
      try {
        const p = fetch(`${supabaseUrl}/functions/v1/backfill_resort_photos`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
          },
          body: JSON.stringify({ batch_size: batchSize, only_missing: onlyMissing, family_only: familyOnly, auto_chain: true }),
        });
        // deno-lint-ignore no-explicit-any
        const er = (globalThis as any).EdgeRuntime;
        if (er && typeof er.waitUntil === "function") {
          er.waitUntil(p.catch((e) => console.error("[backfill_resort_photos] chain error:", e)));
        } else {
          p.catch((e) => console.error("[backfill_resort_photos] chain error:", e));
        }
        chained = true;
      } catch (e) {
        console.error("[backfill_resort_photos] failed to chain:", e);
      }
    }

    return new Response(JSON.stringify({
      version: VERSION,
      processed: resorts.length,
      succeeded,
      failed,
      chained,
      failures: failures.slice(0, 10),
    }), { status: 200, headers });

  } catch (e) {
    return new Response(JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }), { status: 500, headers });
  }
});
