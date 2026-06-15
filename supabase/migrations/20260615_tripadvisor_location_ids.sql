-- TripAdvisor location IDs from the original seed spreadsheet.
--
-- The catalogue was originally hand-built in an Excel workbook
-- ("All Inclusive Resort Ratings") whose resort-name cells carried
-- TripAdvisor hyperlinks. Each URL embeds the stable TripAdvisor
-- location id (the -d<digits>- segment), which is the canonical key for
-- pulling reviews / the family-traveler review slice / photos via the
-- TripAdvisor Content API.
--
-- 932 of 974 resorts had a link; matched to resorts by exact name
-- (identical source, ~100% hit). The ~40 without a link are mostly
-- brand-new/2027 properties not yet on TripAdvisor plus a few duplicate
-- catalogue rows.
--
-- Columns are populated by a one-shot ingest (parse the workbook -> stage
-- -> exact-name match). This migration just records the schema.
ALTER TABLE public.resorts
  ADD COLUMN IF NOT EXISTS tripadvisor_url text,
  ADD COLUMN IF NOT EXISTS tripadvisor_location_id text,
  ADD COLUMN IF NOT EXISTS tripadvisor_matched_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_resorts_tripadvisor_location_id
  ON public.resorts (tripadvisor_location_id)
  WHERE tripadvisor_location_id IS NOT NULL;
