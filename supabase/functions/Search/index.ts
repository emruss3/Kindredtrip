import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "Search_v11_session_id_internal";

type SearchRequest = {
  origin_iata: string;
  date_start: string;
  date_end: string;
  flex_days?: number;
  adults?: number;
  child_ages?: number[];
  budget_total?: number;
  max_flight_hours?: number;
  max_stops?: number;
  require_kids_club?: boolean;
  require_all_inclusive?: boolean;
  require_direct_flight?: boolean;
  require_connecting_rooms?: boolean;
  excluded_countries?: string[];
  included_countries?: string[];

  // Stable anonymous visitor id from the browser (matches
  // outbound_clicks.session_id so a click joins back to the search
  // that produced it).
  session_id?: string | null;

  // True for our own test traffic so search/click metrics stay clean
  // without backfills. Frontend sets this from a sticky localStorage
  // flag toggled via /?internal=1.
  is_internal?: boolean;

  // NEW: allow client to disable auto-invoke for testing or advanced flows
  skip_auto_process?: boolean;
};

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };

  try {
    if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
    if (req.method !== "POST")
      return new Response(JSON.stringify({ version: VERSION, error: "Use POST" }), {
        status: 405,
        headers,
      });

    const body = (await req.json()) as SearchRequest;

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const flexDays = body.flex_days ?? 0;
    const adults = body.adults ?? 2;
    const childAges = body.child_ages ?? [];
    const children = childAges.length;

    // Reject invalid date ranges at the API boundary too — the picker
    // had been letting these through, dropping a couple of garbage rows
    // (YYZ, YUL) into production.
    if (!body.date_start || !body.date_end || body.date_end < body.date_start) {
      return new Response(
        JSON.stringify({ version: VERSION, error: "date_end must be on or after date_start" }),
        { status: 400, headers },
      );
    }

    // Trust the client's session_id only if it looks like a uuid-ish
    // identifier — keeps a stray "null"/"undefined" out of the column.
    const rawSession = typeof body.session_id === "string" ? body.session_id.trim() : "";
    const session_id = /^[A-Za-z0-9_-]{8,64}$/.test(rawSession) ? rawSession : null;
    const is_internal = body.is_internal === true;

    // 1) Insert search
    const { data: searchRow, error: searchErr } = await supabase
      .from("searches")
      .insert({
        origin_iata: body.origin_iata,
        date_start: body.date_start,
        date_end: body.date_end,
        flex_days: flexDays,
        adults,
        children,
        child_ages: childAges,
        budget_total: body.budget_total ?? null,
        max_flight_hours: body.max_flight_hours ?? null,
        max_stops: body.max_stops ?? null,
        require_all_inclusive: body.require_all_inclusive ?? true,
        require_kids_club: body.require_kids_club ?? true,
        require_direct_flight: body.require_direct_flight ?? false,
        require_connecting_rooms: body.require_connecting_rooms ?? false,
        session_id,
        is_internal,
      })
      .select("search_id")
      .single();

    if (searchErr) throw searchErr;
    const search_id = searchRow.search_id;

    // 2) Create job row
    const { error: jobErr } = await supabase
      .from("search_jobs")
      .insert({
        search_id,
        status: "queued",
        next_offset: 0,
        batch_size: 250,
        flights_done: false,
      });

    if (jobErr) throw jobErr;

    // 3) Fire-and-forget invoke of process_search_batch.
    let auto_invoked = false;
    let auto_invoke_error: string | null = null;

    if (!body.skip_auto_process) {
      try {
        const invokePromise = fetch(`${supabaseUrl}/functions/v1/process_search_batch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
          },
          body: JSON.stringify({
            search_id,
            excluded_countries: body.excluded_countries ?? [],
            included_countries: body.included_countries ?? [],
          }),
        });
        // deno-lint-ignore no-explicit-any
        const er = (globalThis as any).EdgeRuntime;
        if (er && typeof er.waitUntil === "function") {
          er.waitUntil(
            invokePromise
              .then(async (r) => {
                if (!r.ok) {
                  const t = await r.text().catch(() => "");
                  console.error(`[Search] process_search_batch failed ${r.status}: ${t.slice(0, 300)}`);
                }
              })
              .catch((e) => console.error("[Search] process_search_batch invoke error:", e)),
          );
        } else {
          invokePromise.catch((e) => console.error("[Search] process_search_batch invoke error:", e));
        }
        auto_invoked = true;
      } catch (e) {
        auto_invoke_error = String(e);
        console.error("[Search] failed to fire process_search_batch:", e);
      }
    }

    return new Response(
      JSON.stringify({
        version: VERSION,
        search_id,
        auto_invoked,
        auto_invoke_error,
      }),
      { headers, status: 200 },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }),
      { headers, status: 500 },
    );
  }
});
