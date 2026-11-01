-- Offer retention: purge stale rate payloads, keep the intent history.
--
-- hotel_rate_offers / flight_offers / flight_offer_segments are raw LiteAPI
-- rate payloads. A rate is unbookable within hours, nothing user-facing ever
-- re-reads an old search, and these three tables were 4.3 GB of a 4.8 GB
-- database with no retention. searches / packages / search_signals /
-- outbound_clicks are the funnel + B2B intent data and are left alone.
--
-- Packages with an active watch_subscriptions row are exempt so
-- check_watch_price_drops keeps its baseline offers.
--
-- Scheduled nightly via pg_cron (see bottom). Deletes in bounded batches so a
-- single statement never holds a long lock on a busy table.

CREATE OR REPLACE FUNCTION public.purge_stale_offers(
  p_older_than interval DEFAULT interval '7 days',
  p_batch_size integer DEFAULT 20000,
  p_max_batches integer DEFAULT 200
)
RETURNS TABLE (hotel_offers_deleted bigint, flight_offers_deleted bigint, segments_deleted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cutoff  timestamptz := now() - p_older_than;
  v_hotel   bigint := 0;
  v_flight  bigint := 0;
  v_seg     bigint := 0;
  v_n       bigint;
  v_seg_n   bigint;
  v_i       integer := 0;
BEGIN
  -- 1. Hotel offers, by package age, skipping actively-watched packages.
  LOOP
    WITH victims AS (
      SELECT h.offer_id
      FROM hotel_rate_offers h
      JOIN packages p ON p.package_id = h.package_id
      WHERE p.created_at < v_cutoff
        AND NOT EXISTS (
          SELECT 1 FROM watch_subscriptions w
          WHERE w.package_id = p.package_id AND w.unsubscribed_at IS NULL
        )
      LIMIT p_batch_size
    )
    DELETE FROM hotel_rate_offers h USING victims v WHERE h.offer_id = v.offer_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_hotel := v_hotel + v_n;
    v_i := v_i + 1;
    EXIT WHEN v_n = 0 OR v_i >= p_max_batches;
  END LOOP;

  -- 2. Flight offers, by route age. Segments cascade via FK; count them before deleting.
  v_i := 0;
  LOOP
    CREATE TEMP TABLE IF NOT EXISTS _purge_victims (offer_id text PRIMARY KEY) ON COMMIT DROP;
    TRUNCATE _purge_victims;

    INSERT INTO _purge_victims
    SELECT f.offer_id
    FROM flight_offers f
    JOIN flight_search_routes r ON r.route_id = f.route_id
    WHERE r.created_at < v_cutoff
    LIMIT p_batch_size;

    SELECT count(*) INTO v_seg_n
    FROM flight_offer_segments s JOIN _purge_victims v ON v.offer_id = s.offer_id;

    DELETE FROM flight_offers f USING _purge_victims v WHERE f.offer_id = v.offer_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    v_flight := v_flight + v_n;
    v_seg    := v_seg + v_seg_n;
    v_i := v_i + 1;
    EXIT WHEN v_n = 0 OR v_i >= p_max_batches;
  END LOOP;

  RETURN QUERY SELECT v_hotel, v_flight, v_seg;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_stale_offers(interval, integer, integer) FROM PUBLIC, anon, authenticated;

-- Nightly at 09:17 UTC (03:17 Central), after the 06:00/07:00/08:00 prewarm + photo jobs.
SELECT cron.unschedule('purge_stale_offers_nightly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge_stale_offers_nightly');
SELECT cron.schedule(
  'purge_stale_offers_nightly',
  '17 9 * * *',
  $cron$ SELECT public.purge_stale_offers(interval '7 days'); $cron$
);
