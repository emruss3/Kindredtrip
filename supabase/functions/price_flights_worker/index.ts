// price_flights_worker v6 — parallel, timeout-guarded, per-route commit.
//
// v6 (2026-07-01), from the latency audit (flights gate visible trips):
//   - ATOMIC CLAIM via claim_flight_routes RPC (FOR UPDATE SKIP LOCKED) so
//     multiple workers can run in parallel without double-fetching. attempts
//     increments at claim; 'failed' routes retry up to 3 attempts; routes
//     stuck in 'fetching' >3 min are reclaimed (dead-isolate recovery).
//     v5's attempts was never incremented — its retry guards were dead code
//     and 367 failed routes in 14 days were never retried.
//   - SELF FAN-OUT: the first invocation (fan_out !== false) dispatches up
//     to 3 sibling workers over the remaining unclaimed routes, so ~40
//     routes complete in ~2 waves instead of 5 serial chain generations.
//   - CONCURRENT LEGS: outbound + return fetched in parallel (v5 was serial
//     with a 700ms sleep between). PARALLEL 3 -> 6.
//   - FETCH TIMEOUT 12s via AbortSignal (v5 had none — a hung LiteAPI call
//     stalled the whole wave; source of 36s calls and the 906s p99).
//   - PER-ROUTE COMMIT: each route persists the moment its legs return
//     (v5 fetched all routes, then persisted serially at the end).
//   - total_price contract fix: only flight+hotel sum when hotel_price is
//     non-null (v5 wrote flight-only totals for hotel-pending packages).
//   - Chain scope fix: stillPending is scoped to search_id when given (v5
//     counted globally but chained with search_id — could strand other
//     searches' routes and never set flights_done).
//   - MAX_OFFERS_PER_ROUTE 30 -> 20 (UI serves 15).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "price_flights_worker_v6_parallel_claim";
const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";
const PARALLEL = 6;
const RETRY_DELAY_MS = 1500;
const MAX_RETRIES = 2;
const MAX_OFFERS_PER_ROUTE = 20;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_SIBLINGS = 3;
const SANDBOX_FAKE_CARRIERS = new Set<string>(["ND"]);

function corsHeaders() { return { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type", "access-control-allow-methods": "POST, OPTIONS" }; }
function findApiKey() { for (const n of ["LiteAPI", "LITEAPI", "LITEAPI_SANDBOX_KEY", "LITEAPI_API_KEY"]) { const v = Deno.env.get(n); if (v && v.length > 10) return v; } return null; }
function parseDurationToMinutes(input: any) { if (input == null) return null; if (typeof input === "object") { if (Number.isFinite(input.minutes)) return Number(input.minutes); if (typeof input.iso8601 === "string") return parseIsoDurationMinutes(input.iso8601); } if (typeof input === "string") return parseIsoDurationMinutes(input); return null; }
function parseIsoDurationMinutes(s: string) { const m = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/); if (!m) return null; const h = Number(m[1] ?? 0); const min = Number(m[2] ?? 0); const total = h * 60 + min; return total > 0 ? total : null; }
function canonicalizeSegment(s: any, forceDirection: "outbound" | "return") { const origin = String(s?.originCode ?? ""); const dest = String(s?.destinationCode ?? ""); const dep = s?.departureTime; const arr = s?.arrivalTime; if (!origin || !dest || !dep || !arr) return null; return { direction: forceDirection, segment_key: s?.segmentKey ?? null, origin_iata: origin, origin_name: s?.originName ?? null, destination_iata: dest, destination_name: s?.destinationName ?? null, departure_time: dep, arrival_time: arr, duration_minutes: parseDurationToMinutes(s?.duration), marketing_airline_code: s?.carrier?.marketingCode ?? null, marketing_airline_name: s?.carrier?.marketingName ?? null, operating_airline_code: s?.carrier?.operatingCode ?? null, operating_airline_name: s?.carrier?.operatingName ?? null, flight_number: s?.flight?.marketingNumber ?? s?.flight?.operatingNumber ?? null }; }
function amenityFlags(segmentAmenities: any[] | undefined) { const perSegment = new Map<string, any>(); const out: any = { has_wifi: null, has_power: null, has_entertainment: null, per_segment: perSegment }; if (!Array.isArray(segmentAmenities) || segmentAmenities.length === 0) return out; let anyWifi = false, anyPower = false, anyEnt = false; for (const sa of segmentAmenities) { const segKey = sa?.segmentKey ?? ""; const ac = sa?.aircraftType ?? null; let segWifi = false, segPower = false, segEnt = false; let pitchInches: number | null = null; for (const a of sa?.amenities ?? []) { if (!a?.available) continue; const cat = String(a?.category ?? ""); if (cat === "wifi") { anyWifi = true; segWifi = true; } if (cat === "power") { anyPower = true; segPower = true; } if (cat === "entertainment") { anyEnt = true; segEnt = true; } if (cat === "seat_comfort" && typeof a?.details === "string") { const m = a.details.match(/(\d+)\s*inch/); if (m) pitchInches = Number(m[1]); } } if (segKey) perSegment.set(segKey, { wifi: segWifi, power: segPower, entertainment: segEnt, seat_pitch_inches: pitchInches, aircraft: ac }); } out.has_wifi = anyWifi ? true : null; out.has_power = anyPower ? true : null; out.has_entertainment = anyEnt ? true : null; return out; }
function isFakeSandboxOffer(primaryCode: string | null, airlineCodes: string[]) { if (primaryCode && SANDBOX_FAKE_CARRIERS.has(primaryCode)) return true; if (airlineCodes.length > 0 && airlineCodes.every(c => SANDBOX_FAKE_CARRIERS.has(c))) return true; return false; }
function extractLegOptions(data: any, direction: "outbound" | "return", options: { includeSandboxCarriers?: boolean } = {}) {
  const out: any[] = []; let rawCount = 0;
  if (!Array.isArray(data?.data)) return { options: out, rawCount };
  for (const item of data.data) {
    for (const journey of (item?.journeys ?? [])) {
      const jSegmentsRaw: any[] = Array.isArray(journey?.segments) ? journey.segments : [];
      const segs: any[] = [];
      for (const s of jSegmentsRaw) { const c = canonicalizeSegment(s, direction); if (c) segs.push(c); }
      if (segs.length === 0) continue;
      for (const offer of (journey?.offers ?? [])) {
        rawCount++;
        const display = offer?.pricing?.display;
        const price = Number(display?.total ?? 0);
        const offerId = String(offer?.offerId ?? "");
        if (!price || !offerId) continue;
        const amen = amenityFlags(offer?.segmentAmenities);
        const allAirlines: string[] = [];
        for (const s of segs) { const c = s.marketing_airline_code; if (c && !allAirlines.includes(c)) allAirlines.push(c); }
        let longest = segs[0];
        for (const s of segs) { if ((s.duration_minutes ?? 0) > (longest.duration_minutes ?? 0)) longest = s; }
        const primaryCode = longest.marketing_airline_code;
        const primaryName = longest.marketing_airline_name;
        if (!options.includeSandboxCarriers && isFakeSandboxOffer(primaryCode, allAirlines)) continue;
        const first = segs[0], last = segs[segs.length - 1];
        const stops = segs.length - 1;
        let depHour: number | null = null;
        try { depHour = new Date(first.departure_time).getUTCHours(); } catch {}
        let layoverTotal = 0;
        const layoverAirports: string[] = [];
        for (let i = 0; i < segs.length - 1; i++) {
          const arr = new Date(segs[i].arrival_time).getTime();
          const dep = new Date(segs[i + 1].departure_time).getTime();
          if (Number.isFinite(arr) && Number.isFinite(dep) && dep > arr) layoverTotal += Math.round((dep - arr) / 60000);
          layoverAirports.push(segs[i].destination_iata);
        }
        const segDur = segs.map(s => s.duration_minutes ?? 0).reduce((a, b) => a + b, 0);
        const aircraftTypes: string[] = [];
        for (const s of segs) { const a = amen.per_segment.get(s.segment_key ?? "")?.aircraft; if (a && !aircraftTypes.includes(a)) aircraftTypes.push(a); }
        const enrichedSegs = segs.map(s => { const sa = amen.per_segment.get(s.segment_key ?? ""); return { ...s, aircraft_type: sa?.aircraft ?? null, has_wifi: sa?.wifi ?? null, has_power: sa?.power ?? null, has_entertainment: sa?.entertainment ?? null, seat_pitch_inches: sa?.seat_pitch_inches ?? null }; });
        out.push({
          price, currency: String(display?.currency ?? "USD"),
          refundable: offer?.terms?.refundable ?? null,
          carry_on_included: offer?.baggage?.hasCarryOnBag ?? null,
          checked_bag_included: offer?.baggage?.hasCheckedBag ?? null,
          fare_family: offer?.fare?.family ?? null,
          provider: offer?.provider?.code ?? null,
          expires_at: offer?.expiration ?? null,
          raw_offer: offer,
          duration_minutes: segDur > 0 ? segDur + layoverTotal : null,
          stops, departure_time: first.departure_time, arrival_time: last.arrival_time,
          departure_hour: depHour,
          layover_minutes: stops > 0 ? layoverTotal : null,
          layover_airports: layoverAirports, aircraft_types: aircraftTypes,
          primary_airline_code: primaryCode, primary_airline_name: primaryName,
          airline_codes: allAirlines,
          has_wifi: amen.has_wifi, has_power: amen.has_power, has_entertainment: amen.has_entertainment,
          segments: enrichedSegs, source_offer_id: offerId,
        });
      }
    }
  }
  return { options: out, rawCount };
}
async function fetchLeg(apiKey: string, origin: string, destination: string, date: string, adults: number, children: number, infants: number, direction: "outbound" | "return", options: { includeSandboxCarriers?: boolean } = {}) {
  const body: any = { legs: [{ origin, destination, date }], adults, currency: "USD", cabinClass: "ECONOMY" };
  if (children > 0) body.children = children;
  if (infants > 0) body.infants = infants;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // v6: hard timeout — a hung LiteAPI call must not stall the wave.
      const r = await fetch(`${LITEAPI_BASE}/flights/rates`, { method: "POST", headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (r.status === 429) { await new Promise(rs => setTimeout(rs, RETRY_DELAY_MS * (attempt + 1))); continue; }
      if (!r.ok) { const t = await r.text(); return { options: [], rawCount: 0, status: r.status, error: t.slice(0, 200) }; }
      const data = await r.json();
      const { options: opts, rawCount } = extractLegOptions(data, direction, options);
      return { options: opts, rawCount, status: r.status };
    } catch (e) { return { options: [], rawCount: 0, status: 0, error: String((e as any)?.message ?? e) }; }
  }
  return { options: [], rawCount: 0, status: 429, error: "rate limit exhausted" };
}
function shortHash(s: string) { let h1 = 0x811c9dc5, h2 = 0x01000193; for (let i = 0; i < s.length; i++) { h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 0x01000193); h2 ^= s.charCodeAt(s.length - 1 - i); h2 = Math.imul(h2, 0x01000193); } const u = (n: number) => (n >>> 0).toString(16).padStart(8, "0"); return u(h1) + u(h2); }
function buildPairedOffers(routeId: string, outbound: any[], ret: any[]) {
  if (outbound.length === 0) return [];
  const outSorted = [...outbound].sort((a, b) => a.price - b.price).slice(0, MAX_OFFERS_PER_ROUTE);
  const retSorted = ret.length ? [...ret].sort((a, b) => a.price - b.price) : [];
  const cheapestReturn = retSorted[0] ?? null;
  return outSorted.map((o) => {
    const r = cheapestReturn;
    const basis = r ? "summed_oneway" : "oneway_outbound";
    const total = r ? o.price + r.price : o.price;
    const segs: any[] = [];
    o.segments.forEach((s: any, i: number) => segs.push({ ...s, segment_order: i }));
    if (r) r.segments.forEach((s: any, i: number) => segs.push({ ...s, segment_order: i }));
    const airline_codes = Array.from(new Set([...o.airline_codes, ...(r ? r.airline_codes : [])]));
    const maxLayover = Math.max(o.layover_minutes ?? 0, r ? (r.layover_minutes ?? 0) : 0);
    const totalDur = (o.duration_minutes ?? 0) + (r ? (r.duration_minutes ?? 0) : 0);
    const pairKey = `${o.source_offer_id}|${r ? r.source_offer_id : "NORET"}`;
    return {
      offer_id: `rt_${shortHash(routeId + "|" + pairKey)}`,
      total_price: total, outbound_price: o.price, return_price: r ? r.price : null,
      price_basis: basis, currency: o.currency,
      refundable: (o.refundable === true && (r ? r.refundable === true : false)) ? true : ((o.refundable === false || (r && r.refundable === false)) ? false : null),
      carry_on_included: (o.carry_on_included && (r ? r.carry_on_included : true)) ?? null,
      checked_bag_included: (o.checked_bag_included && (r ? r.checked_bag_included : true)) ?? null,
      fare_family: o.fare_family, provider: o.provider, expires_at: o.expires_at,
      raw_offer: { outbound: o.raw_offer, return: r ? r.raw_offer : null, price_basis: basis },
      total_duration_minutes: totalDur > 0 ? totalDur : null,
      outbound_duration_minutes: o.duration_minutes, return_duration_minutes: r ? r.duration_minutes : null,
      outbound_stops: o.stops, return_stops: r ? r.stops : null,
      outbound_departure_time: o.departure_time, outbound_arrival_time: o.arrival_time,
      return_departure_time: r ? r.departure_time : null, return_arrival_time: r ? r.arrival_time : null,
      outbound_departure_hour: o.departure_hour, return_departure_hour: r ? r.departure_hour : null,
      primary_airline_code: o.primary_airline_code, primary_airline_name: o.primary_airline_name, airline_codes,
      outbound_layover_minutes: o.layover_minutes, outbound_layover_airports: o.layover_airports,
      return_layover_minutes: r ? r.layover_minutes : null, return_layover_airports: r ? r.layover_airports : [],
      max_layover_minutes: maxLayover > 0 ? maxLayover : null,
      outbound_aircraft_types: o.aircraft_types, return_aircraft_types: r ? r.aircraft_types : [],
      has_wifi: (o.has_wifi || (r ? r.has_wifi : null)) ?? null,
      has_power: (o.has_power || (r ? r.has_power : null)) ?? null,
      has_entertainment: (o.has_entertainment || (r ? r.has_entertainment : null)) ?? null,
      segments: segs,
    };
  });
}
function pickRollups(offers: any[]) { const sorted = [...offers].sort((a, b) => a.total_price - b.total_price); const cheapest = sorted[0] ?? null; const cheapestNonstop = sorted.find(o => o.outbound_stops === 0 && (o.return_stops === 0 || o.return_stops == null)) ?? null; const cheapestRefundable = sorted.find(o => o.refundable === true) ?? null; return { cheapest, cheapestNonstop, cheapestRefundable }; }

Deno.serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ version: VERSION, error: "POST only" }), { status: 405, headers });
  const tStart = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const search_id: string | null = body.search_id ?? null;
    const max_routes = Math.min(Number(body.max_routes ?? 10), 12);
    const fanOut = body.fan_out !== false; // only the first invocation fans
    const includeSandboxCarriers = body.include_sandbox_carriers === true;
    const apiKey = findApiKey();
    if (!apiKey) throw new Error("LiteAPI key missing");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    // v6: atomic claim (FOR UPDATE SKIP LOCKED) — safe under parallel workers.
    const { data: pending, error: pErr } = await sb.rpc("claim_flight_routes", { p_search_id: search_id, p_limit: max_routes });
    if (pErr) throw pErr;
    if (!pending?.length) return new Response(JSON.stringify({ version: VERSION, processed: 0, message: "no claimable routes" }, null, 2), { status: 200, headers });

    // v6: SELF FAN-OUT — dispatch siblings over remaining unclaimed routes.
    let siblingsDispatched = 0;
    if (fanOut) {
      let remQ = sb.from("flight_search_routes").select("*", { count: "exact", head: true })
        .in("status", ["pending", "failed"]).lt("attempts", 3);
      if (search_id) remQ = remQ.eq("search_id", search_id);
      const { count: remaining } = await remQ;
      const siblings = Math.min(MAX_SIBLINGS, Math.ceil((remaining ?? 0) / max_routes));
      const er = (globalThis as any).EdgeRuntime;
      for (let i = 0; i < siblings; i++) {
        const f = fetch(`${supabaseUrl}/functions/v1/price_flights_worker`, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
          body: JSON.stringify({ search_id, max_routes, fan_out: false }),
        });
        if (er?.waitUntil) er.waitUntil(f.catch((e: any) => console.error("sibling dispatch failed:", e)));
        else f.catch((e: any) => console.error("sibling dispatch failed:", e));
        siblingsDispatched++;
      }
    }

    let totalOffers = 0, totalSegments = 0;
    let routesDone = 0, routesFailed = 0, routesNoOffers = 0;
    let routesTwoLeg = 0, routesOnewayOnly = 0;
    const errors: string[] = [];

    // v6: per-route fetch AND persist inside one closure — a route commits the
    // moment its legs return, instead of waiting for the whole call.
    const processRoute = async (route: any) => {
      // Concurrent legs (v5 was serial with a 700ms sleep).
      const [outRes, retRes] = await Promise.all([
        fetchLeg(apiKey, route.origin_iata, route.dest_iata, route.departure_date, route.adults, route.children, route.infants, "outbound", { includeSandboxCarriers }),
        route.return_date
          ? fetchLeg(apiKey, route.dest_iata, route.origin_iata, route.return_date, route.adults, route.children, route.infants, "return", { includeSandboxCarriers })
          : Promise.resolve({ options: [] as any[], rawCount: 0, status: 200 } as any),
      ]);
      if (outRes.error || outRes.options.length === 0) {
        if (outRes.error) {
          errors.push(`${route.dest_iata}: ${outRes.error}`);
          await sb.from("flight_search_routes").update({ status: "failed", last_error: `${outRes.status}: ${outRes.error}`, fetched_at: new Date().toISOString() }).eq("route_id", route.route_id);
          routesFailed++;
        } else {
          await sb.from("flight_search_routes").update({ status: "no_offers", fetched_at: new Date().toISOString() }).eq("route_id", route.route_id);
          routesNoOffers++;
        }
        return;
      }
      const paired = buildPairedOffers(route.route_id, outRes.options, retRes.options ?? []);
      if (!paired.length) {
        await sb.from("flight_search_routes").update({ status: "no_offers", fetched_at: new Date().toISOString() }).eq("route_id", route.route_id);
        routesNoOffers++;
        return;
      }
      const anySummed = paired.some((p: any) => p.price_basis === "summed_oneway");
      if (anySummed) routesTwoLeg++; else routesOnewayOnly++;
      const offerRows = paired.map((o: any) => ({
        offer_id: o.offer_id, route_id: route.route_id, journey_index: 0, offer_index: 0,
        total_price: o.total_price, outbound_price: o.outbound_price, return_price: o.return_price,
        price_basis: o.price_basis, currency: o.currency, fare_family: o.fare_family, provider: o.provider,
        refundable: o.refundable, carry_on_included: o.carry_on_included, checked_bag_included: o.checked_bag_included,
        expires_at: o.expires_at, raw_offer: o.raw_offer,
        total_duration_minutes: o.total_duration_minutes,
        outbound_duration_minutes: o.outbound_duration_minutes, return_duration_minutes: o.return_duration_minutes,
        outbound_stops: o.outbound_stops, return_stops: o.return_stops,
        outbound_departure_time: o.outbound_departure_time, outbound_arrival_time: o.outbound_arrival_time,
        return_departure_time: o.return_departure_time, return_arrival_time: o.return_arrival_time,
        outbound_departure_hour: o.outbound_departure_hour, return_departure_hour: o.return_departure_hour,
        primary_airline_code: o.primary_airline_code, primary_airline_name: o.primary_airline_name, airline_codes: o.airline_codes,
        outbound_layover_minutes: o.outbound_layover_minutes, outbound_layover_airports: o.outbound_layover_airports,
        return_layover_minutes: o.return_layover_minutes, return_layover_airports: o.return_layover_airports,
        max_layover_minutes: o.max_layover_minutes,
        outbound_aircraft_types: o.outbound_aircraft_types, return_aircraft_types: o.return_aircraft_types,
        has_wifi: o.has_wifi, has_power: o.has_power, has_entertainment: o.has_entertainment,
      }));
      await sb.from("flight_offers").delete().eq("route_id", route.route_id);
      const { error: oErr } = await sb.from("flight_offers").upsert(offerRows, { onConflict: "offer_id" });
      if (oErr) {
        errors.push(`offer upsert ${route.dest_iata}: ${oErr.message}`);
        await sb.from("flight_search_routes").update({ status: "failed", last_error: `offers upsert: ${oErr.message}` }).eq("route_id", route.route_id);
        routesFailed++;
        return;
      }
      totalOffers += offerRows.length;
      const segmentRows: any[] = [];
      for (const o of paired) {
        for (const s of o.segments) {
          segmentRows.push({
            offer_id: o.offer_id, direction: s.direction, segment_order: s.segment_order, segment_key: s.segment_key,
            origin_iata: s.origin_iata, origin_name: s.origin_name, destination_iata: s.destination_iata, destination_name: s.destination_name,
            departure_time: s.departure_time, arrival_time: s.arrival_time, duration_minutes: s.duration_minutes,
            marketing_airline_code: s.marketing_airline_code, marketing_airline_name: s.marketing_airline_name,
            operating_airline_code: s.operating_airline_code, operating_airline_name: s.operating_airline_name,
            flight_number: s.flight_number, aircraft_type: s.aircraft_type,
            has_wifi: s.has_wifi, has_power: s.has_power, has_entertainment: s.has_entertainment, seat_pitch_inches: s.seat_pitch_inches,
          });
        }
      }
      if (segmentRows.length) { const ids = paired.map((p: any) => p.offer_id); await sb.from("flight_offer_segments").delete().in("offer_id", ids); const { error: sErr } = await sb.from("flight_offer_segments").insert(segmentRows); if (sErr) console.error("segment insert error:", sErr.message); else totalSegments += segmentRows.length; }
      const { cheapest, cheapestNonstop, cheapestRefundable } = pickRollups(paired);
      await sb.from("flight_search_routes").update({
        status: "done", offers_count: paired.length,
        cheapest_offer_id: cheapest?.offer_id ?? null, cheapest_total: cheapest?.total_price ?? null,
        cheapest_nonstop_offer_id: cheapestNonstop?.offer_id ?? null, cheapest_nonstop_total: cheapestNonstop?.total_price ?? null,
        cheapest_refundable_offer_id: cheapestRefundable?.offer_id ?? null, cheapest_refundable_total: cheapestRefundable?.total_price ?? null,
        fetched_at: new Date().toISOString(),
      }).eq("route_id", route.route_id);
      if (cheapest) {
        const { data: routePackages } = await sb.from("packages").select("package_id, hotel_price").eq("flight_route_id", route.route_id);
        if (routePackages?.length) {
          const cp = Number(cheapest.total_price);
          const updates = routePackages.map((p: any) => ({
            package_id: p.package_id,
            flight_offer_id: cheapest.offer_id, flight_offer_count: paired.length,
            flight_price: cp,
            flight_outbound_price: cheapest.outbound_price, flight_return_price: cheapest.return_price,
            flight_price_basis: cheapest.price_basis,
            // v6 no-mock contract: total only when BOTH legs are live.
            total_price: p.hotel_price != null ? cp + Number(p.hotel_price) : null,
            duration_hours: cheapest.total_duration_minutes ? Number((cheapest.total_duration_minutes / 60).toFixed(1)) : null,
            flight_supplier: "liteapi", flight_priced_at: new Date().toISOString(),
          }));
          for (let i = 0; i < updates.length; i += 50) {
            const slice = updates.slice(i, i + 50);
            await Promise.all(slice.map((u: any) => { const { package_id, ...vals } = u; return sb.from("packages").update(vals).eq("package_id", package_id); }));
          }
        }
      }
      routesDone++;
    };

    for (let i = 0; i < pending.length; i += PARALLEL) {
      const batch = pending.slice(i, i + PARALLEL);
      await Promise.all(batch.map((route: any) => processRoute(route).catch((e) => {
        errors.push(`${route.dest_iata}: ${String((e as any)?.message ?? e)}`);
      })));
    }

    // v6: chain scoped to search_id when given (v5 counted globally).
    let stillQ = sb.from("flight_search_routes").select("*", { count: "exact", head: true })
      .in("status", ["pending", "failed"]).lt("attempts", 3);
    if (search_id) stillQ = stillQ.eq("search_id", search_id);
    const { count: stillPending } = await stillQ;
    let chained = false;
    if (stillPending && stillPending > 0) {
      const cf = fetch(`${supabaseUrl}/functions/v1/price_flights_worker`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` }, body: JSON.stringify({ search_id, max_routes, fan_out: false }) });
      const er = (globalThis as any).EdgeRuntime;
      if (er?.waitUntil) er.waitUntil(cf.catch((e: any) => console.error("chain failed:", e)));
      else cf.catch((e: any) => console.error("chain failed:", e));
      chained = true;
    }
    if (search_id) {
      const { count: notDone } = await sb.from("flight_search_routes").select("*", { count: "exact", head: true }).eq("search_id", search_id).in("status", ["pending", "fetching"]);
      if (!notDone) await sb.from("search_jobs").update({ flights_done: true, updated_at: new Date().toISOString() }).eq("search_id", search_id);
    }
    return new Response(JSON.stringify({
      version: VERSION, elapsed_ms: Date.now() - tStart,
      processed: pending.length, routes_done: routesDone, routes_failed: routesFailed, routes_no_offers: routesNoOffers,
      routes_two_leg_priced: routesTwoLeg, routes_oneway_only: routesOnewayOnly,
      total_offers_stored: totalOffers, total_segments_stored: totalSegments,
      siblings_dispatched: siblingsDispatched,
      still_pending: stillPending, chained, errors: errors.slice(0, 5),
    }, null, 2), { status: 200, headers });
  } catch (e) {
    console.error("price_flights_worker v6 error:", e);
    return new Response(JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }, null, 2), { status: 500, headers });
  }
});
