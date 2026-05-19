// top_up_hotels_worker
//
// Background worker that upgrades the remaining mock-priced packages for
// a search to live liteapi pricing. start_pricing has a tight ~22s
// wall-clock budget (so it returns fast and the user can start seeing
// cards). For large searches (~600 packages), it usually leaves ~100-200
// packages still on hotel_supplier='mock' because the LiteAPI loop hit
// the budget. This worker picks up those leftovers in a fresh edge
// worker (which gets its own 50s wall-clock), processes a batch, and
// chains itself if more remain.
//
// POST /functions/v1/top_up_hotels_worker  body: { search_id, max_pkgs?, depth? }
//
// We persist hotel_rate_offers and update package pricing exactly the
// same way start_pricing does — same scoring, same offer extraction.
// This is intentionally a copy of the inner loop; sharing code across
// edge functions adds deploy/import complexity for not much win.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "top_up_hotels_worker_v3_room_mapping_flag";
const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";
const HOTEL_BATCH_SIZE = 25;
const HOTEL_BATCH_CONCURRENCY = 2;
const MAX_OFFERS_PER_PACKAGE = 12;
const LITEAPI_TIMEOUT_S = 3;
const WALL_CLOCK_BUDGET_MS = 35_000;  // longer than start_pricing — we have a full edge wall-clock
const OFFER_WRITE_BUDGET_MS = 10_000;
const DEFAULT_MAX_PKGS = 200;
const MAX_CHAIN_DEPTH = 6;

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

function parseChildAges(raw: any): number[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map(Number).filter(n => Number.isFinite(n));
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t || t === "{}" || t === "[]") return [];
    try { const j = JSON.parse(t); if (Array.isArray(j)) return j.map(Number).filter(n => Number.isFinite(n)); } catch { /* */ }
    const inner = t.replace(/^\{|\}$/g, "");
    if (!inner) return [];
    return inner.split(",").map(s => Number(s.trim())).filter(n => Number.isFinite(n));
  }
  return [];
}

function nightsBetween(a: string, b: string): number {
  return Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000));
}

function extractRateOffers(hotel: any, hotelId: string, nights: number): any[] {
  const out: any[] = [];
  const roomTypes: any[] = Array.isArray(hotel?.roomTypes) ? hotel.roomTypes : [];
  for (const rt of roomTypes) {
    const liteOfferId = String(rt?.offerId ?? "");
    if (!liteOfferId) continue;
    const paymentTypes: string[] = Array.isArray(rt?.paymentTypes) ? rt.paymentTypes : [];
    const supplier = rt?.supplier ?? null;
    const roomTypeId = rt?.roomTypeId ?? null;
    // mappedRoomId is the documented crosswalk to /data/hotel rooms[].id.
    // Per LiteAPI it can sit on the roomType wrapper; per-rate is preferred
    // when present (see rate loop below) since rates within a roomType
    // can occasionally map to different content rooms.
    const wrapperMappedRoomId = rt?.mappedRoomId ?? null;
    const priceType = rt?.priceType ?? null;
    const rateType = rt?.rateType ?? null;
    const rates: any[] = Array.isArray(rt?.rates) ? rt.rates : [];
    for (const rate of rates) {
      const total = Number(rate?.retailRate?.total?.[0]?.amount ?? 0);
      if (!total) continue;
      const ssp = Number(rate?.retailRate?.suggestedSellingPrice?.[0]?.amount ?? NaN);
      const init = Number(rate?.retailRate?.initialPrice?.[0]?.amount ?? NaN);
      const commAmt = Number(rate?.commission?.[0]?.amount ?? NaN);
      const currency = String(rate?.retailRate?.total?.[0]?.currency ?? "USD");
      const boardType = String(rate?.boardType ?? "").toUpperCase() || null;
      const boardName = rate?.boardName ?? null;
      const isAI = boardType === "AI" || (boardName && /all\s+inclusive/i.test(String(boardName)));
      const refundableTag = rate?.cancellationPolicies?.refundableTag ?? null;
      const refundable = refundableTag === "RFN" ? true : (refundableTag === "NRFN" ? false : null);
      const policies: any[] = Array.isArray(rate?.cancellationPolicies?.cancelPolicyInfos) ? rate.cancellationPolicies.cancelPolicyInfos : [];
      const firstPolicy = policies[0] ?? null;
      const perks: string[] = Array.isArray(rate?.perks)
        ? rate.perks.map((p: any) => typeof p === "string" ? p : (p?.name ?? p?.label ?? null)).filter(Boolean)
        : [];
      const promos = rate?.promotions;
      const hasPromotions = promos != null && (Array.isArray(promos) ? promos.length > 0 : Boolean(promos));
      const rateId = String(rate?.rateId ?? "r0");
      const offerId = `${hotelId}_${shortHash(liteOfferId + "|" + rateId)}`;
      // Prefer the per-rate mappedRoomId, fall back to the roomType
      // wrapper. Coerce to string so a numeric LiteAPI id still joins
      // cleanly against resort_rooms.room_id (text).
      const mappedRoomIdRaw = rate?.mappedRoomId ?? wrapperMappedRoomId ?? null;
      const mappedRoomId = mappedRoomIdRaw != null ? String(mappedRoomIdRaw) : null;
      const trimmedRaw = {
        _liteapi_offer_id: liteOfferId,
        _liteapi_room_type_id: roomTypeId,
        _liteapi_rate_id: rateId,
        _liteapi_mapped_room_id: mappedRoomId,
        board_type: boardType,
        board_name: boardName,
        refundable_tag: refundableTag,
      };
      out.push({
        offer_id: offerId,
        room_type_id: roomTypeId,
        mapped_room_id: mappedRoomId,
        room_name: rate?.name ?? null,
        rate_id: rateId,
        max_occupancy: rate?.maxOccupancy ?? null,
        adult_count: rate?.adultCount ?? null,
        child_count: rate?.childCount ?? null,
        children_ages: Array.isArray(rate?.childrenAges) ? rate.childrenAges : [],
        total_price: total,
        per_night: nights > 0 ? Number((total / nights).toFixed(2)) : null,
        currency,
        suggested_selling_price: Number.isFinite(ssp) ? ssp : null,
        initial_price: Number.isFinite(init) ? init : null,
        commission_amount: Number.isFinite(commAmt) ? commAmt : null,
        commission_pct: Number.isFinite(commAmt) && total > 0 ? Number(((commAmt / total) * 100).toFixed(2)) : null,
        board_type: boardType,
        board_name: boardName,
        is_all_inclusive: Boolean(isAI),
        refundable,
        refundable_tag: refundableTag,
        cancellation_deadline: firstPolicy?.cancelTime ?? null,
        cancellation_penalty: firstPolicy?.amount != null ? Number(firstPolicy.amount) : null,
        payment_types: paymentTypes,
        supplier,
        price_type: priceType,
        rate_type: rateType,
        perks,
        has_promotions: hasPromotions,
        remarks: rate?.remarks || null,
        raw_offer: trimmedRaw,
      });
    }
  }
  const seen = new Set<string>();
  const deduped: any[] = [];
  out.sort((a, b) => a.total_price - b.total_price);
  for (const o of out) {
    const key = `${o.room_name ?? ""}|${o.board_type ?? ""}|${o.refundable ?? ""}|${o.total_price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(o);
  }
  return deduped;
}

async function fetchHotelRatesBatch(
  apiKey: string, hotelIds: string[], checkin: string, checkout: string,
  occupancies: Array<{ adults: number; children: number[] }>,
): Promise<{ hotels: any[]; status: number; error?: string }> {
  try {
    const r = await fetch(`${LITEAPI_BASE}/hotels/rates`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        hotelIds, checkin, checkout, currency: "USD", guestNationality: "US", occupancies,
        timeout: LITEAPI_TIMEOUT_S,
        roomMapping: true,
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      return { hotels: [], status: r.status, error: t.slice(0, 200) };
    }
    const body = await r.json();
    return { hotels: Array.isArray(body?.data) ? body.data : [], status: r.status };
  } catch (e) {
    return { hotels: [], status: 0, error: String((e as any)?.message ?? e) };
  }
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ version: VERSION, error: "POST only" }), { status: 405, headers });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const search_id = String(body.search_id ?? "");
    const max_pkgs = Number(body.max_pkgs ?? DEFAULT_MAX_PKGS);
    const depth = Number(body.depth ?? 0);
    if (!search_id) return new Response(JSON.stringify({ version: VERSION, error: "search_id required" }), { status: 400, headers });

    const apiKey = findApiKey();
    if (!apiKey) throw new Error("LiteAPI key missing");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    const { data: search, error: sErr } = await sb.from("searches")
      .select("*").eq("search_id", search_id).maybeSingle();
    if (sErr) throw sErr;
    if (!search) return new Response(JSON.stringify({ version: VERSION, error: "search not found" }), { status: 404, headers });

    const adults = Number(search.adults ?? 2);
    const childAges = parseChildAges(search.child_ages);
    const olderChildAges = childAges.filter(a => a >= 2);
    const nights = nightsBetween(search.date_start, search.date_end);

    // Fetch mock-priced packages that DO have a liteapi_hotel_id we can use.
    const { data: pkgs, error: pErr } = await sb.from("packages")
      .select(`
        package_id, search_id, resort_id,
        resorts ( liteapi_hotel_id )
      `)
      .eq("search_id", search_id)
      .eq("hotel_supplier", "mock")
      .limit(max_pkgs);
    if (pErr) throw pErr;

    const targetPkgs = (pkgs ?? []).filter((p: any) => p.resorts?.liteapi_hotel_id);

    if (targetPkgs.length === 0) {
      return new Response(JSON.stringify({
        version: VERSION, search_id, processed: 0, done: true, depth,
      }), { status: 200, headers });
    }

    const idToPackages = new Map<string, any[]>();
    for (const p of targetPkgs) {
      const id = (p as any).resorts.liteapi_hotel_id;
      if (!idToPackages.has(id)) idToPackages.set(id, []);
      idToPackages.get(id)!.push(p);
    }
    const liteapiHotelIds = Array.from(idToPackages.keys());

    const hotelDataById = new Map<string, any>();
    const hotelOccupancies = [{ adults, children: olderChildAges }];

    let batchesAttempted = 0, batchesSucceeded = 0;
    let lastError: string | undefined;
    let wallTimeBudgetHit = false;
    let rateLimitHit = false;

    const loopStart = Date.now();
    const allBatches: string[][] = [];
    for (let i = 0; i < liteapiHotelIds.length; i += HOTEL_BATCH_SIZE) {
      allBatches.push(liteapiHotelIds.slice(i, i + HOTEL_BATCH_SIZE));
    }

    for (let w = 0; w < allBatches.length; w += HOTEL_BATCH_CONCURRENCY) {
      if (Date.now() - loopStart > WALL_CLOCK_BUDGET_MS) {
        wallTimeBudgetHit = true;
        break;
      }
      const wave = allBatches.slice(w, w + HOTEL_BATCH_CONCURRENCY);
      batchesAttempted += wave.length;
      const results = await Promise.all(
        wave.map((batch) =>
          fetchHotelRatesBatch(apiKey, batch, search.date_start, search.date_end, hotelOccupancies)
        )
      );
      let hit429 = false;
      for (const res of results) {
        if (res.error) {
          lastError = res.error;
          if (res.status === 429) hit429 = true;
        } else {
          batchesSucceeded++;
          for (const h of res.hotels) {
            const id = String(h?.hotelId ?? "");
            if (id) hotelDataById.set(id, h);
          }
        }
      }
      if (hit429) { rateLimitHit = true; break; }
    }

    const nowIso = new Date().toISOString();
    const packageUpdates: any[] = [];
    const rateOfferRows: any[] = [];
    let upgraded = 0;

    for (const [hotelId, pkgsForHotel] of idToPackages.entries()) {
      const hotelData = hotelDataById.get(hotelId);
      if (!hotelData) continue;
      const offers = extractRateOffers(hotelData, hotelId, nights);
      if (offers.length === 0) continue;

      offers.sort((a, b) => a.total_price - b.total_price);
      const aiOffers = offers.filter(o => o.is_all_inclusive);
      const refOffers = offers.filter(o => o.refundable === true);
      const cheapestAiOfferId = aiOffers[0]?.offer_id ?? null;
      const cheapestAiTotal = aiOffers[0]?.total_price ?? null;
      const cheapestRefOfferId = refOffers[0]?.offer_id ?? null;
      const cheapestRefTotal = refOffers[0]?.total_price ?? null;
      const hasAnyAi = aiOffers.length > 0;
      const hasAnyRefundable = refOffers.length > 0;
      const maxOfferOcc = offers.reduce((m, o) => Math.max(m, o.max_occupancy ?? 0), 0) || null;

      const chosen = (search.require_all_inclusive && aiOffers.length > 0) ? aiOffers[0] : offers[0];
      const top = offers.slice(0, MAX_OFFERS_PER_PACKAGE);
      const have = new Set(top.map(o => o.offer_id));
      if (cheapestAiOfferId && !have.has(cheapestAiOfferId)) {
        const f = offers.find(o => o.offer_id === cheapestAiOfferId); if (f) top.push(f);
      }
      if (cheapestRefOfferId && !have.has(cheapestRefOfferId)) {
        const f = offers.find(o => o.offer_id === cheapestRefOfferId); if (f) top.push(f);
      }

      for (const p of pkgsForHotel) {
        upgraded++;
        // We need the existing flight_price to compute total_price.
        // Fetch is below in batch — keep just per-package fields for now.
        for (const o of top) {
          rateOfferRows.push({
            offer_id: o.offer_id,
            package_id: p.package_id,
            resort_id: p.resort_id,
            liteapi_hotel_id: hotelId,
            room_type_id: o.room_type_id,
            mapped_room_id: o.mapped_room_id,
            room_name: o.room_name,
            rate_id: o.rate_id,
            max_occupancy: o.max_occupancy,
            adult_count: o.adult_count,
            child_count: o.child_count,
            children_ages: o.children_ages,
            total_price: o.total_price,
            per_night: o.per_night,
            currency: o.currency,
            suggested_selling_price: o.suggested_selling_price,
            initial_price: o.initial_price,
            commission_amount: o.commission_amount,
            commission_pct: o.commission_pct,
            board_type: o.board_type,
            board_name: o.board_name,
            is_all_inclusive: o.is_all_inclusive,
            refundable: o.refundable,
            refundable_tag: o.refundable_tag,
            cancellation_deadline: o.cancellation_deadline,
            cancellation_penalty: o.cancellation_penalty,
            payment_types: o.payment_types,
            supplier: o.supplier,
            price_type: o.price_type,
            rate_type: o.rate_type,
            perks: o.perks,
            has_promotions: o.has_promotions,
            remarks: o.remarks,
            raw_offer: o.raw_offer,
          });
        }

        packageUpdates.push({
          package_id: p.package_id,
          hotel_price: Math.round(chosen.total_price),
          hotel_supplier: "liteapi",
          hotel_priced_at: nowIso,
          hotel_offer_id: chosen.offer_id,
          hotel_offer_count: offers.length,
          cheapest_offer_id: chosen.offer_id,
          cheapest_ai_offer_id: cheapestAiOfferId,
          cheapest_ai_total: cheapestAiTotal,
          cheapest_refundable_offer_id: cheapestRefOfferId,
          cheapest_refundable_total: cheapestRefTotal,
          max_offer_occupancy: maxOfferOcc,
          has_any_ai: hasAnyAi,
          has_any_refundable: hasAnyRefundable,
        });
      }
    }

    // Persist offers synchronously, like start_pricing v8+.
    let offersPersisted = 0;
    let offerWriteTruncated = false;
    if (rateOfferRows.length) {
      const writeStart = Date.now();
      try {
        const pkgIds = Array.from(new Set(rateOfferRows.map(r => r.package_id)));
        for (let i = 0; i < pkgIds.length; i += 200) {
          if (Date.now() - writeStart > OFFER_WRITE_BUDGET_MS) { offerWriteTruncated = true; break; }
          await sb.from("hotel_rate_offers").delete().in("package_id", pkgIds.slice(i, i + 200));
        }
        for (let i = 0; i < rateOfferRows.length; i += 200) {
          if (Date.now() - writeStart > OFFER_WRITE_BUDGET_MS) { offerWriteTruncated = true; break; }
          const slice = rateOfferRows.slice(i, i + 200);
          const { error: oe } = await sb.from("hotel_rate_offers").upsert(slice, { onConflict: "offer_id" });
          if (!oe) offersPersisted += slice.length;
        }
      } catch (e) {
        console.error("[top_up_hotels_worker] offer persistence error:", e);
      }
    }

    // Update packages — we need to also update total_price = flight_price + hotel_price.
    // Read current flight prices, then write the combined total back.
    if (packageUpdates.length) {
      const ids = packageUpdates.map(u => u.package_id);
      const { data: existing } = await sb.from("packages")
        .select("package_id, flight_price").in("package_id", ids);
      const flightByPkg = new Map<string, number>();
      for (const e of existing ?? []) flightByPkg.set(e.package_id, Number(e.flight_price ?? 0));

      const CHUNK = 50;
      for (let i = 0; i < packageUpdates.length; i += CHUNK) {
        const slice = packageUpdates.slice(i, i + CHUNK);
        await Promise.all(slice.map(u => {
          const { package_id, ...vals } = u;
          const fp = flightByPkg.get(package_id) ?? 0;
          const total = fp + Number(vals.hotel_price);
          return sb.from("packages").update({ ...vals, total_price: total }).eq("package_id", package_id);
        }));
      }
    }

    // Chain ourselves if more mock packages remain (with a hard depth cap).
    const { count: remainingCount } = await sb.from("packages")
      .select("package_id", { count: "exact", head: true })
      .eq("search_id", search_id)
      .eq("hotel_supplier", "mock");
    const remainingHasIds = (remainingCount ?? 0) > 0 && depth + 1 < MAX_CHAIN_DEPTH;
    let chained = false;
    if (remainingHasIds) {
      // Confirm those remaining have liteapi_hotel_id before chaining.
      const { data: check } = await sb.from("packages")
        .select("package_id, resorts!inner(liteapi_hotel_id)")
        .eq("search_id", search_id)
        .eq("hotel_supplier", "mock")
        .not("resorts.liteapi_hotel_id", "is", null)
        .limit(1);
      if ((check ?? []).length > 0) {
        const p = fetch(`${supabaseUrl}/functions/v1/top_up_hotels_worker`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
          body: JSON.stringify({ search_id, max_pkgs: DEFAULT_MAX_PKGS, depth: depth + 1 }),
        });
        const er = (globalThis as any).EdgeRuntime;
        if (er?.waitUntil) er.waitUntil(p.catch((e) => console.error("[top_up_hotels_worker] chain error:", e)));
        else p.catch((e) => console.error("[top_up_hotels_worker] chain error:", e));
        chained = true;
      }
    }

    return new Response(JSON.stringify({
      version: VERSION,
      search_id,
      depth,
      processed: targetPkgs.length,
      upgraded,
      batches_attempted: batchesAttempted,
      batches_succeeded: batchesSucceeded,
      wall_time_budget_hit: wallTimeBudgetHit,
      rate_limit_hit: rateLimitHit,
      last_error: lastError,
      offers_persisted: offersPersisted,
      offer_write_truncated: offerWriteTruncated,
      chained,
      remaining_mock: remainingCount,
    }), { status: 200, headers });

  } catch (e) {
    console.error("top_up_hotels_worker error:", e);
    return new Response(JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }), { status: 500, headers });
  }
});
