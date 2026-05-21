-- 2026-05-19: backfill on_beach / kids_club_available / accepts_infants
-- from data we already have on the resorts row, so the per-card "Family-
-- fit" chips on the trip details actually fire instead of staying blank.
--
-- Sources, in priority order:
--   on_beach              cap_facilities array, then amenities_text tokens
--   kids_club_available   cap_facilities array, amenities_text, cap_has_kids_club
--   accepts_infants       liteapi_policies POLICY_CHILDREN description
--
-- Coverage after running (2026-05-19): 696/974 on_beach=true,
-- 441/974 kids_club_available=true, 198/974 accepts_infants=true,
-- 21/974 accepts_infants=false. The rest are NULL because the source
-- columns themselves are NULL (resort has no cap_facilities /
-- amenities_text / liteapi_policies row), so we can't honestly verify
-- one way or the other. The frontend chips only fire on the truthy
-- branch, so a NULL stays silent rather than asserting something we
-- can't back.

update resorts
set on_beach = case
  when (
    (cap_facilities is not null and (
      'Beachfront property' = any(cap_facilities) or
      'On the beach' = any(cap_facilities) or
      'Private beach' = any(cap_facilities) or
      'Beach access' = any(cap_facilities)
    ))
    or (amenities_text ~* '\m(beach front|beach-front|beachfront|on the beach)\M')
    or (amenities_text ~* '(^|,\s*)beach(,|$|\s)')
  ) then true
  when cap_facilities is not null or amenities_text is not null then false
  else null
end
where on_beach is null;

update resorts
set kids_club_available = case
  when (
    (cap_facilities is not null and 'Supervised childcare/activities' = any(cap_facilities))
    or (amenities_text ~* '\mkids club\M')
    or (cap_has_kids_club = true)
  ) then true
  when cap_facilities is not null or amenities_text is not null then false
  else null
end
where kids_club_available is null;

with policy_summary as (
  select resort_id,
    bool_or(p->>'description' ~* 'children of any age are allowed') as allow_any,
    bool_or(p->>'description' ~* 'children (are )?not allowed') as ban_any
  from (
    select resort_id, jsonb_array_elements(liteapi_policies) as p
    from resorts where liteapi_policies is not null
  ) x
  where p->>'policy_type' = 'POLICY_CHILDREN'
  group by resort_id
)
update resorts r
set accepts_infants = case
  when ps.allow_any and not ps.ban_any then true
  when ps.ban_any and not ps.allow_any then false
  else null
end
from policy_summary ps
where r.resort_id = ps.resort_id
  and r.accepts_infants is null;
