// semantic_search_resorts
//
// Natural-language hotel discovery against the full curated catalogue.
// Embeds the caller's query with OpenAI `text-embedding-3-small`, then
// runs an HNSW cosine-distance lookup against `resort_embeddings`.
// Returns ranked resort_ids with similarity scores and a small payload
// of display fields so callers don't need a second roundtrip.
//
// GET  /functions/v1/semantic_search_resorts?query=...&limit=12
// POST /functions/v1/semantic_search_resorts
//   { query: string, limit?: number, countries?: string[],
//     require_liteapi_match?: boolean, exclude_resort_ids?: string[] }
//
// Response:
//   { version, query, results: [
//       { resort_id, resort_name, country, area, similarity,
//         avg_user_rating, on_beach, water_park, kids_club_available,
//         kids_club_min_age, kids_club_max_age, liteapi_hotel_id,
//         airport_iata, photo_refs }
//     ], total_candidates }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "semantic_search_resorts_v1";
const MODEL = "text-embedding-3-small";
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 60;

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

async function embedQuery(query: string, apiKey: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: MODEL, input: query }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.data[0].embedding as number[];
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });

  try {
    let query = "";
    let limit = DEFAULT_LIMIT;
    let countries: string[] | null = null;
    let requireMatch = false;
    let exclude: string[] | null = null;

    if (req.method === "GET") {
      const url = new URL(req.url);
      query = (url.searchParams.get("query") ?? "").trim();
      const l = Number(url.searchParams.get("limit"));
      if (Number.isFinite(l) && l > 0) limit = Math.min(l, MAX_LIMIT);
      const c = url.searchParams.get("countries");
      if (c) countries = c.split(",").map((s) => s.trim()).filter(Boolean);
      requireMatch = url.searchParams.get("require_liteapi_match") === "true";
    } else if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      query = typeof body.query === "string" ? body.query.trim() : "";
      if (Number.isFinite(body.limit) && body.limit > 0)
        limit = Math.min(Number(body.limit), MAX_LIMIT);
      if (Array.isArray(body.countries)) countries = body.countries;
      requireMatch = !!body.require_liteapi_match;
      if (Array.isArray(body.exclude_resort_ids)) exclude = body.exclude_resort_ids;
    } else {
      return new Response(
        JSON.stringify({ version: VERSION, error: "Use GET or POST" }),
        { status: 405, headers },
      );
    }

    if (!query || query.length < 2)
      return new Response(
        JSON.stringify({ version: VERSION, error: "Missing or too-short query" }),
        { status: 400, headers },
      );
    if (query.length > 500) query = query.slice(0, 500);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!supabaseUrl || !serviceRoleKey)
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    if (!openaiKey) throw new Error("Missing OPENAI_API_KEY");

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const embedding = await embedQuery(query, openaiKey);

    // Call the SQL function (defined in migration) for the actual ANN search +
    // join to resorts. This keeps the vector literal out of supabase-js's
    // PostgREST builder, which is not great with `vector` types.
    const { data, error } = await supabase.rpc("semantic_search_resorts_rpc", {
      query_embedding: embedding as unknown as string,
      match_limit: limit,
      countries_filter: countries,
      require_liteapi_match: requireMatch,
      exclude_ids: exclude,
    });
    if (error) throw error;

    return new Response(
      JSON.stringify({
        version: VERSION,
        query,
        model: MODEL,
        results: data ?? [],
        total_candidates: (data ?? []).length,
      }),
      { headers },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ version: VERSION, error: msg }),
      { status: 500, headers },
    );
  }
});
