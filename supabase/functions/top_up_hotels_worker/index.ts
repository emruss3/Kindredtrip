// top_up_hotels_worker
//
// v9 (2026-06-24): RETRY LiteAPI misses instead of killing them. Root-cause
// of the live-rate regression (was ~90-100%, dropped to ~65%): LiteAPI's
// /hotels/rates omits ~24% of requested hotels per call (their suppliers
// don't answer within the request `timeout`). v8 marked any omitted hotel
// as no_fit PERMANENTLY on the first miss, so a slow-responding hotel became
// a dead listing. Now: a miss (no hotelData, or hotel returned zero rooms)
// is left as 'mock' so the chain re-queries it next cycle; misses are only
// converted to no_fit on the FINAL chain cycle. Since each call independently
// returns ~76%, leaving misses for retry converges to ~99% fetched over the
// chain (1 - 0.24^5). Genuine room-size mismatches (rooms returned but none
// sleep the party) are still marked no_fit immediately — retrying won't change
// room capacities. Also bumped LITEAPI_TIMEOUT_S 3->5 so fewer misses per call.
//
// v7: room-occupancy excludes infants (<2).

// Built-in Deno.serve (no deno.land/std import) for bundler reliability.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "top_up_hotels_worker_v13_multiroom";
const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";
const HOTEL_BATCH_SIZE = 25;
// v12: 2 -> 6 (matches start_pricing v20). 429 backoff self-limits.
const HOTEL_BATCH_CONCURRENCY = 6;
const MAX_OFFERS_PER_PACKAGE = 12;
const LITEAPI_TIMEOUT_S = 5;
const WALL_CLOCK_BUDGET_MS = 35_000;
const OFFER_WRITE_BUDGET_MS = 10_000;
// v11: bumped 200 -> 700 so a single chain cycle can process every pending
// package for a typical search. Verified: an isolated single search now
// reaches ~88% hotel_live (vs ~30-50% before the v11 fixes), 0 stranded
// pending. Under heavy parallel-search load some searches still under-fetch
// — that's a separate Supabase edge-function dispatch-drop issue, not a
// max_pkgs problem (see edge_function_errors empty + dispatch fire-and-forget).
const DEFAULT_MAX_PKGS = 700;
const MAX_CHAIN_DEPTH = 6;
// Misses (LiteAPI omitted the hotel / returned no rooms) are retried as 'mock'
// until this depth, then converted to no_fit so the search can terminate.
const FINAL_RETRY_DEPTH = MAX_CHAIN_DEPTH - 1;

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

// v13 MULTI-ROOM: 2-room occupancy split for parties >= 5 (see start_pricing v21).
function buildOccupancies(adults: number, childAges: number[]): Array<{ adults: number; children: number[] }> {
  const olderKids = childAges.filter((a) => a >= 2);
  const partySize = adults + olderKids.length;
  if (partySize < 5 || adults < 2) return [{ adults, children: childAges }];
  const a1 = Math.ceil(adults / 2);
  const a2 = adults - a1;
  const sorted = [...childAges].sort((x, y) => y - x);
  const c1: number[] = [], c2: number[] = [];
  sorted.forEach((k, i) => (i % 2 === 0 ? c1 : c2).push(k));
  return [{ adults: a1, children: c1 }, { adults: a2, children: c2 }];
}

function extractRateOffers(hotel: any, hotelId: string, nights: number, roomsRequested = 1): any[] {
  const out: any[] = [];
  const roomTypes: any[] = Array.isArray(hotel?.roomTypes) ? hotel.roomTypes : [];
  for (const rt of roomTypes) {
    const liteOfferId = String(rt?.offerId ?? "");
    if (!liteOfferId) continue;
    const paymentTypes: string[] = Array.isArray(rt?.paymentTypes) ? rt.paymentTypes : [];
    const supplier = rt?.supplier ?? null;
    const roomTypeId = rt?.roomTypeId ?? null;
    const wrapperMappedRoomId = rt?.mappedRoomId ?? null;
    const priceType = rt?.priceType ?? null;
    const rateType = rt?.rateType ?? null;
    const rates: any[] = Array.isArray(rt?.rates) ? rt.rates : [];

    // v13 MULTI-ROOM: one rates[] entry per occupancyNumber; the roomType
    // offer covers all rooms. Merge to a single priced offer (sum of rooms).
    if (roomsRequested > 1) {
      const byOcc = new Map<number, any>();
      for (const rate of rates) {
        const total = Number(rate?.retailRate?.total?.[0]?.amount ?? 0);
        if (!total) continue;
        const n = Number(rate?.occupancyNumber ?? 1);
        const prev = byOcc.get(n);
        const prevTotal = prev ? Number(prev?.retailRate?.total?.[0]?.amount ?? Infinity) : Infinity;
        if (total < prevTotal) byOcc.set(n, rate);
      }
      if (byOcc.size < roomsRequested) continue;
      const parts = Array.from(byOcc.values());
      const sum = (f: (r: any) => number) => parts.reduce((acc, r) => acc + (Number.isFinite(f(r)) ? f(r) : 0), 0);
      const total = sum((r) => Number(r?.retailRate?.total?.[0]?.amount ?? 0));
      if (!total) continue;
      const ssp = sum((r) => Number(r?.retailRate?.suggestedSellingPrice?.[0]?.amount ?? NaN));
      const commAmt = sum((r) => Number(r?.commission?.[0]?.amount ?? NaN));
      const first = parts[0];
      const currency = String(first?.retailRate?.total?.[0]?.currency ?? "USD");
      const boardType = String(first?.boardType ?? "").toUpperCase() || null;
      const boardName = first?.boardName ?? null;
      const isAI = boardType === "AI" || (boardName && /all\s+inclusive/i.test(String(boardName)));
      const tags = parts.map((r) => r?.cancellationPolicies?.refundableTag ?? null);
      const refundable = tags.every((t) => t === "RFN") ? true : (tags.some((t) => t === "NRFN") ? false : null);
      const firstPolicy = (Array.isArray(first?.cancellationPolicies?.cancelPolicyInfos) ? first.cancellationPolicies.cancelPolicyInfos : [])[0] ?? null;
      const names = Array.from(new Set(parts.map((r) => r?.name).filter(Boolean)));
      const roomName = `${names.join(" + ") || "Room combo"} (${roomsRequested} rooms)`;
      const maxOcc = sum((r) => Number(r?.maxOccupancy ?? 0)) || null;
      const rateId = parts.map((r) => String(r?.rateId ?? "r0")).join("+");
      const offerId = `${hotelId}_${shortHash(liteOfferId + "|" + rateId)}`;
      out.push({
        offer_id: offerId,
        room_type_id: roomTypeId,
        mapped_room_id: null,
        room_name: roomName,
        rate_id: rateId,
        max_occupancy: maxOcc,
        adult_count: sum((r) => Number(r?.adultCount ?? 0)) || null,
        child_count: sum((r) => Number(r?.childCount ?? 0)) || null,
        children_ages: parts.flatMap((r) => Array.isArray(r?.childrenAges) ? r.childrenAges : []),
        total_price: total,
        per_night: nights > 0 ? Number((total / nights).toFixed(2)) : null,
        currency,
        suggested_selling_price: ssp > 0 ? ssp : null,
        initial_price: null,
        commission_amount: commAmt > 0 ? commAmt : null,
        commission_pct: commAmt > 0 && total > 0 ? Number(((commAmt / total) * 100).toFixed(2)) : null,
        board_type: boardType,
        board_name: boardName,
        is_all_inclusive: Boolean(isAI),
        refundable,
        refundable_tag: tags[0] ?? null,
        cancellation_deadline: firstPolicy?.cancelTime ?? null,
        cancellation_penalty: firstPolicy?.amount != null ? Number(firstPolicy.amount) : null,
        payment_types: paymentTypes,
        supplier,
        price_type: priceType,
        rate_type: rateType,
        perks: [],
        has_promotions: false,
        remarks: null,
        raw_offer: {
          _liteapi_offer_id: liteOfferId,
          _liteapi_room_type_id: roomTypeId,
          _liteapi_rate_id: rateId,
          _rooms: roomsRequested,
          board_type: boardType,
          board_name: boardName,
          refundable_tag: tags[0] ?? null,
        },
      });
      continue;
    }

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

Deno.serve(async (req) => {
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
    const isFinalCycle = depth >= FINAL_RETRY_DEPTH;

    const { data: pkgs, error: pErr } = await sb.from("packages")
      .select(`
        package_id, search_id, resort_id,
        resorts ( liteapi_hotel_id )
      `)
      .eq("search_id", search_id)
      .eq("hotel_supplier", "pending")
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
    // v13: 2-room occupancy split for parties >= 5.
    const hotelOccupancies = buildOccupancies(adults, childAges);
    const roomsRequested = hotelOccupancies.length;

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

    // v7: infants (<2) are NOT counted toward room occupancy.
    // v13: multi-room offers are priced for our exact occupancies — fit by construction.
    const partySize = adults + olderChildAges.length;
    const fitsParty = (o: any) =>
      roomsRequested > 1 || o.max_occupancy == null || Number(o.max_occupancy) >= partySize;

    const noFitUpdates: any[] = [];
    const markNoFit = (p: any) => noFitUpdates.push({
      package_id: p.package_id,
      hotel_supplier: "no_fit",
      hotel_priced_at: nowIso,
    });
    // v9: a miss (no data / no rooms returned) is RETRIED on the next chain
    // cycle by leaving the package as 'pending' (no update written). Only on the
    // final cycle do we convert it to no_fit so the search can terminate.
    let leftForRetry = 0;
    const handleMiss = (p: any) => {
      if (isFinalCycle) markNoFit(p);
      else leftForRetry++; // leave as pending -> re-queried next cycle
    };

    for (const [hotelId, pkgsForHotel] of idToPackages.entries()) {
      const hotelData = hotelDataById.get(hotelId);
      if (!hotelData) { for (const p of pkgsForHotel) handleMiss(p); continue; }
      const offers = extractRateOffers(hotelData, hotelId, nights, roomsRequested);
      if (offers.length === 0) { for (const p of pkgsForHotel) handleMiss(p); continue; }

      const fitsOffers = offers.filter(fitsParty);
      // Genuine room-size mismatch: rooms returned but none sleep the party.
      // Retrying won't change room capacities -> terminal no_fit immediately.
      if (fitsOffers.length === 0) { for (const p of pkgsForHotel) markNoFit(p); continue; }

      offers.sort((a, b) => a.total_price - b.total_price);
      fitsOffers.sort((a, b) => a.total_price - b.total_price);
      const aiOffers = fitsOffers.filter(o => o.is_all_inclusive);
      const refOffers = fitsOffers.filter(o => o.refundable === true);
      const cheapestAiRawId = aiOffers[0]?.offer_id ?? null;
      const cheapestAiTotal = aiOffers[0]?.total_price ?? null;
      const cheapestRefRawId = refOffers[0]?.offer_id ?? null;
      const cheapestRefTotal = refOffers[0]?.total_price ?? null;
      const hasAnyAi = aiOffers.length > 0;
      const hasAnyRefundable = refOffers.length > 0;
      const maxOfferOcc = offers.reduce((m, o) => Math.max(m, o.max_occupancy ?? 0), 0) || null;

      const chosen = (search.require_all_inclusive && aiOffers.length > 0) ? aiOffers[0] : fitsOffers[0];
      const top = offers.slice(0, MAX_OFFERS_PER_PACKAGE);
      const have = new Set(top.map(o => o.offer_id));
      if (cheapestAiRawId && !have.has(cheapestAiRawId)) {
        const f = offers.find(o => o.offer_id === cheapestAiRawId); if (f) top.push(f);
      }
      if (cheapestRefRawId && !have.has(cheapestRefRawId)) {
        const f = offers.find(o => o.offer_id === cheapestRefRawId); if (f) top.push(f);
      }

      for (const p of pkgsForHotel) {
        upgraded++;
        const pkgScope = p.package_id.slice(0, 8);
        const scopeId = (id: string) => `${pkgScope}_${id}`;
        const cheapestAiOfferId = cheapestAiRawId ? scopeId(cheapestAiRawId) : null;
        const cheapestRefOfferId = cheapestRefRawId ? scopeId(cheapestRefRawId) : null;
        const chosenScopedId = scopeId(chosen.offer_id);
        for (const o of top) {
          rateOfferRows.push({
            offer_id: scopeId(o.offer_id),
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
          hotel_offer_id: chosenScopedId,
          hotel_offer_count: offers.length,
          cheapest_offer_id: chosenScopedId,
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

    // v12: package price updates FIRST (visible prices), offer detail second.
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
          const hp = Number(vals.hotel_price);
          // No-mock: total only when a live flight price exists too.
          const total = fp > 0 ? fp + hp : null;
          return sb.from("packages").update({ ...vals, total_price: total }).eq("package_id", package_id);
        }));
      }
    }

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

    if (noFitUpdates.length) {
      const CHUNK = 50;
      for (let i = 0; i < noFitUpdates.length; i += CHUNK) {
        const slice = noFitUpdates.slice(i, i + CHUNK);
        await Promise.all(slice.map(u => {
          const { package_id, ...vals } = u;
          return sb.from("packages").update(vals).eq("package_id", package_id);
        }));
      }
    }

    const { count: remainingCount } = await sb.from("packages")
      .select("package_id", { count: "exact", head: true })
      .eq("search_id", search_id)
      .eq("hotel_supplier", "pending");
    const remainingHasIds = (remainingCount ?? 0) > 0 && depth + 1 < MAX_CHAIN_DEPTH;
    let chained = false;
    let terminalSweptCount = 0;
    // v11: TERMINAL SWEEP. When this is the last cycle we'll run (next chain
    // would exceed MAX_CHAIN_DEPTH OR there's nothing left to chain on),
    // any package still 'pending' will never be priced — LiteAPI has had
    // 6 chances. Mark them all no_fit so the UI stops showing
    // "finding live prices…" forever. Without this, a search with more
    // pending packages than the chain can process strands them indefinitely.
    if (!remainingHasIds && (remainingCount ?? 0) > 0) {
      const { data: swept, error: sweepErr } = await sb.from("packages")
        .update({ hotel_supplier: "no_fit", hotel_priced_at: nowIso })
        .eq("search_id", search_id)
        .eq("hotel_supplier", "pending")
        .select("package_id");
      if (!sweepErr) terminalSweptCount = swept?.length ?? 0;
      else console.error("[top_up_hotels_worker] terminal sweep error:", sweepErr);
    }
    if (remainingHasIds) {
      const { data: check } = await sb.from("packages")
        .select("package_id, resorts!inner(liteapi_hotel_id)")
        .eq("search_id", search_id)
        .eq("hotel_supplier", "pending")
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
      is_final_cycle: isFinalCycle,
      processed: targetPkgs.length,
      upgraded,
      left_for_retry: leftForRetry,
      no_fit_marked: noFitUpdates.length,
      batches_attempted: batchesAttempted,
      batches_succeeded: batchesSucceeded,
      wall_time_budget_hit: wallTimeBudgetHit,
      rate_limit_hit: rateLimitHit,
      last_error: lastError,
      offers_persisted: offersPersisted,
      offer_write_truncated: offerWriteTruncated,
      chained,
      remaining_pending: remainingCount,
      terminal_swept: terminalSweptCount,
    }), { status: 200, headers });

  } catch (e) {
    console.error("top_up_hotels_worker error:", e);
    return new Response(JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }), { status: 500, headers });
  }
});
