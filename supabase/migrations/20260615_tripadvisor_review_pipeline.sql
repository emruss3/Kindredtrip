-- TripAdvisor review-pull pipeline (internal-signal-only).
--
-- We have tripadvisor_location_id for 932 resorts (from the seed
-- spreadsheet ingest) — distinct path from the LiteAPI review aggregator.
-- Keep the queues + sentiment tables separate so they don't contend.
--
-- pull_tripadvisor_reviews edge function reads from tripadvisor_review_jobs,
-- calls https://api.content.tripadvisor.com/api/v1/location/{id}/reviews,
-- writes per-review rows to resort_reviews_raw (source='tripadvisor_direct')
-- and resort-level aggregates to resort_tripadvisor_family_sentiment.
--
-- IMPORTANT: requires a TRIPADVISOR_API_KEY Supabase secret. The function
-- returns 503 with a clear message if the key isn't set.

CREATE TABLE IF NOT EXISTS public.tripadvisor_review_jobs (
  resort_id uuid PRIMARY KEY REFERENCES public.resorts(resort_id) ON DELETE CASCADE,
  tripadvisor_location_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','fetching','done','no_reviews','failed')),
  reviews_pulled int NOT NULL DEFAULT 0,
  family_reviews_pulled int NOT NULL DEFAULT 0,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ta_review_jobs_pending
  ON public.tripadvisor_review_jobs (updated_at)
  WHERE status='pending';

ALTER TABLE public.tripadvisor_review_jobs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.resort_tripadvisor_family_sentiment (
  resort_id uuid PRIMARY KEY REFERENCES public.resorts(resort_id) ON DELETE CASCADE,
  tripadvisor_location_id text NOT NULL,
  family_review_count int NOT NULL DEFAULT 0,
  family_avg_rating numeric(3,2),
  total_review_count int,
  total_avg_rating numeric(3,2),
  top_family_phrases text[],
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.resort_tripadvisor_family_sentiment ENABLE ROW LEVEL SECURITY;

-- Seed the queue from in-service resorts that have a TA location id.
INSERT INTO public.tripadvisor_review_jobs (resort_id, tripadvisor_location_id, status)
SELECT r.resort_id, r.tripadvisor_location_id, 'pending'
FROM public.resorts r
WHERE r.tripadvisor_location_id IS NOT NULL
  AND NOT coalesce(r.service_excluded, false)
ON CONFLICT (resort_id) DO NOTHING;
