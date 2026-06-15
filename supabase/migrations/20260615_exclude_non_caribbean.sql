-- Exclude remaining non-Caribbean countries from search/AI/SEO surfaces.
--
-- Follow-up to the Brazil exclusion. Same service_excluded mechanism as
-- Cuba/Brazil. These are clearly outside a Caribbean-family-vacation
-- product:
--   Ecuador       - Pacific coast South America (2 Decameron resorts)
--   Peru          - Pacific coast South America (2 Decameron resorts)
--   United States - Florida Keys / Atlantic coast (3 resorts)
--
-- Bermuda is intentionally NOT excluded: Atlantic, but conventionally
-- grouped with Caribbean for vacation planning.
UPDATE public.resorts
SET service_excluded = true,
    service_excluded_reason = 'non_caribbean_country',
    updated_at = now()
WHERE country IN ('Ecuador', 'Peru', 'United States')
  AND NOT service_excluded;
