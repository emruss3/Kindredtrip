// check_watch_price_drops v1
//
// The send half of the "Watch this trip" feature. Runs on a daily cron.
// For each active watch it RE-PRICES THE HOTEL live via LiteAPI (the
// cheap, accurate half of a trip price) and — only when the hotel rate has
// DROPPED below the lowest price we've seen for that watch — emails the
// subscriber via Resend. We never email "still available" / "still a great
// deal"; price-drop only, per product policy.
//
// Why hotel-only: re-pricing flights for every watch is expensive and
// rate-limited. The hotel is the dominant, most-volatile component for
// all-inclusive family resorts, and we can re-price it for real in one
// call. The email leads with the verified hotel drop and shows an
// estimated trip total (hotel re-priced + flight from the last check).
//
// Drop rule: notify when
//   new_hotel <= baseline_hotel - max($50, 3% of baseline)
//   AND (no threshold set OR estimated_total <= threshold_usd)
// where baseline = the lowest of {hotel price at watch time, last price we
// emailed about}. After a successful send we advance last_notified_price to
// the new low, so the same drop never emails twice — only a NEW low does.
//
// Requires secrets: LiteAPI (hotel rates) and RESEND_API_KEY (+ optional
// RESEND_FROM). If RESEND_API_KEY is missing we still re-price and record
// current prices, but DON'T send and DON'T advance last_notified_price —
// so any qualifying drop is delivered the first run after the key is set.
//
// POST { max_watches?: number, dry_run?: boolean, depth?: number }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "check_watch_price_drops_v1";
const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";
const SITE = "https://kindredtrips.com";
const DEFAULT_MAX = 25;
const WALL_BUDGET_MS = 60_000;
const MAX_CHAIN_DEPTH = 40;
const PER_REQ_DELAY_MS = 200;
const MIN_DROP_USD = 50;
const MIN_DROP_PCT = 0.03;

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}
function liteKey(): string | null {
  for (const n of ["LiteAPI", "LITEAPI", "LITEAPI_SANDBOX_KEY", "LITEAPI_API_KEY"]) {
    const v = Deno.env.get(n);
    if (v && v.length > 10) return v;
  }
  return null;
}
function resendKey(): string | null {
  for (const n of ["RESEND_API_KEY", "RESEND_KEY", "RESEND"]) {
    const v = Deno.env.get(n);
    if (v && v.length > 10) return v;
  }
  return null;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const money = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// Cheapest bookable total for the whole stay across all room types/rates.
function cheapestHotelTotal(hotel: any): number | null {
  let min = Infinity;
  for (const rt of (hotel?.roomTypes ?? [])) {
    for (const rate of (rt?.rates ?? [])) {
      const t = rate?.retailRate?.total;
      let amt: number | null = null;
      if (Array.isArray(t)) amt = Number(t[0]?.amount);
      else if (t && typeof t === "object") amt = Number((t as any).amount);
      if (amt != null && Number.isFinite(amt) && amt > 0 && amt < min) min = amt;
    }
  }
  return min === Infinity ? null : Math.round(min);
}

async function repriceHotel(apiKey: string, hotelId: string, w: any): Promise<{ ok: boolean; total: number | null; error?: string }> {
  const childAges = Array.isArray(w.child_ages) ? w.child_ages.map((a: any) => Number(a)).filter((a: any) => Number.isFinite(a)) : [];
  try {
    const r = await fetch(`${LITEAPI_BASE}/hotels/rates`, {
      method: "POST",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        hotelIds: [hotelId],
        checkin: w.date_start,
        checkout: w.date_end,
        currency: "USD",
        guestNationality: "US",
        occupancies: [{ adults: Math.max(1, Number(w.adults) || 2), children: childAges }],
        timeout: 8,
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, total: null, error: `${r.status}: ${t.slice(0, 120)}` };
    }
    const body = await r.json();
    const hotel = body?.data?.[0];
    if (!hotel) return { ok: false, total: null, error: "no_rates" };
    const total = cheapestHotelTotal(hotel);
    return total != null ? { ok: true, total } : { ok: false, total: null, error: "no_rates" };
  } catch (e) {
    return { ok: false, total: null, error: String((e as any)?.message ?? e).slice(0, 120) };
  }
}

function emailHtml(o: {
  resortName: string; country: string; area: string | null;
  oldHotel: number; newHotel: number; estTotal: number;
  dateStart: string | null; dateEnd: string | null; origin: string | null;
  tripUrl: string; unsubUrl: string;
}): string {
  const saved = o.oldHotel - o.newHotel;
  const loc = [o.area, o.country].filter(Boolean).join(", ");
  const dates = o.dateStart && o.dateEnd
    ? `${new Date(o.dateStart + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} – ${new Date(o.dateEnd + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`
    : "";
  return `<!DOCTYPE html><html><body style="margin:0;background:#faf6ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0D2B45">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px">
    <div style="font-weight:700;font-size:20px;letter-spacing:-0.01em;margin-bottom:4px">KindredTrips</div>
    <div style="background:#fff;border:1px solid #E8DCCB;border-radius:16px;overflow:hidden">
      <div style="background:#0D6F78;color:#fff;padding:18px 22px;font-size:15px;font-weight:600">
        Good news — the price dropped ${money(saved)}.
      </div>
      <div style="padding:22px">
        <div style="font-family:Georgia,serif;font-size:21px;font-weight:600;line-height:1.2;margin-bottom:4px">${esc(o.resortName)}</div>
        <div style="color:#6b6256;font-size:13px;margin-bottom:18px">${esc(loc)}${dates ? ` &middot; ${esc(dates)}` : ""}${o.origin ? ` &middot; from ${esc(o.origin)}` : ""}</div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:18px">
          <tr>
            <td style="padding:6px 0;color:#6b6256;font-size:14px">Hotel rate when you started watching</td>
            <td style="padding:6px 0;text-align:right;color:#9a9082;font-size:14px;text-decoration:line-through">${money(o.oldHotel)}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;font-size:15px;font-weight:600">Hotel rate now</td>
            <td style="padding:6px 0;text-align:right;font-size:18px;font-weight:700;color:#0D6F78">${money(o.newHotel)}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#6b6256;font-size:13px">Estimated trip total (incl. flights from your last check)</td>
            <td style="padding:6px 0;text-align:right;color:#0D2B45;font-size:14px;font-weight:600">~${money(o.estTotal)}</td>
          </tr>
        </table>
        <a href="${o.tripUrl}" style="display:block;text-align:center;background:#E8765A;color:#fff;text-decoration:none;font-weight:600;font-size:16px;padding:14px;border-radius:12px">See live prices for this trip &rarr;</a>
        <p style="color:#9a9082;font-size:12px;line-height:1.5;margin:16px 0 0">We re-priced the hotel live; flights are estimated from your last search and may differ. Prices move daily — click through for the current live total.</p>
      </div>
    </div>
    <p style="color:#9a9082;font-size:12px;text-align:center;margin:18px 0 0">
      You're getting this because you asked us to watch this trip.<br/>
      <a href="${o.unsubUrl}" style="color:#6b6256">Unsubscribe from this watch</a>
    </p>
  </div></body></html>`;
}

async function sendEmail(apiKey: string, to: string, subject: string, html: string): Promise<{ ok: boolean; error?: string }> {
  const from = Deno.env.get("RESEND_FROM") || "KindredTrips <alerts@kindredtrips.com>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, error: `${r.status}: ${t.slice(0, 160)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as any)?.message ?? e).slice(0, 160) };
  }
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ version: VERSION, error: "POST only" }), { status: 405, headers });

  const started = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const maxWatches = Math.min(100, Math.max(1, Number(body.max_watches) || DEFAULT_MAX));
    const dryRun = body.dry_run === true;
    const depth = Number(body.depth) || 0;

    const apiKey = liteKey();
    if (!apiKey) throw new Error("LiteAPI key missing");
    const rkey = resendKey();   // may be null — we degrade (check but don't send)

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    // Oldest-checked active watches first. Join the resort for the LiteAPI
    // id + display fields; the package for the flight/hotel baseline split.
    const { data: watches, error: wErr } = await sb
      .from("watch_subscriptions")
      .select(`
        watch_id, email, package_id, resort_id, threshold_usd,
        captured_price, baseline_hotel_price, baseline_flight_price,
        last_notified_price, current_checked_at,
        origin_iata, date_start, date_end, adults, child_ages, unsubscribe_token,
        resorts:resort_id ( resort_name, country, area, liteapi_hotel_id )
      `)
      .is("unsubscribed_at", null)
      .eq("is_internal", false)
      .not("date_end", "is", null)
      .order("current_checked_at", { ascending: true, nullsFirst: true })
      .limit(maxWatches);
    if (wErr) throw wErr;

    const summary: any = {
      version: VERSION, depth, dry_run: dryRun, resend_configured: !!rkey,
      claimed: watches?.length ?? 0, repriced: 0, drops_found: 0, emails_sent: 0,
      skipped_no_id: 0, skipped_no_rates: 0, errors: [] as string[],
    };

    for (const w of (watches ?? [])) {
      if (Date.now() - started > WALL_BUDGET_MS) { summary.wall_hit = true; break; }
      const r = (w as any).resorts || {};
      const hotelId = r.liteapi_hotel_id;
      const nowIso = new Date().toISOString();

      // Resolve hotel baseline: stored column, else fall back to the package.
      let baselineHotel = w.baseline_hotel_price;
      let baselineFlight = w.baseline_flight_price;
      if (baselineHotel == null || baselineFlight == null) {
        const { data: p } = await sb.from("packages")
          .select("hotel_price, flight_price").eq("package_id", w.package_id).maybeSingle();
        if (p) {
          if (baselineHotel == null && p.hotel_price != null) baselineHotel = Math.round(Number(p.hotel_price));
          if (baselineFlight == null && p.flight_price != null) baselineFlight = Math.round(Number(p.flight_price));
        }
      }

      if (!hotelId || baselineHotel == null) {
        summary.skipped_no_id++;
        await sb.from("watch_subscriptions").update({
          current_checked_at: nowIso, check_error: !hotelId ? "no_liteapi_id" : "no_baseline",
        }).eq("watch_id", w.watch_id);
        continue;
      }

      const priced = await repriceHotel(apiKey, hotelId, w);
      await sleep(PER_REQ_DELAY_MS);
      if (!priced.ok || priced.total == null) {
        summary.skipped_no_rates++;
        await sb.from("watch_subscriptions").update({
          current_checked_at: nowIso, check_error: priced.error ?? "no_rates",
        }).eq("watch_id", w.watch_id);
        continue;
      }
      summary.repriced++;
      const newHotel = priced.total;
      const flight = baselineFlight ?? 0;
      const estTotal = newHotel + flight;

      // Lowest hotel price we've considered "the floor" so far.
      const floor = Math.min(baselineHotel, w.last_notified_price ?? Infinity);
      const margin = Math.max(MIN_DROP_USD, Math.round(floor * MIN_DROP_PCT));
      const qualifies =
        newHotel <= floor - margin &&
        (w.threshold_usd == null || estTotal <= w.threshold_usd);

      const upd: any = { current_hotel_price: newHotel, current_checked_at: nowIso, check_error: null };

      if (qualifies) {
        summary.drops_found++;
        if (rkey && !dryRun) {
          const tripUrl = `${SITE}/?trip=${encodeURIComponent(w.package_id)}`;
          const unsubUrl = `${supabaseUrl}/functions/v1/unsubscribe_watch?token=${encodeURIComponent(w.unsubscribe_token)}`;
          const sent = await sendEmail(rkey, w.email,
            `Price drop: ${r.resort_name || "your watched trip"} is ${money(baselineHotel - newHotel)} less`,
            emailHtml({
              resortName: r.resort_name || "Your watched resort",
              country: r.country || "", area: r.area || null,
              oldHotel: baselineHotel, newHotel, estTotal,
              dateStart: w.date_start, dateEnd: w.date_end, origin: w.origin_iata,
              tripUrl, unsubUrl,
            }));
          if (sent.ok) {
            summary.emails_sent++;
            upd.last_notified_price = newHotel;   // advance the floor only on a real send
            upd.last_notified_at = nowIso;
          } else {
            summary.errors.push(`send ${w.watch_id}: ${sent.error}`);
          }
        }
        // If no resend key (or dry_run): leave last_notified_price untouched
        // so the drop is delivered the first run after the key is configured.
      }
      await sb.from("watch_subscriptions").update(upd).eq("watch_id", w.watch_id);
    }

    // Chain if a full batch was claimed (more may be pending) and we have budget.
    let chained = false;
    if (!dryRun && (watches?.length ?? 0) >= maxWatches && depth + 1 < MAX_CHAIN_DEPTH && !summary.wall_hit) {
      const p = fetch(`${supabaseUrl}/functions/v1/check_watch_price_drops`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
        body: JSON.stringify({ max_watches: maxWatches, depth: depth + 1 }),
      });
      const er = (globalThis as any).EdgeRuntime;
      if (er?.waitUntil) er.waitUntil(p.catch(() => {})); else p.catch(() => {});
      chained = true;
    }
    summary.chained = chained;
    summary.elapsed_ms = Date.now() - started;
    summary.errors = summary.errors.slice(0, 5);
    return new Response(JSON.stringify(summary, null, 2), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }), { status: 500, headers });
  }
});
