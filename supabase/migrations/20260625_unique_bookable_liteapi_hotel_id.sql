-- APPLIED LIVE: 2026-06-25 (supabase_migrations 20260625031026)
-- Parity copy — this migration already ran in production via MCP.
-- One bookable resort per LiteAPI hotel id: prevents two catalogue rows
-- from mapping to the same partner hotel (misbooking risk).
CREATE UNIQUE INDEX IF NOT EXISTS uq_resorts_bookable_liteapi_id
  ON public.resorts USING btree (liteapi_hotel_id)
  WHERE ((liteapi_hotel_id IS NOT NULL) AND (service_excluded = false));
