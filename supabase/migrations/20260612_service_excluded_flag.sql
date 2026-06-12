-- Data-driven exclusion. Used to hide a resort from search, SEO,
-- AI search, and the destinations index. First case: Cuba (US OFAC).
ALTER TABLE public.resorts
  ADD COLUMN IF NOT EXISTS service_excluded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS service_excluded_reason text;
CREATE INDEX IF NOT EXISTS resorts_service_excluded_idx
  ON public.resorts (service_excluded) WHERE service_excluded = true;
UPDATE public.resorts
SET service_excluded = true,
    service_excluded_reason = 'US OFAC restrictions — most Cuba inventory not legally bookable by US travelers'
WHERE country = 'Cuba';
