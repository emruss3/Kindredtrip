// unsubscribe_watch
//
// One-click unsubscribe target for the price-drop emails. Public (no JWT):
// it's a link clicked from an email client. GET ?token=<unsubscribe_token>
// sets unsubscribed_at on the matching watch and returns a small HTML
// confirmation page. Idempotent and safe to hit repeatedly.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "unsubscribe_watch_v1";

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title} — KindredTrips</title>
<style>
  body{margin:0;background:#faf6ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0D2B45;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .card{background:#fff;border:1px solid #E8DCCB;border-radius:18px;max-width:460px;padding:32px;text-align:center;box-shadow:0 10px 30px rgba(13,43,69,.08)}
  h1{font-size:22px;margin:0 0 10px}
  p{color:#6b6256;line-height:1.55;margin:0 0 20px;font-size:15px}
  a{display:inline-block;background:#0D6F78;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px}
</style></head><body><div class="card">${body}</div></body></html>`;
}

serve(async (req) => {
  const html = (status: number, t: string, b: string) =>
    new Response(page(t, b), { status, headers: { "content-type": "text/html; charset=utf-8" } });

  try {
    const url = new URL(req.url);
    const token = (url.searchParams.get("token") || "").trim();
    if (!token || token.length < 8 || token.length > 200) {
      return html(400, "Invalid link", `<h1>That link looks off.</h1><p>This unsubscribe link is missing or malformed. If you keep getting emails, reply to one and we'll remove you.</p><a href="https://kindredtrips.com/">Back to KindredTrips</a>`);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceRoleKey);

    const { data: row } = await sb.from("watch_subscriptions")
      .select("watch_id, unsubscribed_at").eq("unsubscribe_token", token).maybeSingle();
    if (!row) {
      return html(404, "Not found", `<h1>We couldn't find that watch.</h1><p>It may have already been removed. You won't receive further emails for it.</p><a href="https://kindredtrips.com/">Back to KindredTrips</a>`);
    }
    if (!row.unsubscribed_at) {
      await sb.from("watch_subscriptions")
        .update({ unsubscribed_at: new Date().toISOString() })
        .eq("watch_id", row.watch_id);
    }
    return html(200, "Unsubscribed", `<h1>You're unsubscribed.</h1><p>We won't email you about this trip again. You can start a new watch any time from your search results.</p><a href="https://kindredtrips.com/">Plan another trip →</a>`);
  } catch (_e) {
    return html(500, "Something went wrong", `<h1>Something went wrong.</h1><p>Please try again, or reply to one of our emails to be removed.</p><a href="https://kindredtrips.com/">Back to KindredTrips</a>`);
  }
});
