// embed_resorts
//
// Backfills (or refreshes) semantic embeddings for resorts into
// `resort_embeddings`. Uses OpenAI `text-embedding-3-small` (1536 dims).
//
// Per resort, embedding text is built from curated fields the search team
// already maintains — name, country, area, amenities, room options, food/
// beach/party text, LiteAPI description, kids-club + family-fit signals.
//
// A SHA-256 of the source text is stored as `source_hash`. On subsequent
// runs the resort is skipped when the hash matches, so this is safe to
// invoke repeatedly and cheap to keep current.
//
// POST /functions/v1/embed_resorts
// Body:
//   {
//     resort_ids?: string[],     // limit to specific resorts
//     country?: string,          // limit to a country
//     force?: boolean,           // re-embed even if source_hash matches
//     limit?: number,            // max resorts processed (default 1000)
//     batch_size?: number        // OpenAI batch size (default 96)
//   }
//
// Response:
//   { version, processed, embedded, skipped_unchanged, skipped_no_text,
//     errors[], model, total_tokens }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "embed_resorts_v1";
const MODEL = "text-embedding-3-small";
const DEFAULT_LIMIT = 1000;
const DEFAULT_BATCH = 96;

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

type ResortRow = {
  resort_id: string;
  resort_name: string | null;
  country: string | null;
  area: string | null;
  airport_iata: string | null;
  hotel_brand: string | null;
  hotel_style: string | null;
  audience: string | null;
  amenities_text: string | null;
  special_room_options_text: string | null;
  food_beach_party_text: string | null;
  liteapi_description: string | null;
  cap_facilities: string[] | null;
  cap_hotel_type: string | null;
  cap_star_rating: number | null;
  on_beach: boolean | null;
  water_park: boolean | null;
  kids_club_available: boolean | null;
  kids_club_min_age: number | null;
  kids_club_max_age: number | null;
  accepts_infants: boolean | null;
  family_room_max_occupancy: number | null;
  connecting_rooms_available: boolean | null;
  swim_up_rooms: boolean | null;
  avg_user_rating: number | null;
  airport_transfer_minutes: number | null;
};

// Compose the text we embed. Stays under ~8k tokens easily.
function buildEmbeddingText(r: ResortRow): string {
  const lines: string[] = [];
  if (r.resort_name) lines.push(`Resort: ${r.resort_name}`);
  if (r.country) lines.push(`Country: ${r.country}${r.area ? `, ${r.area}` : ""}`);
  if (r.airport_iata) lines.push(`Nearest airport: ${r.airport_iata}`);
  if (r.hotel_brand) lines.push(`Brand: ${r.hotel_brand}`);
  if (r.hotel_style) lines.push(`Style: ${r.hotel_style}`);
  if (r.audience) lines.push(`Audience: ${r.audience}`);
  if (r.cap_hotel_type) lines.push(`Type: ${r.cap_hotel_type}`);
  if (r.cap_star_rating != null) lines.push(`Stars: ${r.cap_star_rating}`);
  if (r.avg_user_rating != null) lines.push(`Guest rating: ${r.avg_user_rating}`);

  const family: string[] = [];
  if (r.kids_club_available) {
    const ages =
      r.kids_club_min_age != null && r.kids_club_max_age != null
        ? ` (ages ${r.kids_club_min_age}–${r.kids_club_max_age})`
        : "";
    family.push(`kids club${ages}`);
  }
  if (r.accepts_infants) family.push("accepts infants");
  if (r.connecting_rooms_available) family.push("connecting rooms");
  if (r.family_room_max_occupancy && r.family_room_max_occupancy >= 5)
    family.push(`family room sleeps ${r.family_room_max_occupancy}`);
  if (r.on_beach) family.push("beachfront");
  if (r.water_park) family.push("water park");
  if (r.swim_up_rooms) family.push("swim-up rooms");
  if (family.length) lines.push(`Family features: ${family.join(", ")}`);

  if (r.airport_transfer_minutes)
    lines.push(`Airport transfer: ~${r.airport_transfer_minutes} min`);

  if (r.amenities_text) lines.push(`Amenities: ${r.amenities_text}`);
  if (r.special_room_options_text)
    lines.push(`Room options: ${r.special_room_options_text}`);
  if (r.food_beach_party_text) lines.push(`Food & beach: ${r.food_beach_party_text}`);

  if (r.cap_facilities && r.cap_facilities.length) {
    // Cap to 500 chars worth of facilities to avoid runaway tokens
    const f = r.cap_facilities.join(", ");
    lines.push(`Facilities: ${f.length > 600 ? f.slice(0, 600) + "…" : f}`);
  }

  if (r.liteapi_description) {
    // First ~1200 chars of marketing description
    const d = r.liteapi_description;
    lines.push(`Description: ${d.length > 1200 ? d.slice(0, 1200) + "…" : d}`);
  }

  return lines.join("\n");
}

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function embedBatch(
  texts: string[],
  apiKey: string,
): Promise<{ embeddings: number[][]; total_tokens: number }> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 400)}`);
  }
  const json = await res.json();
  const embeddings = (json.data as Array<{ embedding: number[] }>).map(
    (d) => d.embedding,
  );
  const total_tokens = json.usage?.total_tokens ?? 0;
  return { embeddings, total_tokens };
}

serve(async (req) => {
  const headers = { ...corsHeaders(), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers });
  if (req.method !== "POST")
    return new Response(JSON.stringify({ version: VERSION, error: "Use POST" }), {
      status: 405,
      headers,
    });

  try {
    const body = await req.json().catch(() => ({}));
    const resortIds: string[] | null = Array.isArray(body.resort_ids)
      ? body.resort_ids
      : null;
    const countryFilter: string | null =
      typeof body.country === "string" ? body.country : null;
    const force = !!body.force;
    const limit = Math.min(
      Math.max(Number(body.limit) || DEFAULT_LIMIT, 1),
      5000,
    );
    const batchSize = Math.min(
      Math.max(Number(body.batch_size) || DEFAULT_BATCH, 1),
      256,
    );

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!supabaseUrl || !serviceRoleKey)
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    if (!openaiKey) throw new Error("Missing OPENAI_API_KEY");

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Pull candidate resorts
    let q = supabase
      .from("resorts")
      .select(
        "resort_id,resort_name,country,area,airport_iata,hotel_brand,hotel_style,audience," +
          "amenities_text,special_room_options_text,food_beach_party_text," +
          "liteapi_description,cap_facilities,cap_hotel_type,cap_star_rating," +
          "on_beach,water_park,kids_club_available,kids_club_min_age,kids_club_max_age," +
          "accepts_infants,family_room_max_occupancy,connecting_rooms_available," +
          "swim_up_rooms,avg_user_rating,airport_transfer_minutes",
      )
      .order("resort_id", { ascending: true })
      .limit(limit);
    if (resortIds && resortIds.length) q = q.in("resort_id", resortIds);
    if (countryFilter) q = q.eq("country", countryFilter);

    const { data: resorts, error: rErr } = await q;
    if (rErr) throw rErr;

    // Pull existing hashes so we can skip unchanged rows
    const ids = (resorts ?? []).map((r) => r.resort_id);
    const { data: existing, error: eErr } = await supabase
      .from("resort_embeddings")
      .select("resort_id,source_hash,model")
      .in("resort_id", ids);
    if (eErr) throw eErr;
    const existingByID = new Map<string, { source_hash: string; model: string }>();
    for (const e of existing ?? []) existingByID.set(e.resort_id, e);

    // Build embedding text + hash for each resort
    const pending: {
      resort_id: string;
      text: string;
      hash: string;
    }[] = [];
    let skipped_unchanged = 0;
    let skipped_no_text = 0;
    for (const r of (resorts ?? []) as ResortRow[]) {
      const text = buildEmbeddingText(r).trim();
      if (text.length < 20) {
        skipped_no_text++;
        continue;
      }
      const hash = await sha256Hex(text);
      const ex = existingByID.get(r.resort_id);
      if (!force && ex && ex.source_hash === hash && ex.model === MODEL) {
        skipped_unchanged++;
        continue;
      }
      pending.push({ resort_id: r.resort_id, text, hash });
    }

    // Embed in batches
    let embedded = 0;
    let total_tokens = 0;
    const errors: { resort_id: string; error: string }[] = [];

    for (let i = 0; i < pending.length; i += batchSize) {
      const slice = pending.slice(i, i + batchSize);
      try {
        const { embeddings, total_tokens: bt } = await embedBatch(
          slice.map((p) => p.text),
          openaiKey,
        );
        total_tokens += bt;
        const rows = slice.map((p, idx) => ({
          resort_id: p.resort_id,
          embedding: embeddings[idx] as unknown as string, // supabase-js stringifies arrays correctly
          embedding_text: p.text,
          source_hash: p.hash,
          model: MODEL,
          token_count: Math.round(bt / slice.length),
        }));
        const { error: uErr } = await supabase
          .from("resort_embeddings")
          .upsert(rows, { onConflict: "resort_id" });
        if (uErr) throw uErr;
        embedded += rows.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const p of slice) errors.push({ resort_id: p.resort_id, error: msg });
      }
    }

    return new Response(
      JSON.stringify({
        version: VERSION,
        model: MODEL,
        processed: resorts?.length ?? 0,
        embedded,
        skipped_unchanged,
        skipped_no_text,
        errors,
        total_tokens,
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
