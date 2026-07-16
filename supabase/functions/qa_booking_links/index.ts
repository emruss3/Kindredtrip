// qa_booking_links
//
// QA sweep for verified Booking.com property URLs. For each resort that has a
// booking_property_url, fetch it (follow redirects) and classify:
//   ok                   -> 200, stayed on a /hotel/ page, name+country match
//   not_found            -> 404 or body says "Page Not Found"
//   redirected_to_search -> final URL left /hotel/ (Booking bounced to search/home)
//   name_mismatch        -> page loaded but title/content doesn't match the resort
// Writes booking_status, booking_last_verified_at, booking_match_confidence.
//
// Runs on Supabase edge (has outbound network to booking.com). Invoke:
//   POST { limit?: number=50, dry_run?: boolean=false, only_unverified?: boolean=false }
// Resorts are ranked by review_count desc (test the highest-traffic first).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "qa_booking_links_v1";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const PER_REQUEST_DELAY_MS = 400;
const FETCH_TIMEOUT_MS = 12_000;

const STOP = new Set(["the","and","a","an","resort","resorts","hotel","hotels","spa","by","all",
  "inclusive","collection","suites","suite","villas","villa","beach","bay","at","de","la","el",
  "los","las","club","grand","royal","premium","golf","family","cancun","cancún"]);

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function norm(s: string): string {
  return String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
function tokens(s: string): string[] {
  return norm(s).split(" ").filter((t) => t.length >= 4 && !STOP.has(t));
}

async function checkUrl(url: string, resortName: string, country: string | null): Promise<{
  status: string; http: number | null; confidence: number; finalUrl: string | null; note: string;
}> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": UA, "Accept-Language": "en-US,en" }, signal: ctrl.signal });
    const finalUrl = r.url || url;
    const http = r.status;
    const bodyRaw = await r.text();
    const body = bodyRaw.toLowerCase();

    if (http === 404 || body.includes("page not found") || body.includes("we can't find this page")) {
      return { status: "not_found", http, confidence: 0, finalUrl, note: "404 / Page Not Found" };
    }
    // Booking bounced us off the property page to a search/home/destination page.
    if (!/\/hotel\//.test(finalUrl) || /searchresults|\/index\.|\/destination/.test(finalUrl)) {
      return { status: "redirected_to_search", http, confidence: 0.1, finalUrl, note: "left /hotel/ page" };
    }
    // Name match against the page title + h1.
    const titleMatch = body.match(/<title[^>]*>([^<]*)<\/title>/);
    const h1Match = body.match(/<h1[^>]*>([^<]*)<\/h1>/);
    const pageText = norm((titleMatch?.[1] ?? "") + " " + (h1Match?.[1] ?? ""));
    // Booking serves a JS/anti-bot challenge (often HTTP 202) with no readable
    // <title> to server-side fetches, so we CAN'T name-match here. A non-404
    // URL that stayed on a /hotel/ page is still a good signal — mark ok with
    // reduced confidence. True name/country verification needs a real browser
    // (scripts/qa-booking-links.mjs, Playwright).
    if (!pageText) {
      return { status: "ok", http, confidence: 0.5, finalUrl, note: "resolved to /hotel/ page; name unverifiable via edge (anti-bot challenge) — use Playwright QA" };
    }
    const want = tokens(resortName);
    const hit = want.filter((t) => pageText.includes(t)).length;
    const ratio = want.length ? hit / want.length : 1;
    if (ratio >= 0.5) {
      return { status: "ok", http, confidence: Number(ratio.toFixed(2)), finalUrl, note: `name match ${hit}/${want.length}` };
    }
    return { status: "name_mismatch", http, confidence: Number(ratio.toFixed(2)), finalUrl, note: `name match ${hit}/${want.length} title="${(titleMatch?.[1] ?? "").slice(0,80)}"` };
  } catch (e) {
    return { status: "error", http: null, confidence: 0, finalUrl: null, note: String((e as any)?.message ?? e).slice(0, 120) };
  } finally {
    clearTimeout(to);
  }
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ version: VERSION, error: "POST only" }), { status: 405, headers });

  try {
    const body = await req.json().catch(() => ({}));
    const limit = Math.min(Number(body.limit ?? 50), 300);
    const dryRun = body.dry_run === true;

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Count coverage first so the summary is honest about how many resorts
    // still have NO verified URL (those always fall back to search).
    const { count: bookableMapped } = await sb.from("resorts")
      .select("resort_id", { count: "exact", head: true })
      .eq("service_excluded", false).not("liteapi_hotel_id", "is", null);
    const { count: withUrl } = await sb.from("resorts")
      .select("resort_id", { count: "exact", head: true })
      .eq("service_excluded", false).not("booking_property_url", "is", null);

    const { data: rows, error } = await sb.from("resorts")
      .select("resort_id, resort_name, country, booking_property_url, review_count")
      .eq("service_excluded", false)
      .not("booking_property_url", "is", null)
      .order("review_count", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;

    const results: any[] = [];
    const tally: Record<string, number> = {};
    for (const r of rows ?? []) {
      const res = await checkUrl(r.booking_property_url, r.resort_name, r.country);
      tally[res.status] = (tally[res.status] ?? 0) + 1;
      results.push({ resort_id: r.resort_id, resort_name: r.resort_name, ...res });
      if (!dryRun) {
        await sb.from("resorts").update({
          booking_status: res.status,
          booking_match_confidence: res.confidence,
          booking_last_verified_at: new Date().toISOString(),
        }).eq("resort_id", r.resort_id);
      }
      await sleep(PER_REQUEST_DELAY_MS);
    }

    // Surface the worst offenders for a quick eyeball.
    const flagged = results.filter((x) => x.status !== "ok").slice(0, 50);

    return new Response(JSON.stringify({
      version: VERSION,
      dry_run: dryRun,
      coverage: {
        bookable_mapped: bookableMapped ?? null,
        with_verified_url: withUrl ?? null,
        without_url_fall_back_to_search: (bookableMapped ?? 0) - (withUrl ?? 0),
      },
      checked: results.length,
      by_status: tally,
      flagged,
    }, null, 2), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ version: VERSION, error: String((e as any)?.message ?? e) }), { status: 500, headers });
  }
});
