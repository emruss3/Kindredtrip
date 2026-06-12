-- Mid-funnel instrumentation. search_signals existed but was empty + had
-- no session_id. Add the join key + an is_internal flag, plus a daily
-- funnel view. Events are written by the log_event edge function.
ALTER TABLE public.search_signals
  ADD COLUMN IF NOT EXISTS session_id  text,
  ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS search_signals_type_time_idx ON public.search_signals (signal_type, created_at DESC);
CREATE INDEX IF NOT EXISTS search_signals_session_idx   ON public.search_signals (session_id);

CREATE OR REPLACE VIEW public.v_funnel_steps
WITH (security_invoker = on) AS
SELECT
  date_trunc('day', created_at)::date AS day,
  COUNT(*) FILTER (WHERE signal_type = 'search_started')          AS search_started,
  COUNT(*) FILTER (WHERE signal_type = 'results_first_paint')     AS results_painted,
  COUNT(*) FILTER (WHERE signal_type = 'search_abandoned')        AS search_abandoned,
  COUNT(*) FILTER (WHERE signal_type = 'trip_opened')             AS trips_opened,
  COUNT(*) FILTER (WHERE signal_type = 'filter_applied')          AS filters_applied,
  COUNT(*) FILTER (WHERE signal_type = 'room_or_flight_selected') AS offers_selected,
  COUNT(*) FILTER (WHERE signal_type IN ('booking_click','watch_trip_click')) AS booking_intent
FROM public.search_signals
WHERE NOT is_internal
GROUP BY 1 ORDER BY 1 DESC;
