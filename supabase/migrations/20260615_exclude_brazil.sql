-- Exclude Brazil from search/AI/SEO surfaces.
--
-- Brazil is South America (Atlantic coast), not Caribbean. We were
-- carrying 22 Brazilian beach resorts in the catalog from an earlier
-- bulk import but none of them fit our "Caribbean family vacations"
-- thesis. Same pattern as the earlier Cuba (OFAC) exclusion: flip
-- service_excluded, leave the row + any liteapi_hotel_id intact so we
-- don't lose history.
UPDATE public.resorts
SET service_excluded = true,
    service_excluded_reason = 'non_caribbean_country',
    updated_at = now()
WHERE country = 'Brazil'
  AND NOT service_excluded;
