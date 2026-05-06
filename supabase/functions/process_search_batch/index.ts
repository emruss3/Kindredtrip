import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "process_search_batch_v11_block_brazil";

// Global never-include list. Brazil is in our dataset but is not Caribbean
// and isn't part of the product positioning, so we keep it out by default.
const GLOBAL_BLOCKED_COUNTRIES: string[] = ["Brazil"];

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

    if (!search_id) {
      return new Response(JSON.stringify({ version: VERSION, error: "search_id required" }), {
        headers: { "content-type": "application/json" },
        status: 400,
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data: search, error: sErr } = await supabase
      .from("searches")
      .select("*")
      .eq("search_id", search_id)
      .single();
    if (sErr) throw sErr;

    const { data: job, error: jErr } = await supabase
      .from("search_jobs")
      .select("*")
      .eq("search_id", search_id)
      .single();
    if (jErr) throw jErr;

    if (job.status === "hotel_done" || job.status === "complete") {
      return new Response(JSON.stringify({ version: VERSION, search_id, status: job.status }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }

    await supabase.from("search_jobs").update({ status: "running" }).eq("search_id", search_id);

    const from = job.next_offset;
    const to = job.next_offset + job.batch_size - 1;

    let resortsQuery = supabase
      .from("resorts")
      .select(
        "resort_id,resort_name,country,area,airport_iata,airport_code,avg_user_rating,value_ratio,direct_usd_2026,direct_flight,guaranteed_connecting_rooms,amenities_text"
      )
      .eq("audience", "Family")
      .not("airport_code", "is", null);

    if (included_countries) {
      resortsQuery = resortsQuery.in("country", included_countries);
    }

    const allExcluded = Array.from(new Set([...excluded_countries, ...GLOBAL_BLOCKED_COUNTRIES]));
    if (allExcluded.length > 0) {
      const quoted = allExcluded.map((c) => `"${String(c).replace(/"/g, '\\"')}"`).join(",");
      resortsQuery = resortsQuery.not("country", "in", `(${quoted})`);
    }

    if (search.require_direct_flight) resortsQuery = resortsQuery.eq("direct_flight", true);
    if (search.require_connecting_rooms) resortsQuery = resortsQuery.eq("guaranteed_connecting_rooms", true);

    const { data: resorts, error: rErr } = await resortsQuery.range(from, to);
    if (rErr) throw rErr;

    const scored = (resorts ?? []).map((r: any) => {
      const rating = Number(r.avg_user_rating ?? 0);
      const value = Number(r.value_ratio ?? 0);
      const price = Number(r.direct_usd_2026 ?? 0);

      const ratingScore = rating;
      const valueScore = Math.min(value * 8, 25);
      const directScore = r.direct_flight ? 8 : 0;
      const priceScore = price > 0 ? Math.max(0, 20 - price / 300) : 0;

      return { ...r, score_total: ratingScore + valueScore + directScore + priceScore };
    });

    scored.sort((a: any, b: any) => (b.score_total ?? 0) - (a.score_total ?? 0));

    const packagesPayload = scored.map((r: any) => {
      const dest = (r.airport_code ?? r.airport_iata) ?? null;
      return {
        search_id,
        resort_id: r.resort_id,
        dest_airport_iata: dest,
        depart_date: search.date_start,
        return_date: search.date_end,
        currency: "USD",
        total_price: null,
        flight_price: null,
        hotel_price: null,
        stops: null,
        duration_hours: null,
        score_total: r.score_total,
        highlights: {
          rating: r.avg_user_rating,
          value_ratio: r.value_ratio,
          direct_flight: r.direct_flight,
        },
        warnings: null,
        hotel_booking_url: null,
        flight_booking_url: null,
        priced_at: null,
      };
    });

    if (packagesPayload.length > 0) {
      const { error: pErr } = await supabase
        .from("packages")
        .upsert(packagesPayload, { onConflict: "search_id,resort_id" });
      if (pErr) throw pErr;
    }

    const processed = resorts?.length ?? 0;
    const newOffset = job.next_offset + processed;
    const done = processed < job.batch_size;

    await supabase.from("search_jobs").update({
      next_offset: newOffset,
      status: done ? "hotel_done" : "running",
      updated_at: new Date().toISOString(),
    }).eq("search_id", search_id);

    const nextUrl = !done
      ? `${supabaseUrl}/functions/v1/process_search_batch`
      : `${supabaseUrl}/functions/v1/price_flights_for_search`;
    const nextBody = !done
      ? { search_id, excluded_countries, included_countries }
      : { search_id };
    try {
      const p = fetch(nextUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
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
      version: VERSION,
      search_id,
      status: done ? "hotel_done" : "running",
      processed,
      next_offset: newOffset,
      excluded_countries_applied: allExcluded,
      included_countries_applied: included_countries,
    }), {
      headers: { "content-type": "application/json" },
      status: 200,
    });

  } catch (e) {
    return new Response(JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }), {
      headers: { "content-type": "application/json" },
      status: 500,
    });
  }
});
