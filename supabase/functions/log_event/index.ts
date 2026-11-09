// log_event
//
// Lightweight funnel-event sink. The browser fires fire-and-forget POSTs
// here for each mid-funnel step (search_started, results_first_paint,
// trip_opened, filter_applied, search_abandoned, room_or_flight_selected,
// watch_trip_click, booking_click). Inserts into search_signals using the
// service-role key (anon is locked out of the table by RLS).
//
// v2: allow the trip-comparison funnel events (trip_search_started,
// trip_search_results, trip_price_shown, booking_partner_click,
// trip_search_error). Before this they were rejected by the allowlist.
//
// POST /functions/v1/log_event
//   { signal_type, search_id?, session_id?, is_internal?, payload? }
// Always returns 200 {ok:true} — logging must never block the UI, and a
// bad event should never surface an error to the user.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "log_event_v2_trip_funnel";

// Allowlist so a third party can't stuff arbitrary signal_types into the
// analytics table.
const ALLOWED = new Set([
  "search_started",
  "results_first_paint",
  "results_settled",
  "search_abandoned",
  "trip_opened",
  "filter_applied",
  "room_or_flight_selected",
  "watch_trip_click",
  "booking_click",
  "booking_compare_click",
  // v2: trip-comparison funnel
  "trip_search_started",
  "trip_search_results",
  "trip_price_shown",
  "booking_partner_click",
  "trip_search_error",
]);

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  // Never error out — analytics must not break the page.
  try {
    if (req.method !== "POST") return new Response(JSON.stringify({ ok: false }), { status: 200, headers });
    const body = await req.json().catch(() => ({}));
    const signal_type = String(body.signal_type ?? "").trim();
    if (!ALLOWED.has(signal_type)) {
      return new Response(JSON.stringify({ ok: false, reason: "unknown signal_type", version: VERSION }), { status: 200, headers });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return new Response(JSON.stringify({ ok: false }), { status: 200, headers });
    const sb = createClient(supabaseUrl, serviceRoleKey);

    const rawSession = typeof body.session_id === "string" ? body.session_id.trim() : "";
    const session_id = /^[A-Za-z0-9_-]{8,64}$/.test(rawSession) ? rawSession : null;
    const search_id = /^[0-9a-fA-F-]{36}$/.test(String(body.search_id ?? "")) ? body.search_id : null;
    // Cap payload size so a hostile client can't bloat the table.
    let payload: unknown = body.payload ?? null;
    try {
      const s = JSON.stringify(payload);
      if (s && s.length > 4000) payload = { truncated: true };
    } catch { payload = null; }

    await sb.from("search_signals").insert({
      signal_type,
      search_id,
      session_id,
      is_internal: body.is_internal === true,
      payload,
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  } catch (_) {
    return new Response(JSON.stringify({ ok: false }), { status: 200, headers });
  }
});
