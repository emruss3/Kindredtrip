-- APPLIED LIVE: 2026-07-01 (supabase_migrations 20260701170617)
-- Parity copy — this migration already ran in production via MCP.
-- numeric(4,2) silently rolled back matcher writes once chain-bonus
-- scores exceeded 99.99; widen so high-confidence scores persist.
ALTER TABLE public.resorts
  ALTER COLUMN liteapi_match_score TYPE numeric(6,2);
