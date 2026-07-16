-- APPLIED LIVE: 2026-07-03 (supabase_migrations 20260703021039)
-- Parity copy — this migration already ran in production via MCP.
-- Live definition exported via pg_get_functiondef 2026-07-13: raises the
-- route retry cap 3 -> 5 so transient LiteAPI 429/timeouts don't
-- permanently strand flight routes.
CREATE OR REPLACE FUNCTION public.claim_flight_routes(p_search_id uuid, p_limit integer)
 RETURNS SETOF flight_search_routes
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE public.flight_search_routes f
  SET status = 'fetching', claimed_at = now(), attempts = f.attempts + 1
  WHERE f.route_id IN (
    SELECT route_id FROM public.flight_search_routes
    WHERE (p_search_id IS NULL OR search_id = p_search_id)
      AND attempts < 5
      AND (status = 'pending'
           OR status = 'failed'
           OR (status = 'fetching' AND claimed_at IS NOT NULL AND claimed_at < now() - interval '3 minutes'))
    ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'fetching' THEN 1 ELSE 2 END, created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING f.*;
$function$;
