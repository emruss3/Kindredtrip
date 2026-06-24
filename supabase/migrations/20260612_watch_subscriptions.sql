CREATE TABLE IF NOT EXISTS public.watch_subscriptions (
  watch_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  package_id        uuid REFERENCES public.packages(package_id) ON DELETE SET NULL,
  resort_id         uuid REFERENCES public.resorts(resort_id)   ON DELETE SET NULL,
  search_id         uuid,
  threshold_usd     integer,
  captured_price    integer,
  origin_iata       text,
  date_start        date,
  date_end          date,
  adults            int,
  child_ages        jsonb,
  session_id        text,
  is_internal       boolean NOT NULL DEFAULT false,
  user_agent        text,
  unsubscribed_at   timestamptz,
  unsubscribe_token text NOT NULL DEFAULT encode(gen_random_bytes(24), 'base64'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT watch_subscriptions_email_check
    CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS watch_subscriptions_email_pkg_idx
  ON public.watch_subscriptions (lower(email), package_id) WHERE unsubscribed_at IS NULL;
CREATE INDEX IF NOT EXISTS watch_subscriptions_email_idx   ON public.watch_subscriptions (lower(email));
CREATE INDEX IF NOT EXISTS watch_subscriptions_session_idx ON public.watch_subscriptions (session_id);
ALTER TABLE public.watch_subscriptions ENABLE ROW LEVEL SECURITY;
