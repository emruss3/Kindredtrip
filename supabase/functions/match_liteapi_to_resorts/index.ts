// match_liteapi_to_resorts v3
//
// v3 adds two big improvements over v2 (airport-anchor):
//
//   1. BRAND → CHAIN pre-filter. When our resort has a hotel_brand,
//      we cross-reference it against LiteAPI's `chain` field (cap_chain)
//      and restrict candidates to that chain's hotels in the country.
//      Reduces the candidate set 10-100× (a Sandals match looks at
//      ~5 Sandals hotels per country, not 1,000 total), which lets us
//      accept lower name-similarity for the right chain without false
//      positives.
//
//      The brand→chain synonyms map is learned automatically from the
//      ~522 already-matched resorts (every (hotel_brand, cap_chain)
//      pair seen in the catalogue counts as a known synonym), plus a
//      small built-in fallback for normalized-name equality.
//
//   2. Always WRITE liteapi_match_status — v2 only set liteapi_hotel_id
//      on success, so the (303, 88, 13) status buckets were uncomputable
//      from any single matcher pass. v3 sets:
//        'matched'        when a candidate hits the acceptance bar
//        'low_confidence' when there were candidates but best fell short
//        'no_match'       when zero candidates survived the geo / chain
//                         pre-filter
//      Coupled with liteapi_match_score (the winning similarity ×100)
//      so an operator can sort by margin to find borderline ones for
//      manual review.
//
// POST /functions/v1/match_liteapi_to_resorts  body: {
//   countries?: string[],     // ISO-3166 alpha-2; defaults to full set
//   dry_run?: boolean,        // simulate without updating (default true)
//   retry_status?: string[],  // also reprocess rows with these statuses
//                             // (default ['null','low_confidence','no_match']
//                             //  i.e. anything not 'matched')
// }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// v4 adds three fixes on top of v3 that recover obvious matches v3 parked
// as low_confidence:
//
//   1. CHARACTER-BIGRAM DICE similarity alongside token Jaccard. Token
//      Jaccard can't see that "Waterpark" == "Water Park" (one token vs
//      two), so "All Ritmo Cancun Resort & Waterpark" scored 0.40 against
//      LiteAPI's "All Ritmo ... Water Park - All Inclusive" and got
//      parked. Dice over space-stripped char bigrams scores that pair
//      ~0.8. Name similarity is now max(jaccard, dice).
//
//   2. GOOGLE-RESOLVED NAME as a second name source. Our resort_name is
//      full of marketing cruft ("All Inclusive", "- 2027") and is
//      sometimes flat wrong; google_place_resolved_name is cleaner and
//      Google-verified. We score against BOTH and keep the better one.
//      (Google names are occasionally junk like "3-bedroom villa..." —
//      taking the max means a junk Google name never hurts, it just
//      doesn't help.)
//
//   3. A FUZZY acceptance path gated hard on geo + leading token. The
//      new Dice signal is permissive, so it only accepts within 5 km AND
//      when our first distinctive token also appears in the candidate.
//      That keeps same-city/different-brand pairs (Sunscape Puerto
//      Vallarta vs Marriott Puerto Vallarta) rejected while letting the
//      compound-word and cruft cases through.
const VERSION = "match_liteapi_to_resorts_v4_dice_google_name";
const LITEAPI_BASE = "https://api.liteapi.travel/v3.0";
const PER_REQUEST_DELAY_MS = 250;
const WALL_CLOCK_BUDGET_MS = 90_000;

const COUNTRY_CODES: Array<{ code: string; name: string }> = [
  { code: "MX", name: "Mexico" }, { code: "DO", name: "Dominican Republic" }, { code: "JM", name: "Jamaica" },
  { code: "LC", name: "Saint Lucia" }, { code: "BB", name: "Barbados" }, { code: "CR", name: "Costa Rica" },
  { code: "AG", name: "Antigua and Barbuda" }, { code: "AW", name: "Aruba" }, { code: "CO", name: "Colombia" },
  { code: "TC", name: "Turks and Caicos" }, { code: "BS", name: "Bahamas" }, { code: "CW", name: "Curaçao" },
  { code: "BZ", name: "Belize" }, { code: "GD", name: "Grenada" }, { code: "HN", name: "Honduras" },
  { code: "PA", name: "Panama" }, { code: "SX", name: "Sint Maarten" }, { code: "MF", name: "Saint Martin" },
  { code: "VG", name: "British Virgin Islands" }, { code: "GT", name: "Guatemala" }, { code: "EC", name: "Ecuador" },
  { code: "PE", name: "Peru" }, { code: "VI", name: "US Virgin Islands" }, { code: "VC", name: "Saint Vincent and the Grenadines" },
  { code: "BM", name: "Bermuda" }, { code: "KY", name: "Cayman Islands" }, { code: "SV", name: "El Salvador" },
  { code: "BQ", name: "Bonaire" }, { code: "HT", name: "Haiti" }, { code: "MQ", name: "Martinique" },
  { code: "DM", name: "Dominica" }, { code: "NI", name: "Nicaragua" }, { code: "KN", name: "Saint Kitts and Nevis" },
  { code: "GP", name: "Guadeloupe" }, { code: "TT", name: "Trinidad and Tobago" },
];

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STOPWORDS = new Set([
  "the","and","a","resort","resorts","hotel","hotels","spa","by","an","all","inclusive","allinclusive",
  "collection","autograph","tribute","trademark","curio","unbound","luxury","luxe","beach","bay",
  "suites","suite","villas","villa","residences","residence","at","de","la","el","los","las",
  "golf","club","grand","royal","royale","grande","premium","platinum","family",
  "preferred","reserve","reserved","palace","palms","palm","pool","ocean","sea","y","del","con","oasis",
]);
function strip(s: string): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokenize(name: string): string[] {
  return strip(name).split(" ").filter((t) => t && !STOPWORDS.has(t));
}
function jaccard(aTokens: string[], bTokens: string[]): number {
  if (!aTokens.length || !bTokens.length) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}
// Character-bigram Dice coefficient over the space-stripped, accent-folded
// string. Robust to tokenization quirks ("waterpark" vs "water park"),
// word order, and trailing cruft. Returns 0..1.
function squish(s: string): string {
  return strip(s).replace(/ /g, "");
}
function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}
function diceBigram(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  if (!A.length || !B.length) return a && a === b ? 1 : 0;
  const counts = new Map<string, number>();
  for (const g of B) counts.set(g, (counts.get(g) ?? 0) + 1);
  let inter = 0;
  for (const g of A) {
    const c = counts.get(g);
    if (c && c > 0) { inter++; counts.set(g, c - 1); }
  }
  return (2 * inter) / (A.length + B.length);
}

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

async function fetchHotels(apiKey: string, code: string, offset: number, limit: number) {
  const params = new URLSearchParams({ countryCode: code, limit: String(limit), offset: String(offset) });
  const url = `${LITEAPI_BASE}/data/hotels?${params.toString()}`;
  const r = await fetch(url, { headers: { "X-API-Key": apiKey, Accept: "application/json" } });
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, status: r.status, error: t.slice(0, 200), hotels: [] as any[] };
  }
  const body = await r.json();
  return { ok: true, status: 200, hotels: Array.isArray(body?.data) ? body.data : [] as any[] };
}

// Normalize a chain/brand string for synonym comparison. "Bahía Príncipe
// Hotels & Resorts" → "bahia principe hotels and resorts". Different
// brand strings that share the first three tokens are treated as the
// same chain ("Bahia Principe" === "Bahía Príncipe Hotels & Resorts").
function chainKey(s: string | null | undefined): string {
  const t = strip(String(s ?? ""));
  if (!t) return "";
  const tokens = t.split(" ").filter((x) => x && !STOPWORDS.has(x));
  // First three meaningful tokens
  return tokens.slice(0, 3).join(" ");
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  if (req.method !== "POST")
    return new Response(JSON.stringify({ version: VERSION, error: "POST only" }), { status: 405, headers });

  const startedAt = Date.now();
  try {
    const body = await req.json().catch(() => ({}));
    const filterCodes: string[] | null = Array.isArray(body.countries) ? body.countries : null;
    const dryRun = body.dry_run !== false;
    // Default: re-process everything that isn't already linked.
    const retryStatus: string[] = Array.isArray(body.retry_status)
      ? body.retry_status
      : ["null", "low_confidence", "no_match"];
    const includeNullStatus = retryStatus.includes("null");
    const explicitStatuses = retryStatus.filter((s) => s !== "null");

    const countries = filterCodes
      ? COUNTRY_CODES.filter((c) => filterCodes.includes(c.code))
      : COUNTRY_CODES;

    const apiKey = findApiKey();
    if (!apiKey) throw new Error("LiteAPI key missing");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    // Learn brand → chain synonyms from the matched catalogue. Every
    // already-matched resort with both hotel_brand AND cap_chain
    // contributes a (chainKey(brand) → chainKey(chain)) pair.
    const { data: synonymRows } = await sb.from("resorts")
      .select("hotel_brand,cap_chain")
      .eq("liteapi_match_status", "matched")
      .not("hotel_brand", "is", null)
      .not("cap_chain", "is", null);
    const brandToChains = new Map<string, Set<string>>();
    for (const r of (synonymRows ?? [])) {
      const bk = chainKey(r.hotel_brand);
      const ck = chainKey(r.cap_chain);
      if (!bk || !ck) continue;
      if (!brandToChains.has(bk)) brandToChains.set(bk, new Set());
      brandToChains.get(bk)!.add(ck);
      // Self-synonym so the brand key matches its own chain too
      if (!brandToChains.has(ck)) brandToChains.set(ck, new Set());
      brandToChains.get(ck)!.add(ck);
    }

    // Existing liteapi ids in use, to avoid double-linking.
    const { data: usedIds } = await sb.from("resorts")
      .select("liteapi_hotel_id").not("liteapi_hotel_id", "is", null);
    const usedIdSet = new Set((usedIds ?? []).map((r: any) => String(r.liteapi_hotel_id)));

    const summary: any = {
      processed_countries: [],
      brand_synonyms_learned: brandToChains.size,
      unmatched_input: 0,
      candidates_scanned: 0,
      linked: 0,
      relinked_via_chain: 0,
      low_confidence: 0,
      no_candidate: 0,
      wall_time_budget_hit: false,
      rate_limit_hit: false,
      last_error: undefined as undefined | string,
      matches: [] as any[],
    };

    for (const c of countries) {
      if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) {
        summary.wall_time_budget_hit = true;
        break;
      }

      // Candidate unmatched rows for this country
      let oursQ = sb.from("resorts")
        .select("resort_id,resort_name,google_place_resolved_name,country,latitude,longitude,airport_code,hotel_brand,liteapi_match_status")
        .eq("country", c.name)
        .is("liteapi_hotel_id", null);
      // Status filter: combine NULL + explicit set into a single OR clause.
      const orParts: string[] = [];
      if (includeNullStatus) orParts.push("liteapi_match_status.is.null");
      if (explicitStatuses.length) {
        orParts.push(`liteapi_match_status.in.(${explicitStatuses.map((s) => `"${s}"`).join(",")})`);
      }
      if (orParts.length) oursQ = oursQ.or(orParts.join(","));

      const { data: ours } = await oursQ;
      const unmatched = ours ?? [];
      summary.unmatched_input += unmatched.length;
      if (unmatched.length === 0) {
        summary.processed_countries.push(c.code);
        continue;
      }

      // Airport centroid lookup for the country (same as v2)
      const airportCentroids = new Map<string, { lat: number; lng: number }>();
      const { data: airportRows } = await sb.from("resorts")
        .select("airport_code,latitude,longitude")
        .eq("country", c.name)
        .not("airport_code", "is", null)
        .not("latitude", "is", null)
        .not("longitude", "is", null);
      const tally = new Map<string, { latSum: number; lngSum: number; n: number }>();
      for (const r of airportRows ?? []) {
        const code = String(r.airport_code).trim();
        const lat = Number(r.latitude), lng = Number(r.longitude);
        if (!code || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const e = tally.get(code) ?? { latSum: 0, lngSum: 0, n: 0 };
        e.latSum += lat; e.lngSum += lng; e.n += 1;
        tally.set(code, e);
      }
      for (const [code, e] of tally.entries()) {
        airportCentroids.set(code, { lat: e.latSum / e.n, lng: e.lngSum / e.n });
      }

      // LiteAPI inventory for the country
      const liteHotels: any[] = [];
      let offset = 0, pages = 0;
      const limit = 1000;
      while (pages < 5 && Date.now() - startedAt < WALL_CLOCK_BUDGET_MS) {
        const res = await fetchHotels(apiKey, c.code, offset, limit);
        if (!res.ok) {
          summary.last_error = `${c.code}: ${res.status} ${res.error ?? ""}`;
          if (res.status === 429) summary.rate_limit_hit = true;
          break;
        }
        for (const h of res.hotels) liteHotels.push(h);
        pages++;
        if (res.hotels.length < limit) break;
        offset += limit;
        await sleep(PER_REQUEST_DELAY_MS);
      }
      if (summary.rate_limit_hit) break;
      summary.candidates_scanned += liteHotels.length;

      // Pre-tokenize candidates and compute chainKey for each
      const liteTok = liteHotels.map((h: any) => ({
        h,
        id: String(h?.id ?? h?.hotelId ?? ""),
        tokens: tokenize(h?.name ?? ""),
        sq: squish(h?.name ?? ""),
        chainK: chainKey(h?.chain),
        lat: Number(h?.latitude ?? h?.lat),
        lng: Number(h?.longitude ?? h?.lng),
      })).filter((x) => x.id && Number.isFinite(x.lat) && Number.isFinite(x.lng) && !usedIdSet.has(x.id));

      for (const ours_row of unmatched) {
        // Score against BOTH our raw resort_name and the Google-resolved
        // name; keep the better of the two for every signal.
        const nameSources = [ours_row.resort_name, (ours_row as any).google_place_resolved_name]
          .map((s: any) => String(s ?? "").trim())
          .filter((s: string) => s.length > 0);
        const ourTokenSets = nameSources.map(tokenize).filter((t) => t.length > 0);
        const ourSquished = nameSources.map(squish).filter((s) => s.length > 1);
        // Primary token set (for chain pass / lead-token guard): resort_name
        // first, falling back to whatever's available.
        const ourTokens = ourTokenSets[0] ?? [];
        // best name signals for a candidate, across all name sources
        const scoreCand = (cand: any) => {
          let jac = 0, shared = 0, dice = 0, lead = false;
          for (const ts of ourTokenSets) {
            const j = jaccard(ts, cand.tokens);
            if (j > jac) jac = j;
            const sh = ts.filter((t: string) => cand.tokens.includes(t)).length;
            if (sh > shared) shared = sh;
            if (ts[0] && cand.tokens.includes(ts[0])) lead = true;
          }
          for (const sq of ourSquished) {
            const d = diceBigram(sq, cand.sq);
            if (d > dice) dice = d;
          }
          return { jac, shared, dice, lead };
        };
        const ourLat = Number(ours_row.latitude);
        const ourLng = Number(ours_row.longitude);
        const hasOurCoords = Number.isFinite(ourLat) && Number.isFinite(ourLng);
        const apt = ours_row.airport_code ? airportCentroids.get(String(ours_row.airport_code).trim()) : null;
        const anchorLat = hasOurCoords ? ourLat : apt?.lat ?? null;
        const anchorLng = hasOurCoords ? ourLng : apt?.lng ?? null;
        const geoRadiusKm = hasOurCoords ? 8 : 25;

        // Build a same-chain candidate set when we have a brand
        const ourBrandKey = chainKey(ours_row.hotel_brand);
        const acceptableChainKeys = brandToChains.get(ourBrandKey) ?? new Set<string>([ourBrandKey]);
        const sameChain = ourBrandKey
          ? liteTok.filter((x) => x.chainK && acceptableChainKeys.has(x.chainK))
          : [];

        let best: any = null;
        let bestScore = 0;
        let matchPath = "name_geo";

        // First pass: chain-anchored candidates with very relaxed name +
        // generous geo. Chain alone is a strong enough signal that a
        // 0.30 Jaccard within 50 km of the airport is acceptable.
        for (const cand of sameChain) {
          let dKm = Infinity;
          if (anchorLat != null && anchorLng != null) {
            dKm = distanceKm(anchorLat as number, anchorLng as number, cand.lat, cand.lng);
          }
          const sc = scoreCand(cand);
          // Combined name signal: best of token Jaccard and char-bigram Dice.
          const sim = Math.max(sc.jac, sc.dice);
          // Chain-anchored thresholds:
          //   own coords:        sim >= 0.30 within 5 km
          //   airport centroid:  sim >= 0.40 within 50 km
          //   no anchor:         sim >= 0.55
          // Chain-anchored thresholds. v3 had 0.30 for own-coords which
          // let a "Hyatt Zilara Cancun" candidate pair to a same-chain
          // "The Royal Cancun" 4 km away (both reduce to one shared
          // location token after stopword strip). Require ourTokens
          // share at least 2 distinctive tokens AND a stricter sim
          // floor when the brand match alone is doing most of the work.
          const sharedTokens = sc.shared;
          // v4: chain + location alone caused false positives between
          // co-located sister properties of the same chain (Riu Jalisco vs
          // Riu Flamingos; Turquoize/Hyatt vs Riu Palace). Require a higher
          // combined-name floor AND that our leading distinctive token
          // appears in the candidate, so the property-distinguishing word
          // (not just the chain + city) has to agree.
          let acceptable = false;
          if (hasOurCoords) acceptable = sim >= 0.55 && sharedTokens >= 2 && sc.lead && dKm <= 5;
          else if (anchorLat != null) acceptable = sim >= 0.60 && sharedTokens >= 2 && sc.lead && dKm <= 50;
          else acceptable = sim >= 0.65 && sharedTokens >= 2 && sc.lead;
          if (!acceptable) continue;
          const score = sim * 100 + 20 /* chain bonus */ - (Number.isFinite(dKm) ? dKm * 0.3 : 0);
          if (score > bestScore) {
            bestScore = score;
            best = { cand, sim, dKm };
            matchPath = "chain_name_geo";
          }
        }

        // Second pass (only if chain didn't land a match): v2's
        // name+geo logic across the full country.
        if (!best) {
          for (const cand of liteTok) {
            let dKm = Infinity;
            if (anchorLat != null && anchorLng != null) {
              dKm = distanceKm(anchorLat as number, anchorLng as number, cand.lat, cand.lng);
              if (dKm > geoRadiusKm) continue;
            }
            const sc = scoreCand(cand);
            const jac = sc.jac;
            let acceptable = false;
            let path = "name_geo";
            if (hasOurCoords) {
              acceptable = (jac >= 0.55 && dKm <= 3) || (jac >= 0.80 && dKm <= 8);
              // Fuzzy Dice path: catches "Waterpark" vs "Water Park" and
              // marketing-cruft mismatches that token Jaccard misses.
              // Gated hard — within 5 km, our leading distinctive token must
              // appear in the candidate, and >=2 shared tokens — so a
              // same-city different-brand pair (Sunscape vs Marriott Puerto
              // Vallarta) is still rejected (different lead token).
              if (!acceptable && sc.dice >= 0.62 && sc.lead && sc.shared >= 2 && dKm <= 5) {
                acceptable = true;
                path = "name_geo_dice";
              }
            } else if (anchorLat != null) {
              acceptable = Math.max(jac, sc.dice) >= 0.80 && dKm <= 25;
            } else {
              acceptable = Math.max(jac, sc.dice) >= 0.90;
            }
            if (!acceptable) continue;
            const sim = Math.max(jac, sc.dice);
            const score = sim * 100 - (Number.isFinite(dKm) ? dKm * 0.5 : 0);
            if (score > bestScore) {
              bestScore = score;
              best = { cand, sim, dKm };
              matchPath = path;
            }
          }
        }

        // Track best-effort score even when nothing meets the threshold,
        // so we can record low_confidence vs no_match. Cheap: Jaccard only
        // (no Dice) and geo-gated, so this doesn't blow the CPU budget.
        let runnerUp: any = null;
        if (!best) {
          let bestSim = 0;
          for (const cand of liteTok) {
            if (anchorLat != null && anchorLng != null) {
              const dKm = distanceKm(anchorLat as number, anchorLng as number, cand.lat, cand.lng);
              if (dKm > geoRadiusKm) continue;
            }
            let jac = 0;
            for (const ts of ourTokenSets) {
              const j = jaccard(ts, cand.tokens);
              if (j > jac) jac = j;
            }
            if (jac > bestSim) { bestSim = jac; runnerUp = { cand, sim: jac }; }
          }
        }

        const nowIso = new Date().toISOString();
        if (best) {
          summary.matches.push({
            country: c.name,
            ours: ours_row.resort_name,
            liteapi: best.cand.h?.name,
            liteapi_id: best.cand.id,
            name_sim: Number(best.sim.toFixed(3)),
            distance_km: Number(best.dKm.toFixed(2)),
            match_path: matchPath,
          });
          if (matchPath === "chain_name_geo") summary.relinked_via_chain++;
          summary.linked++;
          if (!dryRun) {
            await sb.from("resorts").update({
              liteapi_hotel_id: best.cand.id,
              liteapi_match_status: "matched",
              liteapi_match_score: Math.round(bestScore),
              liteapi_match_method: matchPath,
              liteapi_synced_at: nowIso,
            }).eq("resort_id", ours_row.resort_id);
            usedIdSet.add(best.cand.id);
          }
        } else if (runnerUp && runnerUp.sim >= 0.35) {
          summary.low_confidence++;
          if (!dryRun) {
            await sb.from("resorts").update({
              liteapi_match_status: "low_confidence",
              liteapi_match_score: Math.round(runnerUp.sim * 100),
              liteapi_match_method: "best_effort_below_threshold",
              liteapi_synced_at: nowIso,
            }).eq("resort_id", ours_row.resort_id);
          }
        } else {
          summary.no_candidate++;
          if (!dryRun) {
            await sb.from("resorts").update({
              liteapi_match_status: "no_match",
              liteapi_match_score: runnerUp ? Math.round(runnerUp.sim * 100) : 0,
              liteapi_match_method: "no_candidate",
              liteapi_synced_at: nowIso,
            }).eq("resort_id", ours_row.resort_id);
          }
        }
      }

      summary.processed_countries.push(c.code);
      await sleep(PER_REQUEST_DELAY_MS);
    }

    if (summary.matches.length > 100) {
      summary.matches_truncated_to = 100;
      summary.matches = summary.matches.slice(0, 100);
    }

    return new Response(JSON.stringify({
      version: VERSION, dry_run: dryRun, elapsed_ms: Date.now() - startedAt, summary,
    }, null, 2), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({
      version: VERSION, error: String((e as any)?.message ?? e),
    }), { status: 500, headers });
  }
});
