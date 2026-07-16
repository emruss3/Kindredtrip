-- Atomic route claim for parallel flight workers. FOR UPDATE SKIP LOCKED
-- prevents two workers grabbing the same routes; attempts is incremented at
-- claim time (v5's attempts was never incremented, making its retry guards
-- dead code and leaving 'failed' routes permanently stuck). Also reclaims
-- routes stuck in 'fetching' >3 min (dead-isolate recovery).
ALTER TABLE public.flight_search_routes ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

CREATE OR REPLACE FUNCTION public.claim_flight_routes(p_search_id uuid, p_limit int)
RETURNS SETOF public.flight_search_routes
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.flight_search_routes f
  SET status = 'fetching', claimed_at = now(), attempts = f.attempts + 1
  WHERE f.route_id IN (
    SELECT route_id FROM public.flight_search_routes
    WHERE (p_search_id IS NULL OR search_id = p_search_id)
      AND attempts < 3
      AND (status = 'pending'
           OR status = 'failed'
           OR (status = 'fetching' AND claimed_at IS NOT NULL AND claimed_at < now() - interval '3 minutes'))
    ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'fetching' THEN 1 ELSE 2 END, created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING f.*;
$$;

REVOKE ALL ON FUNCTION public.claim_flight_routes(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_flight_routes(uuid, int) TO service_role;
