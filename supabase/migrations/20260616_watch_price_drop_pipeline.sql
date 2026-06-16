-- Price-drop email pipeline for "Watch this trip".
--
-- The check_watch_price_drops edge function re-prices each active watch's
-- HOTEL live via LiteAPI and emails the subscriber via Resend ONLY when the
-- hotel rate has dropped below the lowest price seen for that watch (never a
-- "still available" nag). unsubscribe_watch handles one-click opt-out.
--
-- Notification-state columns on watch_subscriptions:
ALTER TABLE public.watch_subscriptions
  ADD COLUMN IF NOT EXISTS baseline_hotel_price integer,   -- hotel-only price at watch time
  ADD COLUMN IF NOT EXISTS baseline_flight_price integer,  -- flight-only price at watch time
  ADD COLUMN IF NOT EXISTS current_hotel_price integer,    -- last re-priced hotel total
  ADD COLUMN IF NOT EXISTS current_checked_at timestamptz, -- last time we re-priced
  ADD COLUMN IF NOT EXISTS last_notified_price integer,    -- hotel price we last emailed about
  ADD COLUMN IF NOT EXISTS last_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS check_error text;

-- Backfill the hotel/flight baseline split from the still-present package rows.
UPDATE public.watch_subscriptions w
SET baseline_hotel_price  = round(p.hotel_price)::int,
    baseline_flight_price = round(p.flight_price)::int
FROM public.packages p
WHERE p.package_id = w.package_id
  AND w.baseline_hotel_price IS NULL
  AND p.hotel_price IS NOT NULL;

-- Daily cron (managed in the DB, recorded here for reference):
--   SELECT cron.schedule(
--     'check_watch_price_drops_daily', '0 13 * * *',
--     $$ SELECT net.http_post(
--          url := '<project>/functions/v1/check_watch_price_drops',
--          headers := jsonb_build_object('Content-Type','application/json',
--                       'Authorization','Bearer <anon-jwt>'),
--          body := '{"max_watches": 25}'::jsonb,
--          timeout_milliseconds := 120000); $$);
--
-- Secrets required on the project: LiteAPI (already set) and RESEND_API_KEY
-- (+ optional RESEND_FROM). Until RESEND_API_KEY is set the checker re-prices
-- and records current prices but does not send, and does not advance
-- last_notified_price — so the first run after the key is configured delivers
-- any qualifying drop.
