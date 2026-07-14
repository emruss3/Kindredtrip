-- APPLIED LIVE: 2026-07-13 (supabase_migrations 20260713024707)
-- Parity copy — this migration already ran in production via MCP.
-- Canonical definition of the SEO snapshot consumed by
-- scripts/generate-seo-pages.mjs (via the seo_snapshot edge function or
-- a direct export). One place to add fields; the static site's public
-- counts all derive from this.
create or replace view seo_resort_snapshot as
select r.resort_id, r.resort_name, r.country, r.area,
  r.airport_code as airport_iata, r.airport_name,
  r.airport_transfer_minutes as transfer_min,
  round(r.cap_star_rating)::int as stars,
  r.avg_user_rating as rating, r.review_count as reviews,
  (coalesce(r.kids_club_available,false) or coalesce(r.cap_has_kids_club,false)) as kids_club,
  r.kids_club_min_age as kc_min, r.kids_club_max_age as kc_max,
  (coalesce(r.on_beach,false) or coalesce(r.cap_has_beach_access,false)) as on_beach,
  (coalesce(r.water_park,false) or coalesce(r.cap_has_water_park,false)) as water_park,
  coalesce(r.cap_has_pool,false) as pool,
  coalesce(r.cap_has_spa,false) as spa,
  (coalesce(r.connecting_rooms_available,false) or coalesce(r.guaranteed_connecting_rooms,false) or coalesce(r.cap_has_connecting,false)) as connecting,
  coalesce(r.family_room_max_occupancy, r.cap_max_room_occupancy) as family_max,
  coalesce(r.accepts_infants,false) as infants,
  coalesce(r.cap_has_cribs,false) as cribs,
  coalesce(r.cap_has_sofa_bed,false) as sofa_bed,
  coalesce(r.cap_has_family_room,false) as family_room,
  coalesce(r.cap_child_allowed,false) as child_allowed,
  coalesce(r.cap_has_villa,false) as villa,
  coalesce(r.cap_has_suite,false) as suite,
  r.audience, r.hotel_style, r.hotel_brand,
  exists (select 1 from hotel_rate_offers o where o.resort_id = r.resort_id and o.is_all_inclusive) as all_inclusive,
  r.liteapi_hotel_id, r.liteapi_hotel_name,
  (r.photo_refs->>0) as photo_ref,
  r.latitude as lat, r.longitude as lng
from resorts r
where r.service_excluded is not true;
