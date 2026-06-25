// start_pricing
//
// v18 (2026-06-23): removed the infant 'banned_children' hard-drop
// (cap_child_allowed=false). That field is unreliable data (310/597 family
// resorts carry it, 218 with kids clubs). The child-policy gate now lives
// ONCE in process_search_batch v20 (corroborated: no kids-club AND not
// Family); start_pricing must not re-drop what passed, or those packages
// would exist but never get priced.
//
// v17 (2026-06-23): room-occupancy requirement EXCLUDES infants (<2).
// Most hotels don't count an under-2 toward room occupancy (lap/crib),
// so a 2A+2K+1-infant family fits a room that sleeps 4. We still send the
// full child ages to LiteAPI (each hotel applies its own infant policy);
// roomPartySize (adults + kids>=2) is what our fit-filter and pre-filter
// use. The trip-detail room list adds an '⚠ infant needs a crib — verify
// with hotel' callout on any room that only fits because the infant isn't
// counted. (familySize, incl. infants, is kept for mock price scaling.)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "start_pricing_v18_infant_occupancy";
const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";
const HOTEL_BATCH_SIZE = 25;
const HOTEL_BATCH_CONCURRENCY = 2;
const MAX_OFFERS_PER_PACKAGE = 12;
const LITEAPI_TIMEOUT_S = 3;
const WALL_CLOCK_BUDGET_MS = 22_000;
const OFFER_WRITE_BUDGET_MS = 12_000;

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

function seededRand(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

function nightsBetween(a: string, b: string): number {
  return Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000));
}

function mockHotelNightlyTier(rating: number | null): number {
  if (rating == null) return 320;
  if (rating >= 95) return 720;
  if (rating >= 92) return 540;
  if (rating >= 88) return 425;
  if (rating >= 84) return 340;
  if (rating >= 80) return 270;
  if (rating >= 75) return 220;
  return 180;
}

type ExtractedRateOffer = {
  offer_id: string;
  raw_offer_id_full: string;
  room_type_id: string | null;
  mapped_room_id: string | null;
  room_name: string | null;
  rate_id: string | null;
  max_occupancy: number | null;
  adult_count: number | null;
  child_count: number | null;
  children_ages: number[];
  total_price: number;
  per_night: number | null;
  currency: string;
  suggested_selling_price: number | null;
  initial_price: number | null;
  commission_amount: number | null;
  commission_pct: number | null;
  board_type: string | null;
  board_name: string | null;
  is_all_inclusive: boolean;
  refundable: boolean | null;
  refundable_tag: string | null;
  cancellation_deadline: string | null;
  cancellation_penalty: number | null;
  payment_types: string[];
  supplier: string | null;
  price_type: string | null;
  rate_type: string | null;
  perks: string[];
  has_promotions: boolean;
  remarks: string | null;
  raw_offer: any;
};

function extractRateOffers(hotel: any, hotelId: string, nights: number): ExtractedRateOffer[] {
  const out: ExtractedRateOffer[] = [];
  const roomTypes: any[] = Array.isArray(hotel?.roomTypes) ? hotel.roomTypes : [];
  for (const rt of roomTypes) {
    const liteOfferId = String(rt?.offerId ?? "");
    if (!liteOfferId) continue;
    const priceType = rt?.priceType ?? null;
    const rateType = rt?.rateType ?? null;
    const paymentTypes: string[] = Array.isArray(rt?.paymentTypes) ? rt.paymentTypes : [];
    const supplier = rt?.supplier ?? null;
    const roomTypeId = rt?.roomTypeId ?? null;
    const wrapperMappedRoomId = rt?.mappedRoomId ?? null;
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
      const policies: any[] = Array.isArray(rate?.cancellationPolicies?.cancelPolicyInfos)
        ? rate.cancellationPolicies.cancelPolicyInfos : [];
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
        raw_offer_id_full: liteOfferId,
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
  const deduped: ExtractedRateOffer[] = [];
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

function buildResortPreFilter(
  search: any, familySize: number, hasInfant: boolean,
): { description: string; willApply: string[] } {
  const filters: string[] = [];
  if (familySize >= 5) filters.push(`occupancy>=${familySize} OR connecting=true OR has_suite=true OR has_villa=true OR no-cap-data`);
  if (search.require_kids_club) filters.push("cap_has_kids_club=true OR no-cap-data");
  if (search.require_connecting_rooms) filters.push("cap_has_connecting=true OR no-cap-data");
  return { description: filters.length ? filters.join("; ") : "none", willApply: filters };
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ version: VERSION, error: "POST only" }), { status: 405, headers });

  try {
    const body = await req.json().catch(() => ({}));
    const search_id = String(body.search_id ?? "");
    if (!search_id) return new Response(JSON.stringify({ version: VERSION, error: "search_id required" }), { status: 400, headers });

    const apiKey = findApiKey();
    if (!apiKey) throw new Error("LiteAPI key missing");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    const { data: search, error: sErr } = await sb.from("searches").select("*").eq("search_id", search_id).maybeSingle();
    if (sErr) throw sErr;
    if (!search) return new Response(JSON.stringify({ version: VERSION, error: "search not found" }), { status: 404, headers });

    const adults = Number(search.adults ?? 2);
    const childAges = parseChildAges(search.child_ages);
    const infantAges = childAges.filter(a => a < 2);
    const olderChildAges = childAges.filter(a => a >= 2);
    const children = olderChildAges.length;
    const infants = infantAges.length;
    const familySize = adults + childAges.length;
    // v17: infants (<2) are NOT counted toward room occupancy.
    const roomPartySize = adults + olderChildAges.length;
    const hasInfant = infants > 0;
    const nights = nightsBetween(search.date_start, search.date_end);
    const paxSig = `${adults}:${children}:${infants}`;

    const preFilter = buildResortPreFilter(search, roomPartySize, hasInfant);

    const { data: pkgsRaw, error: pErr } = await sb.from("packages")
      .select(`
        package_id, search_id, resort_id, dest_airport_iata,
        resorts (
          resort_name, country, avg_user_rating, liteapi_hotel_id,
          cap_max_room_occupancy, cap_has_connecting, cap_has_suite, cap_has_villa,
          cap_has_kids_club, cap_child_allowed, cap_fetched_at
        )
      `)
      .eq("search_id", search_id);
    if (pErr) throw pErr;
    if (!pkgsRaw?.length) return new Response(JSON.stringify({ version: VERSION, packages_priced: 0 }), { status: 200, headers });

    let droppedBy: Record<string, number> = { occupancy_too_small: 0, no_kids_club: 0, no_connecting: 0 };
    const pkgs = pkgsRaw.filter((p: any) => {
      const r = p.resorts;
      if (!r) return false;
      const hasCapData = r.cap_fetched_at != null;
      // v18: NO cap_child_allowed drop here — process_search_batch owns the
      // (corroborated) child-policy gate; re-dropping would leave packages
      // unpriced.
      if (roomPartySize >= 5 && hasCapData) {
        const occOk = (r.cap_max_room_occupancy ?? 0) >= roomPartySize;
        const altOk = r.cap_has_connecting === true || r.cap_has_suite === true || r.cap_has_villa === true;
        if (!occOk && !altOk) { droppedBy.occupancy_too_small++; return false; }
      }
      if (search.require_kids_club && hasCapData && r.cap_has_kids_club === false) { droppedBy.no_kids_club++; return false; }
      if (search.require_connecting_rooms && hasCapData && r.cap_has_connecting !== true) { droppedBy.no_connecting++; return false; }
      return true;
    });

    const dropped = pkgsRaw.length - pkgs.length;
    const uniqueDestinations = Array.from(new Set(pkgs.map((p: any) => p.dest_airport_iata).filter(Boolean))) as string[];

    const { data: cacheHits } = await sb.from("v_flight_cache_lookup")
      .select("*")
      .eq("origin_iata", search.origin_iata)
      .eq("departure_date", search.date_start)
      .eq("return_date", search.date_end)
      .eq("pax_signature", paxSig)
      .in("dest_iata", uniqueDestinations);
    const cachedByDest = new Map<string, any>();
    for (const c of cacheHits ?? []) cachedByDest.set(c.dest_iata, c);

    const routeRows = uniqueDestinations.map(dest => {
      const cached = cachedByDest.get(dest);
      if (cached) {
        return {
          search_id, origin_iata: search.origin_iata, dest_iata: dest,
          departure_date: search.date_start, return_date: search.date_end,
          adults, children, infants, status: "done",
          fetched_at: new Date().toISOString(), offers_count: cached.offers_count ?? 0,
          cheapest_offer_id: cached.cheapest_offer_id, cheapest_total: cached.cheapest_total,
          cheapest_nonstop_offer_id: cached.cheapest_nonstop_offer_id, cheapest_nonstop_total: cached.cheapest_nonstop_total,
          cheapest_refundable_offer_id: cached.cheapest_refundable_offer_id, cheapest_refundable_total: cached.cheapest_refundable_total,
        };
      }
      return {
        search_id, origin_iata: search.origin_iata, dest_iata: dest,
        departure_date: search.date_start, return_date: search.date_end,
        adults, children, infants, status: "pending", offers_count: 0,
      };
    });

    const { data: insertedRoutes, error: rErr } = await sb.from("flight_search_routes")
      .upsert(routeRows, { onConflict: "search_id,dest_iata" })
      .select("route_id, dest_iata, status, cheapest_offer_id, cheapest_total");
    if (rErr) throw rErr;
    const routeByDest = new Map<string, any>();
    for (const r of insertedRoutes ?? []) routeByDest.set(r.dest_iata, r);

    const liteapiHotelIds = Array.from(new Set(pkgs.map((p: any) => p.resorts?.liteapi_hotel_id).filter(Boolean))) as string[];
    const hotelDataById = new Map<string, any>();
    const hotelOccupancies = [{ adults, children: childAges }];

    let hotelBatchesAttempted = 0, hotelBatchesSucceeded = 0;
    let hotelLastError: string | undefined;
    let hotelRateLimitHit = false;
    let wallTimeBudgetHit = false;

    const liteapiLoopStart = Date.now();
    const allBatches: string[][] = [];
    for (let i = 0; i < liteapiHotelIds.length; i += HOTEL_BATCH_SIZE) allBatches.push(liteapiHotelIds.slice(i, i + HOTEL_BATCH_SIZE));

    for (let w = 0; w < allBatches.length; w += HOTEL_BATCH_CONCURRENCY) {
      if (Date.now() - liteapiLoopStart > WALL_CLOCK_BUDGET_MS) { wallTimeBudgetHit = true; break; }
      const wave = allBatches.slice(w, w + HOTEL_BATCH_CONCURRENCY);
      hotelBatchesAttempted += wave.length;
      const results = await Promise.all(wave.map((batch) => fetchHotelRatesBatch(apiKey, batch, search.date_start, search.date_end, hotelOccupancies)));
      let hit429 = false;
      for (const res of results) {
        if (res.error) { hotelLastError = res.error; if (res.status === 429) hit429 = true; }
        else { hotelBatchesSucceeded++; for (const h of res.hotels) { const id = String(h?.hotelId ?? ""); if (id) hotelDataById.set(id, h); } }
      }
      if (hit429) { hotelRateLimitHit = true; break; }
    }

    const { data: airportTiers } = await sb.from("mock_flight_pricing").select("airport_code, base_price_min, base_price_max, typical_stops, typical_duration_hours");
    const airportTier = new Map<string, any>();
    for (const r of airportTiers ?? []) airportTier.set(r.airport_code, r);
    const { data: countryMods } = await sb.from("mock_hotel_pricing_country").select("country, price_multiplier");
    const countryMult = new Map<string, number>();
    for (const r of countryMods ?? []) countryMult.set(r.country, Number(r.price_multiplier));

    const fareEq = adults + (childAges.length * 0.75);
    const nowIso = new Date().toISOString();
    const packageUpdates: any[] = [];
    const rateOfferRows: any[] = [];
    let hotelLive = 0, hotelMock = 0, hotelFallback = 0;
    let flightLive = 0, flightMockPlaceholder = 0;

    for (const p of pkgs) {
      const r = (p as any).resorts;
      const dest = p.dest_airport_iata;
      const route = dest ? routeByDest.get(dest) : null;
      if (!route) continue;

      let flightTotal: number, flightSupplier: string, flightOfferId: string | null = null;
      let stops = 1, durationHours: number | null = 7;
      if (route.status === "done" && route.cheapest_total != null) {
        flightTotal = Math.round(Number(route.cheapest_total));
        flightSupplier = "liteapi";
        flightOfferId = route.cheapest_offer_id ?? null;
        flightLive++;
      } else {
        const tier = airportTier.get(dest);
        const rnd = seededRand(`flt:${search.origin_iata}:${dest}:${search.date_start}`);
        let perPerson: number;
        if (!tier) perPerson = Math.round(640 + rnd * 220);
        else { perPerson = Math.round(Number(tier.base_price_min) + rnd * (Number(tier.base_price_max) - Number(tier.base_price_min))); stops = tier.typical_stops ?? 1; durationHours = tier.typical_duration_hours ?? null; }
        flightTotal = Math.round(perPerson * fareEq);
        flightSupplier = "mock";
        flightMockPlaceholder++;
      }

      let hotelTotal: number;
      let hotelSupplier: string;
      let chosenOfferId: string | null = null;
      let offerCount = 0;
      let cheapestAiTotal: number | null = null;
      let cheapestAiOfferId: string | null = null;
      let cheapestRefTotal: number | null = null;
      let cheapestRefOfferId: string | null = null;
      let maxOfferOcc: number | null = null;
      let hasAnyAi = false;
      let hasAnyRefundable = false;

      const hotelData = r?.liteapi_hotel_id ? hotelDataById.get(r.liteapi_hotel_id) : null;
      if (hotelData) {
        const offers = extractRateOffers(hotelData, r.liteapi_hotel_id, nights);
        if (offers.length > 0) {
          const partySize = roomPartySize;
          const fitsParty = (o: ExtractedRateOffer) => o.max_occupancy == null || Number(o.max_occupancy) >= partySize;
          const fitsOffers = offers.filter(fitsParty);

          if (fitsOffers.length === 0) {
            hotelTotal = mockHotelTotal(r, nights, familySize, countryMult, p.resort_id, search.date_start);
            hotelSupplier = "no_fit";
            hotelFallback++;
          } else {
            hotelSupplier = "liteapi";
            hotelLive++;
            fitsOffers.sort((a, b) => a.total_price - b.total_price);
            offers.sort((a, b) => a.total_price - b.total_price);
            const aiOffers = fitsOffers.filter(o => o.is_all_inclusive);
            const refOffers = fitsOffers.filter(o => o.refundable === true);
            const pkgScope = p.package_id.slice(0, 8);
            const scopeId = (id: string) => `${pkgScope}_${id}`;
            cheapestAiTotal = aiOffers[0]?.total_price ?? null;
            cheapestAiOfferId = aiOffers[0] ? scopeId(aiOffers[0].offer_id) : null;
            cheapestRefTotal = refOffers[0]?.total_price ?? null;
            cheapestRefOfferId = refOffers[0] ? scopeId(refOffers[0].offer_id) : null;
            hasAnyAi = aiOffers.length > 0;
            hasAnyRefundable = refOffers.length > 0;
            maxOfferOcc = offers.reduce((m, o) => Math.max(m, o.max_occupancy ?? 0), 0) || null;

            let chosen: ExtractedRateOffer | null = null;
            if (search.require_all_inclusive && aiOffers.length > 0) chosen = aiOffers[0];
            else chosen = fitsOffers[0];
            chosenOfferId = scopeId(chosen.offer_id);
            hotelTotal = Math.round(chosen.total_price);
            offerCount = offers.length;

            const top = offers.slice(0, MAX_OFFERS_PER_PACKAGE);
            const have = new Set(top.map(o => o.offer_id));
            const cheapestAiRawId = aiOffers[0]?.offer_id ?? null;
            const cheapestRefRawId = refOffers[0]?.offer_id ?? null;
            if (cheapestAiRawId && !have.has(cheapestAiRawId)) { const found = offers.find(o => o.offer_id === cheapestAiRawId); if (found) top.push(found); }
            if (cheapestRefRawId && !have.has(cheapestRefRawId)) { const found = offers.find(o => o.offer_id === cheapestRefRawId); if (found) top.push(found); }

            for (const o of top) {
              rateOfferRows.push({
                offer_id: scopeId(o.offer_id),
                package_id: p.package_id,
                resort_id: p.resort_id,
                liteapi_hotel_id: r.liteapi_hotel_id,
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
          }
        } else {
          hotelTotal = mockHotelTotal(r, nights, familySize, countryMult, p.resort_id, search.date_start);
          hotelSupplier = "mock";
          hotelFallback++;
        }
      } else {
        hotelTotal = mockHotelTotal(r, nights, familySize, countryMult, p.resort_id, search.date_start);
        hotelSupplier = "mock";
        hotelMock++;
      }

      packageUpdates.push({
        package_id: p.package_id, flight_route_id: route.route_id, flight_offer_id: flightOfferId,
        flight_price: flightTotal, hotel_price: hotelTotal, total_price: flightTotal + hotelTotal,
        stops, duration_hours: durationHours, flight_supplier: flightSupplier, hotel_supplier: hotelSupplier,
        flight_priced_at: nowIso, hotel_priced_at: nowIso, priced_at: nowIso,
        hotel_offer_id: chosenOfferId, hotel_offer_count: offerCount, cheapest_offer_id: chosenOfferId,
        cheapest_ai_offer_id: cheapestAiOfferId, cheapest_ai_total: cheapestAiTotal,
        cheapest_refundable_offer_id: cheapestRefOfferId, cheapest_refundable_total: cheapestRefTotal,
        max_offer_occupancy: maxOfferOcc, has_any_ai: hasAnyAi, has_any_refundable: hasAnyRefundable,
      });
    }

    const rateOfferRowsCount = rateOfferRows.length;
    let rateOfferRowsPersisted = 0;
    let rateOfferWriteTruncated = false;
    if (rateOfferRows.length) {
      const writeStart = Date.now();
      try {
        const pkgIds = Array.from(new Set(rateOfferRows.map(r => r.package_id)));
        const DEL_CHUNK = 200;
        for (let i = 0; i < pkgIds.length; i += DEL_CHUNK) {
          if (Date.now() - writeStart > OFFER_WRITE_BUDGET_MS) { rateOfferWriteTruncated = true; break; }
          await sb.from("hotel_rate_offers").delete().in("package_id", pkgIds.slice(i, i + DEL_CHUNK));
        }
        const INS_CHUNK = 200;
        for (let i = 0; i < rateOfferRows.length; i += INS_CHUNK) {
          if (Date.now() - writeStart > OFFER_WRITE_BUDGET_MS) { rateOfferWriteTruncated = true; break; }
          const slice = rateOfferRows.slice(i, i + INS_CHUNK);
          const { error: oe } = await sb.from("hotel_rate_offers").upsert(slice, { onConflict: "offer_id" });
          if (!oe) rateOfferRowsPersisted += slice.length;
        }
      } catch (e) { console.error("[start_pricing v18] rate offer persistence error:", e); }
    }

    const CHUNK = 50;
    let updated = 0;
    for (let i = 0; i < packageUpdates.length; i += CHUNK) {
      const slice = packageUpdates.slice(i, i + CHUNK);
      await Promise.all(slice.map(u => { const { package_id, ...vals } = u; return sb.from("packages").update(vals).eq("package_id", package_id); }));
      updated += slice.length;
    }

    await sb.from("search_jobs").update({ hotels_done: true, updated_at: nowIso }).eq("search_id", search_id);

    const pendingRouteCount = (insertedRoutes ?? []).filter(r => r.status === "pending").length;
    let workerDispatched = false;
    if (pendingRouteCount > 0) {
      fetch(`${supabaseUrl}/functions/v1/price_flights_worker`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceRoleKey}` },
        body: JSON.stringify({ search_id, max_routes: 10 }),
      }).catch(e => console.error("worker dispatch failed:", e));
      workerDispatched = true;
    } else {
      await sb.from("search_jobs").update({ flights_done: true, updated_at: nowIso }).eq("search_id", search_id);
    }

    let topUpDispatched = false;
    if (hotelMock > 0) {
      const tp = fetch(`${supabaseUrl}/functions/v1/top_up_hotels_worker`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceRoleKey}` },
        body: JSON.stringify({ search_id, max_pkgs: 200, depth: 0 }),
      });
      const er = (globalThis as any).EdgeRuntime;
      if (er?.waitUntil) er.waitUntil(tp.catch(e => console.error("top_up dispatch failed:", e)));
      else tp.catch(e => console.error("top_up dispatch failed:", e));
      topUpDispatched = true;
    }

    return new Response(JSON.stringify({
      version: VERSION, search_id, family: { adults, children, infants, total: familySize }, nights,
      room_party_size: roomPartySize,
      pre_filter: { applied: preFilter.willApply, candidates_before: pkgsRaw.length, candidates_after: pkgs.length, dropped, dropped_by_reason: droppedBy },
      packages_priced: updated,
      hotels: {
        ids_queried: liteapiHotelIds.length, ids_fetched: hotelDataById.size,
        batches_succeeded: hotelBatchesSucceeded, batches_attempted: hotelBatchesAttempted,
        wall_time_budget_hit: wallTimeBudgetHit, rate_limit_hit: hotelRateLimitHit, last_error: hotelLastError,
        live_priced: hotelLive, live_fallback_to_mock: hotelFallback, mock_priced: hotelMock,
        rate_offers_extracted: rateOfferRowsCount, rate_offers_persisted: rateOfferRowsPersisted, rate_offers_write_truncated: rateOfferWriteTruncated,
      },
      flights: { unique_routes: uniqueDestinations.length, cache_hits: cachedByDest.size, pending_routes: pendingRouteCount, live_priced_immediately: flightLive, mock_placeholder: flightMockPlaceholder, worker_dispatched: workerDispatched },
      top_up_dispatched: topUpDispatched,
    }, null, 2), { status: 200, headers });

  } catch (e) {
    console.error("start_pricing v18 error:", e);
    return new Response(JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }, null, 2), { status: 500, headers });
  }
});

function mockHotelTotal(r: any, nights: number, familySize: number, countryMult: Map<string, number>, resortId: string, dateStart: string): number {
  const baseNight = mockHotelNightlyTier(r?.avg_user_rating);
  const countryMul = countryMult.get(r?.country ?? "") ?? 1.0;
  let occMul = 1.0;
  if (familySize >= 7) occMul = 1.55;
  else if (familySize >= 5) occMul = 1.30;
  else if (familySize >= 3) occMul = 1.05;
  const variation = 0.85 + seededRand(`htl:${resortId}:${dateStart}`) * 0.30;
  return Math.round(baseNight * countryMul * nights * occMul * variation);
}
