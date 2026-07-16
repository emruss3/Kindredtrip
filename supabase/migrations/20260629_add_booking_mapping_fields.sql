-- Verified Booking.com property mapping. Deep links must come from a verified
-- property URL, never a name/slug guess (slug guessing 404s, e.g. "Wyndham
-- Grand Cancun All Inclusive Resort & Villas").
ALTER TABLE public.resorts
  ADD COLUMN IF NOT EXISTS booking_property_url     text,
  ADD COLUMN IF NOT EXISTS booking_hotel_id         text,
  ADD COLUMN IF NOT EXISTS booking_last_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS booking_match_confidence numeric,
  ADD COLUMN IF NOT EXISTS booking_status           text NOT NULL DEFAULT 'unverified';

COMMENT ON COLUMN public.resorts.booking_property_url IS
  'Verified Booking.com property URL (booking.com/hotel/<cc>/<slug>.html). NULL until verified; deep links require this. Never derive from name/slug.';
COMMENT ON COLUMN public.resorts.booking_status IS
  'unverified | ok | not_found | redirected_to_search | name_mismatch — set by qa_booking_links / qa-booking-links.mjs.';

CREATE INDEX IF NOT EXISTS idx_resorts_booking_property_url
  ON public.resorts (resort_id) WHERE booking_property_url IS NOT NULL;
