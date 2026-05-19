// recache_room_mapping
//
// One-time-ish migration worker. Re-fetches /hotels/rates with
// roomMapping:true for any package that has cached hotel_rate_offers
// rows missing mapped_room_id. Overwrites those rows. Chains itself
// until the backlog clears.
//
// Why a separate worker (vs widening top_up_hotels_worker): cleanly
// disposable. Delete this slug once coverage is acceptable.
//
// POST /functions/v1/recache_room_mapping
//   { max_pkgs?: 100, depth?: 0, search_id?: <optional, scope to one search> }
//
// All credit to top_up_hotels_worker v4 for the extractor & write
// pattern — this file copies that logic verbatim and only changes the
// package-selection filter and self-chain depth cap.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "recache_room_mapping_v1_2_scoped_offer_id";
const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";
const HOTEL_BATCH_SIZE = 25;
const HOTEL_BATCH_CONCURRENCY = 2;
const MAX_OFFERS_PER_PACKAGE = 12;
const LITEAPI_TIMEOUT_S = 4;
const WALL_CLOCK_BUDGET_MS = 35_000;
const OFFER_WRITE_BUDGET_MS = 10_000;
const DEFAULT_MAX_PKGS = 100;
const MAX_CHAIN_DEPTH = 24;  // higher than top_up — this is a big backlog

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

// Identical to top_up_hotels_worker v4 extractor.
function extractRateOffers(hotel: any, hotelId: string, nights: number): any[] {
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
      // Hash includes a package-specific salt below (set by the caller).
      // Two packages sharing a hotel + dates + occupancy would otherwise
      // produce identical offer_ids and collide on the offer_id PK in the
      // upsert batch.
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

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ version: VERSION, error: "POST only" }), { status: 405, headers });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const max_pkgs = Number(body.max_pkgs ?? DEFAULT_MAX_PKGS);
    const depth = Number(body.depth ?? 0);
    const scopeSearchId: string | null = body.search_id ?? null;

    const apiKey = findApiKey();
    if (!apiKey) throw new Error("LiteAPI key missing");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    // Find packages whose offers have NULL mapped_room_id. We scope to
    // future-dated searches only — past dates won't return inventory.
    let query = sb
      .from("packages")
      .select(`
        package_id, search_id, resort_id, flight_price,
        searches!inner ( date_start, date_end, adults, child_ages ),
        resorts!inner ( liteapi_hotel_id )
      `)
      .eq("hotel_supplier", "liteapi")
      .not("resorts.liteapi_hotel_id", "is", null)
      .gte("searches.date_start", new Date(Date.now() + 86400_000).toISOString().slice(0, 10))
      .limit(max_pkgs);
    if (scopeSearchId) query = query.eq("search_id", scopeSearchId);

    const { data: candidates, error: pErr } = await query;
    if (pErr) throw pErr;

    if (!candidates || candidates.length === 0) {
      return new Response(JSON.stringify({ version: VERSION, depth, processed: 0, done: true }), { status: 200, headers });
    }

    // Filter to only packages that ACTUALLY have stale offers
    // (mapped_room_id is null on at least one cached row).
    const pkgIds = candidates.map((c: any) => c.package_id);
    const { data: staleRows } = await sb
      .from("hotel_rate_offers")
      .select("package_id")
      .in("package_id", pkgIds)
      .is("mapped_room_id", null);
    const stalePkgIds = new Set((staleRows ?? []).map((r: any) => r.package_id));
    const targetPkgs = candidates.filter((c: any) => stalePkgIds.has(c.package_id));

    if (targetPkgs.length === 0) {
      return new Response(JSON.stringify({
        version: VERSION, depth, processed: 0, done: true, no_stale_in_window: true,
      }), { status: 200, headers });
    }

    // Group packages by their LiteAPI hotel id so each /hotels/rates
    // batch is densely packed.
    const idToPackages = new Map<string, any[]>();
    for (const p of targetPkgs) {
      const id = (p as any).resorts.liteapi_hotel_id;
      if (!idToPackages.has(id)) idToPackages.set(id, []);
      idToPackages.get(id)!.push(p);
    }

    // Each (hotelId, dateRange, occupancy) is a distinct rates call — we
    // collapse by an identity key so identical-shape requests fan into
    // one API call.
    type Job = {
      requestKey: string;
      hotelId: string;
      checkin: string;
      checkout: string;
      adults: number;
      childrenAges: number[];
      pkgs: any[];
    };
    const jobs = new Map<string, Job>();
    for (const [hotelId, pkgs] of idToPackages.entries()) {
      for (const p of pkgs as any[]) {
        const s = p.searches;
        const childAges = parseChildAges(s.child_ages);
        const olderChildAges = childAges.filter((a) => a >= 2);
        const requestKey = `${hotelId}|${s.date_start}|${s.date_end}|${s.adults}:${olderChildAges.sort().join(",")}`;
        if (!jobs.has(requestKey)) {
          jobs.set(requestKey, {
            requestKey, hotelId,
            checkin: s.date_start, checkout: s.date_end,
            adults: Number(s.adults), childrenAges: olderChildAges,
            pkgs: [],
          });
        }
        jobs.get(requestKey)!.pkgs.push(p);
      }
    }

    const jobsList = Array.from(jobs.values());

    // Wave through the jobs respecting the wall-clock budget. Each job
    // is a single /hotels/rates call (1 hotel — same as the worker
    // pattern but we keep batches=1 because each job has its own dates
    // and occupancy).
    let batchesAttempted = 0, batchesSucceeded = 0;
    let lastError: string | undefined;
    let wallTimeBudgetHit = false;
    let rateLimitHit = false;
    const loopStart = Date.now();
    const hotelData = new Map<string, { hotels: Map<string, any>; pkgs: any[] }>();

    for (let i = 0; i < jobsList.length; i += HOTEL_BATCH_CONCURRENCY) {
      if (Date.now() - loopStart > WALL_CLOCK_BUDGET_MS) { wallTimeBudgetHit = true; break; }
      const wave = jobsList.slice(i, i + HOTEL_BATCH_CONCURRENCY);
      batchesAttempted += wave.length;
      const results = await Promise.all(
        wave.map((j) =>
          fetchHotelRatesBatch(apiKey, [j.hotelId], j.checkin, j.checkout, [{ adults: j.adults, children: j.childrenAges }])
            .then((r) => ({ j, r }))
        )
      );
      let hit429 = false;
      for (const { j, r } of results) {
        if (r.error) {
          lastError = r.error;
          if (r.status === 429) hit429 = true;
        } else {
          batchesSucceeded++;
          for (const h of r.hotels) {
            const id = String(h?.hotelId ?? "");
            if (id !== j.hotelId) continue;
            if (!hotelData.has(j.requestKey)) {
              hotelData.set(j.requestKey, { hotels: new Map(), pkgs: j.pkgs });
            }
            hotelData.get(j.requestKey)!.hotels.set(id, h);
          }
        }
      }
      if (hit429) { rateLimitHit = true; break; }
    }

    // Build per-package rate offers from the freshly-fetched hotel data.
    const rateOfferRows: any[] = [];
    const packageHotelTotals: Array<{ package_id: string; hotel_price: number; hotel_offer_id: string | null; }> = [];
    let upgraded = 0;

    for (const [requestKey, payload] of hotelData.entries()) {
      const j = jobs.get(requestKey)!;
      const h = payload.hotels.get(j.hotelId);
      if (!h) continue;
      const nights = nightsBetween(j.checkin, j.checkout);
      const offers = extractRateOffers(h, j.hotelId, nights);
      if (offers.length === 0) continue;
      offers.sort((a, b) => a.total_price - b.total_price);
      const top = offers.slice(0, MAX_OFFERS_PER_PACKAGE);
      for (const p of payload.pkgs) {
        upgraded++;
        // Scope offer_id by package so cross-search/cross-package batches
        // don't collide on the PK. hotel_rate_offers.offer_id is the
        // primary key — two packages at the same hotel + dates would
        // otherwise produce identical offer_ids and trigger
        // "ON CONFLICT DO UPDATE command cannot affect row a second time".
        const scoped = (raw: string) => `${p.package_id.slice(0, 8)}_${raw}`;
        const chosen = top[0];
        if (chosen) {
          packageHotelTotals.push({
            package_id: p.package_id,
            hotel_price: Math.round(chosen.total_price),
            hotel_offer_id: scoped(chosen.offer_id),
          });
        }
        for (const o of top) {
          rateOfferRows.push({
            offer_id: scoped(o.offer_id),
            package_id: p.package_id,
            resort_id: p.resort_id,
            liteapi_hotel_id: j.hotelId,
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
    }

    // Persist: replace offers for affected packages, then update package
    // hotel_price / hotel_offer_id (preserve flight_price; recompute total).
    let offersPersisted = 0;
    let offerWriteTruncated = false;
    const upsertErrors: string[] = [];
    if (rateOfferRows.length) {
      const writeStart = Date.now();
      try {
        const pkgIdsAffected = Array.from(new Set(rateOfferRows.map((r) => r.package_id)));
        for (let i = 0; i < pkgIdsAffected.length; i += 200) {
          if (Date.now() - writeStart > OFFER_WRITE_BUDGET_MS) { offerWriteTruncated = true; break; }
          await sb.from("hotel_rate_offers").delete().in("package_id", pkgIdsAffected.slice(i, i + 200));
        }
        for (let i = 0; i < rateOfferRows.length; i += 200) {
          if (Date.now() - writeStart > OFFER_WRITE_BUDGET_MS) { offerWriteTruncated = true; break; }
          const slice = rateOfferRows.slice(i, i + 200);
          const { error: oe } = await sb.from("hotel_rate_offers").upsert(slice, { onConflict: "offer_id" });
          if (!oe) {
            offersPersisted += slice.length;
          } else {
            if (upsertErrors.length < 3) upsertErrors.push(String(oe?.message ?? oe));
            console.error("[recache_room_mapping] upsert error:", oe);
          }
        }
      } catch (e) {
        upsertErrors.push(`THROWN: ${String((e as any)?.message ?? e)}`);
        console.error("[recache_room_mapping] offer persistence error:", e);
      }
    }

    if (packageHotelTotals.length) {
      const ids = packageHotelTotals.map((u) => u.package_id);
      const { data: existing } = await sb.from("packages")
        .select("package_id, flight_price").in("package_id", ids);
      const flightByPkg = new Map<string, number>();
      for (const e of existing ?? []) flightByPkg.set(e.package_id, Number(e.flight_price ?? 0));
      const CHUNK = 50;
      for (let i = 0; i < packageHotelTotals.length; i += CHUNK) {
        const slice = packageHotelTotals.slice(i, i + CHUNK);
        await Promise.all(slice.map((u) => {
          const fp = flightByPkg.get(u.package_id) ?? 0;
          const total = fp + Number(u.hotel_price);
          return sb.from("packages").update({
            hotel_price: u.hotel_price,
            hotel_offer_id: u.hotel_offer_id,
            cheapest_offer_id: u.hotel_offer_id,
            total_price: total,
            hotel_priced_at: new Date().toISOString(),
          }).eq("package_id", u.package_id);
        }));
      }
    }

    // Chain self if more stale packages remain and we haven't hit the
    // depth cap. Scope passes through (so a per-search recache stays
    // narrow).
    let chained = false;
    if (depth + 1 < MAX_CHAIN_DEPTH) {
      let staleCheck = sb.from("hotel_rate_offers").select("package_id", { count: "exact", head: true }).is("mapped_room_id", null);
      if (scopeSearchId) {
        const { data: scopePkgs } = await sb.from("packages").select("package_id").eq("search_id", scopeSearchId);
        const ids = (scopePkgs ?? []).map((r: any) => r.package_id);
        if (ids.length > 0) staleCheck = staleCheck.in("package_id", ids);
      }
      const { count: remaining } = await staleCheck;
      if ((remaining ?? 0) > 0) {
        const next = fetch(`${supabaseUrl}/functions/v1/recache_room_mapping`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
          body: JSON.stringify({ max_pkgs: DEFAULT_MAX_PKGS, depth: depth + 1, search_id: scopeSearchId }),
        });
        const er = (globalThis as any).EdgeRuntime;
        if (er?.waitUntil) er.waitUntil(next.catch((e) => console.error("[recache] chain:", e)));
        else next.catch((e) => console.error("[recache] chain:", e));
        chained = true;
      }
    }

    return new Response(JSON.stringify({
      version: VERSION,
      depth,
      scope_search_id: scopeSearchId,
      candidates: candidates.length,
      stale_candidates: targetPkgs.length,
      jobs: jobsList.length,
      batches_attempted: batchesAttempted,
      batches_succeeded: batchesSucceeded,
      upgraded,
      offers_persisted: offersPersisted,
      offer_write_truncated: offerWriteTruncated,
      upsert_errors: upsertErrors,
      rate_offer_rows_built: rateOfferRows.length,
      wall_time_budget_hit: wallTimeBudgetHit,
      rate_limit_hit: rateLimitHit,
      last_error: lastError,
      chained,
    }), { status: 200, headers });

  } catch (e) {
    return new Response(JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }), { status: 500, headers });
  }
});
