-- Security hardening (audit 2026-06-12). Applied via Supabase migration.
-- The browser only calls edge functions (service-role, bypasses RLS); it
-- never touches Postgres directly, so locking down anon has no app impact.

-- 1) CRITICAL: net_http_post_json (SECURITY DEFINER, arbitrary URL + auth
--    header) was callable by anon — an SSRF / credential-relay primitive.
REVOKE ALL ON FUNCTION public.net_http_post_json(text, jsonb, text, integer) FROM PUBLIC, anon, authenticated;

-- 2) Operational workers should not be public-triggerable.
REVOKE ALL ON FUNCTION public.drain_review_pull_queue()    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sweep_stuck_topup_searches() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.extract_family_signals(uuid) FROM PUBLIC, anon, authenticated;

-- 3) Enable RLS (deny-all to anon; service-role bypasses) on exposed tables.
ALTER TABLE public.flight_search_routes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flight_offers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flight_offer_segments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hotel_rate_offers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resort_review_sentiment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resort_family_signals   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resort_reviews_raw      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_pull_jobs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resort_embeddings       ENABLE ROW LEVEL SECURITY;

-- 4) SECURITY DEFINER views → security_invoker.
ALTER VIEW public.v_package_freshness           SET (security_invoker = on);
ALTER VIEW public.v_package_with_hotel_summary  SET (security_invoker = on);
ALTER VIEW public.v_flight_cache_lookup         SET (security_invoker = on);
ALTER VIEW public.v_package_with_flight_summary SET (security_invoker = on);
ALTER VIEW public.v_daily_funnel                SET (security_invoker = on);

-- 5) Pin search_path on flagged functions.
ALTER FUNCTION public.extract_family_signals(uuid)               SET search_path = public, pg_catalog;
ALTER FUNCTION public.set_updated_at()                           SET search_path = public, pg_catalog;
ALTER FUNCTION public.fsr_set_pax_sig()                          SET search_path = public, pg_catalog;
ALTER FUNCTION public.drain_review_pull_queue()                  SET search_path = public, pg_catalog;
ALTER FUNCTION public.cleanup_expired_flight_offers()            SET search_path = public, pg_catalog;
ALTER FUNCTION public.semantic_search_resorts_rpc(vector, integer, text[], boolean, uuid[]) SET search_path = public, pg_catalog;
ALTER FUNCTION public.update_total_price_for_airport(uuid, text) SET search_path = public, pg_catalog;
ALTER FUNCTION public.net_http_post_json(text, jsonb, text, integer) SET search_path = public, pg_catalog;
ALTER FUNCTION public.sweep_stuck_topup_searches()              SET search_path = public, pg_catalog;

-- 6) Drop unused anon INSERT policies (browser inserts via edge fns).
DROP POLICY IF EXISTS searches_insert_anon        ON public.searches;
DROP POLICY IF EXISTS outbound_clicks_insert_anon ON public.outbound_clicks;
DROP POLICY IF EXISTS search_signals_insert_anon  ON public.search_signals;
