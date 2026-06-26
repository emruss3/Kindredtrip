import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "process_search_batch_v21_mapped_only";

// v20 (2026-06-23): infant-aware fixes.
//   - roomFamilySize (adults + kids>=2) drives the coarse occupancy gate so
//     infants (<2) aren't counted toward room occupancy.
//   - cap_child_allowed=false is unreliable data (310/597 family resorts have
//     it, 218 with kids clubs); only drop an infant family's resort when the
//     no-children signal is corroborated (no kids-club AND not Family).
// v18: dropped audience='Family' pre-filter; hard-block 'Adults Only' w/ flag.
// v17: single-resort scope bypass. v16: respect service_excluded.

const HARD_BLOCKED_COUNTRIES: string[] = ["Brazil"];
const DEFAULT_EXCLUDED_COUNTRIES: string[] = ["Cuba"];

const RESORT_COLS = `
  resort_id, resort_name, country, area, airport_iata, airport_code,
  audience,
  avg_user_rating, cap_star_rating, value_ratio, direct_usd_2026,
  direct_flight, guaranteed_connecting_rooms, amenities_text,
  cap_has_kids_club, kids_club_available, cap_facilities,
  cap_max_room_occupancy, cap_has_connecting, cap_has_suite,
  cap_has_villa, cap_child_allowed, cap_fetched_at
`;

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

function hasKidsClubSignal(r: any): boolean {
  if (r.cap_has_kids_club === true) return true;
  if (r.kids_club_available === true) return true;
  if (typeof r.amenities_text === "string" && /kids\s+club/i.test(r.amenities_text)) return true;
  if (Array.isArray(r.cap_facilities)) {
    for (const f of r.cap_facilities) {
      if (typeof f === "string" && /child(ren)?'?s\s+club|supervised\s+childcare/i.test(f)) return true;
    }
  }
  if (r.cap_fetched_at == null) return true;
  return false;
}

function isAdultsOnly(r: any): boolean {
  return typeof r.audience === "string" && r.audience.trim().toLowerCase() === "adults only";
}

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { status: 200 });
    if (req.method !== "POST") return new Response("Use POST", { status: 405 });

    const body = await req.json();
    const search_id = body.search_id as string;
    const excluded_countries: string[] = Array.isArray(body.excluded_countries) ? body.excluded_countries : [];
    const included_countries: string[] | null = Array.isArray(body.included_countries) && body.included_countries.length > 0
      ? body.included_countries
      : null;
    const included_resort_ids: string[] | null = Array.isArray(body.included_resort_ids) && body.included_resort_ids.length > 0
      ? body.included_resort_ids.filter((x: any) => typeof x === "string" && /^[0-9a-fA-F-]{36}$/.test(x))
      : null;
    const scoped = !!(included_resort_ids && included_resort_ids.length);

    if (!search_id) {
      return new Response(JSON.stringify({ version: VERSION, error: "search_id required" }), {
        headers: { "content-type": "application/json" }, status: 400,
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data: search, error: sErr } = await supabase
      .from("searches").select("*").eq("search_id", search_id).single();
    if (sErr) throw sErr;

    const { data: job, error: jErr } = await supabase
      .from("search_jobs").select("*").eq("search_id", search_id).single();
    if (jErr) throw jErr;

    if (job.status === "hotel_done" || job.status === "complete") {
      return new Response(JSON.stringify({ version: VERSION, search_id, status: job.status }), {
        headers: { "content-type": "application/json" }, status: 200,
      });
    }

    await supabase.from("search_jobs").update({ status: "running" }).eq("search_id", search_id);

    const childAges = parseChildAges(search.child_ages);
    const familySize = Number(search.adults ?? 2) + childAges.length;
    const hasInfant = childAges.some((a) => a < 2);
    // v19: room-occupancy requirement EXCLUDES infants (<2). Most hotels don't
    // count an under-2 toward room occupancy (lap/crib), so the coarse cap
    // gate must not drop a resort that can sleep adults + older kids. The
    // infant is surfaced with an "on lap / in a crib" callout in the
    // trip-detail room list.
    const roomFamilySize = Number(search.adults ?? 2) + childAges.filter((a) => a >= 2).length;

    let resorts: any[] = [];
    let survivors: any[] = [];
    let droppedKidsClub = 0, droppedInfant = 0, droppedFamilySize = 0, droppedAdultsOnly = 0;
    let fetched = 0;
    let done = true;

    if (scoped) {
      const { data, error } = await supabase
        .from("resorts").select(RESORT_COLS)
        .in("resort_id", included_resort_ids!)
        .eq("service_excluded", false);
      if (error) throw error;
      resorts = data ?? [];
      survivors = resorts;
      fetched = resorts.length;
      done = true;
    } else {
      const from = job.next_offset;
      const to = job.next_offset + job.batch_size - 1;

      let resortsQuery = supabase
        .from("resorts").select(RESORT_COLS)
        .eq("service_excluded", false)
        .not("airport_code", "is", null)
        // v21: only resorts with a LiteAPI mapping. Unmapped resorts can
        // never be live-priced; including them creates packages that the
        // user sees as "finding live prices…" forever (or as no_fit gaps).
        // Filter at search-time so every package generated has a real shot
        // at going live.
        .not("liteapi_hotel_id", "is", null);

      if (included_countries) resortsQuery = resortsQuery.in("country", included_countries);
      const defaultExcluded = DEFAULT_EXCLUDED_COUNTRIES.filter((c) => !(included_countries ?? []).includes(c));
      const allExcluded = Array.from(new Set([...excluded_countries, ...HARD_BLOCKED_COUNTRIES, ...defaultExcluded]));
      if (allExcluded.length > 0) {
        const quoted = allExcluded.map((c) => `"${String(c).replace(/"/g, '\\"')}"`).join(",");
        resortsQuery = resortsQuery.not("country", "in", `(${quoted})`);
      }
      if (search.require_direct_flight) resortsQuery = resortsQuery.eq("direct_flight", true);
      if (search.require_connecting_rooms) resortsQuery = resortsQuery.eq("guaranteed_connecting_rooms", true);

      const { data, error: rErr } = await resortsQuery.range(from, to);
      if (rErr) throw rErr;
      resorts = data ?? [];
      fetched = resorts.length;
      done = fetched < job.batch_size;

      survivors = resorts.filter((r: any) => {
        if (isAdultsOnly(r)) {
          console.error(
            `[process_search_batch v20] DATA FLAG: adults-only resort surfaced in catalog scan: ` +
            `${r.resort_id} "${r.resort_name}" (${r.country}) — audience=${r.audience}`,
          );
          droppedAdultsOnly++;
          return false;
        }
        if (search.require_kids_club && !hasKidsClubSignal(r)) { droppedKidsClub++; return false; }
        // v20: cap_child_allowed=false is unreliable (310/597 family resorts
        // carry it, 218 with kids clubs, 0 with accepts_infants). Only drop an
        // infant family's resort when the no-children signal is CORROBORATED:
        // no kids-club signal AND not family-audience.
        if (hasInfant && r.cap_child_allowed === false
            && !hasKidsClubSignal(r) && r.audience !== "Family") {
          droppedInfant++; return false;
        }
        if (roomFamilySize >= 5) {
          const hasCap = r.cap_fetched_at != null;
          if (hasCap) {
            const occOk = (r.cap_max_room_occupancy ?? 0) >= roomFamilySize;
            const altOk = r.cap_has_connecting === true || r.cap_has_suite === true || r.cap_has_villa === true;
            if (!occOk && !altOk) { droppedFamilySize++; return false; }
          }
        }
        return true;
      });
    }

    const scored = survivors.map((r: any) => {
      const rating = Number(r.avg_user_rating ?? 0);
      const value = Number(r.value_ratio ?? 0);
      const price = Number(r.direct_usd_2026 ?? 0);
      const stars = Number(r.cap_star_rating ?? 0);
      const ratingScore = rating;
      const valueScore = Math.min(value * 8, 25);
      const directScore = r.direct_flight ? 8 : 0;
      const priceScore = price > 0 ? Math.max(0, 20 - price / 300) : 0;
      const starScore = stars >= 3 ? Math.max(0, (stars - 3) * 4) : 0;
      return { ...r, score_total: ratingScore + valueScore + directScore + priceScore + starScore };
    });
    scored.sort((a: any, b: any) => (b.score_total ?? 0) - (a.score_total ?? 0));

    const packagesPayload = scored.map((r: any) => ({
      search_id, resort_id: r.resort_id,
      dest_airport_iata: (r.airport_code ?? r.airport_iata) ?? null,
      depart_date: search.date_start, return_date: search.date_end,
      currency: "USD", total_price: null, flight_price: null, hotel_price: null,
      stops: null, duration_hours: null,
      score_total: r.score_total,
      highlights: {
        rating: r.avg_user_rating, star_rating: r.cap_star_rating,
        value_ratio: r.value_ratio, direct_flight: r.direct_flight,
      },
      warnings: null, hotel_booking_url: null, flight_booking_url: null, priced_at: null,
    }));

    if (packagesPayload.length > 0) {
      const { error: pErr } = await supabase.from("packages").upsert(packagesPayload, { onConflict: "search_id,resort_id" });
      if (pErr) throw pErr;
    }

    const newOffset = scoped ? job.next_offset : job.next_offset + fetched;

    await supabase.from("search_jobs").update({
      next_offset: newOffset, status: done ? "hotel_done" : "running",
      updated_at: new Date().toISOString(),
    }).eq("search_id", search_id);

    const nextUrl = !done
      ? `${supabaseUrl}/functions/v1/process_search_batch`
      : `${supabaseUrl}/functions/v1/start_pricing`;
    const nextBody = !done
      ? { search_id, excluded_countries, included_countries, included_resort_ids }
      : { search_id };
    try {
      const p = fetch(nextUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey,
        },
        body: JSON.stringify(nextBody),
      });
      // deno-lint-ignore no-explicit-any
      const er = (globalThis as any).EdgeRuntime;
      if (er && typeof er.waitUntil === "function") {
        er.waitUntil(p.catch((e) => console.error("[process_search_batch] chain invoke error:", e)));
      } else {
        p.catch((e) => console.error("[process_search_batch] chain invoke error:", e));
      }
    } catch (e) {
      console.error("[process_search_batch] failed to chain next step:", e);
    }

    return new Response(JSON.stringify({
      version: VERSION, search_id, scoped,
      status: done ? "hotel_done" : "running",
      resorts_fetched: fetched,
      resorts_kept: survivors.length,
      dropped_by: {
        kids_club: droppedKidsClub,
        infant: droppedInfant,
        family_size: droppedFamilySize,
        adults_only: droppedAdultsOnly,
      },
      packages_written: packagesPayload.length,
      next_offset: newOffset,
      included_resort_ids_applied: included_resort_ids,
      included_countries_applied: included_countries,
      next_step: done ? "start_pricing" : "process_search_batch",
    }), { headers: { "content-type": "application/json" }, status: 200 });

  } catch (e) {
    return new Response(JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }), {
      headers: { "content-type": "application/json" }, status: 500,
    });
  }
});
