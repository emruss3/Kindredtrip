-- APPLIED LIVE: 2026-07-17 (via MCP execute_sql). Parity copy.
--
-- Verified family-of-five room evidence. For each family-eligible resort
-- with a LiteAPI room catalogue (cap_raw_detail.rooms), pick the smallest
-- room whose stated capacity genuinely fits 2 adults + 3 children in one
-- unit (maxOccupancy >= 5, maxAdults >= 2, maxChildren >= 3) and store a
-- compact evidence object. The SEO family-of-5 / large-family pages are
-- gated on this column so they never claim a family-size fit from a
-- generic maximum-guest number alone.

alter table public.resorts add column if not exists qualifying_room_5 jsonb;

with fam as (
  select resort_id, cap_fetched_at, cap_raw_detail
  from public.resorts
  where service_excluded is not true
    and audience is distinct from 'Adults Only'
    and cap_raw_detail ? 'rooms'
    and coalesce(family_room_max_occupancy, cap_max_room_occupancy) >= 5
),
rooms as (
  select f.resort_id, f.cap_fetched_at,
    (rm->>'roomName') as room_name,
    nullif(rm->>'maxOccupancy','')::int as max_occ,
    nullif(rm->>'maxAdults','')::int as max_adults,
    nullif(rm->>'maxChildren','')::int as max_children,
    rm->'bedTypes' as bed_types,
    nullif(rm->>'roomSizeSquare','')::numeric as size
  from fam f, jsonb_array_elements(f.cap_raw_detail->'rooms') rm
),
qualifying as (
  select *, row_number() over (partition by resort_id order by max_occ asc, coalesce(size, 9999) asc) rn
  from rooms
  where max_occ >= 5 and max_adults >= 2 and max_children >= 3
)
update public.resorts r set qualifying_room_5 = jsonb_build_object(
  'room', left(q.room_name, 90),
  'occ', q.max_occ, 'ad', q.max_adults, 'ch', q.max_children,
  'beds', (select string_agg((case when (bt->>'quantity')::int>1 then (bt->>'quantity')||'x ' else '' end)||(bt->>'bedType'),' + ')
           from jsonb_array_elements(q.bed_types) bt where bt->>'bedType' is not null),
  'v', to_char(q.cap_fetched_at,'YYYY-MM')
)
from qualifying q where q.rn = 1 and q.resort_id = r.resort_id;

-- seo_resort_snapshot gains qualifying_room_5 (appended last so
-- CREATE OR REPLACE preserves existing column order). Full definition in
-- 20260713_seo_resort_snapshot_view.sql; this only adds the trailing column.
-- (See that file for the canonical body.)
