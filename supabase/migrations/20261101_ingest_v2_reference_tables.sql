-- Reference data for ingest_liteapi_hotels v2.
--
-- 1. liteapi_facilities: LiteAPI facilityId -> name. The hotel LIST
--    endpoint only returns numeric facilityIds; the DETAIL payloads we
--    already cache in resorts.cap_raw_detail carry {facilityId, name}
--    pairs. Seeded from those (558 ids) so the ingest can test
--    beach / pool / kids-club / adults-only without constants in code.
--    Re-run the INSERT ... ON CONFLICT any time to pick up new ids.
--
-- 2. airports: destination airports with real coordinates, used for
--    nearest-airport assignment of newly ingested hotels. Rows for
--    islands not yet in the catalog (SJU, GCM, AXA, SKB, SXM, STT, STX,
--    BDA, ...) are entered directly; airports already used by curated
--    resorts get their centroid as a fallback where no real coordinate
--    is given.

CREATE TABLE IF NOT EXISTS public.liteapi_facilities (
  facility_id integer PRIMARY KEY,
  name        text NOT NULL,
  seen_count  integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.liteapi_facilities ENABLE ROW LEVEL SECURITY;

INSERT INTO public.liteapi_facilities (facility_id, name, seen_count)
SELECT (x->>'facilityId')::int, min(x->>'name'), count(*)
FROM public.resorts, jsonb_array_elements(cap_raw_detail->'facilities') x
WHERE jsonb_typeof(cap_raw_detail->'facilities') = 'array'
  AND (x->>'facilityId') ~ '^\d+$'
GROUP BY 1
ON CONFLICT (facility_id) DO UPDATE
  SET name = EXCLUDED.name, seen_count = EXCLUDED.seen_count, updated_at = now();

-- public.airports already exists (iata_code, airport_name, city, country, region, lat, lng) and is empty.
-- Real coordinates for the destination airports that matter.
INSERT INTO public.airports (iata_code, airport_name, city, country, region, lat, lng) VALUES
  ('SJU','Luis Muñoz Marín Intl','San Juan','Puerto Rico','Caribbean',18.4394,-66.0018),
  ('BQN','Rafael Hernández','Aguadilla','Puerto Rico','Caribbean',18.4949,-67.1294),
  ('PSE','Mercedita','Ponce','Puerto Rico','Caribbean',18.0083,-66.5630),
  ('GCM','Owen Roberts Intl','George Town','Grand Cayman','Caribbean',19.2928,-81.3577),
  ('AXA','Clayton J. Lloyd Intl','The Valley','Anguilla','Caribbean',18.2048,-63.0551),
  ('SKB','Robert L. Bradshaw Intl','Basseterre','Saint Kitts and Nevis','Caribbean',17.3112,-62.7187),
  ('NEV','Vance W. Amory Intl','Charlestown','Saint Kitts and Nevis','Caribbean',17.2057,-62.5899),
  ('SXM','Princess Juliana Intl','Philipsburg','Sint Maarten','Caribbean',18.0410,-63.1089),
  ('STT','Cyril E. King','Charlotte Amalie','Saint Thomas','Caribbean',18.3373,-64.9734),
  ('STX','Henry E. Rohlsen','Christiansted','Saint Croix','Caribbean',17.7019,-64.7986),
  ('BDA','L.F. Wade Intl','Hamilton','Bermuda','Atlantic',32.3640,-64.6787),
  ('PLS','Providenciales Intl','Providenciales','Turks and Caicos','Caribbean',21.7736,-72.2659),
  ('NAS','Lynden Pindling Intl','Nassau','Bahamas','Caribbean',25.0390,-77.4662),
  ('ELH','North Eleuthera','North Eleuthera','Bahamas','Caribbean',25.4749,-76.6835),
  ('GGT','Exuma Intl','George Town','Bahamas','Caribbean',23.5626,-75.8780),
  ('FPO','Grand Bahama Intl','Freeport','Bahamas','Caribbean',26.5587,-78.6956),
  ('AUA','Queen Beatrix Intl','Oranjestad','Aruba','Caribbean',12.5014,-70.0152),
  ('CUR','Hato Intl','Willemstad','Curaçao','Caribbean',12.1889,-68.9598),
  ('BON','Flamingo Intl','Kralendijk','Bonaire','Caribbean',12.1310,-68.2685),
  ('BGI','Grantley Adams Intl','Bridgetown','Barbados','Caribbean',13.0746,-59.4925),
  ('UVF','Hewanorra Intl','Vieux Fort','Saint Lucia','Caribbean',13.7332,-60.9526),
  ('SLU','George F.L. Charles','Castries','Saint Lucia','Caribbean',14.0202,-60.9929),
  ('ANU','V.C. Bird Intl','St. John''s','Antigua and Barbuda','Caribbean',17.1367,-61.7927),
  ('GND','Maurice Bishop Intl','St. George''s','Grenada','Caribbean',12.0042,-61.7862),
  ('SVD','Argyle Intl','Kingstown','Saint Vincent and the Grenadines','Caribbean',13.1443,-61.2109),
  ('DOM','Douglas–Charles','Marigot','Dominica','Caribbean',15.5470,-61.3000),
  ('FDF','Martinique Aimé Césaire','Fort-de-France','Martinique','Caribbean',14.5910,-60.9962),
  ('PTP','Pointe-à-Pitre Intl','Pointe-à-Pitre','Guadeloupe','Caribbean',16.2653,-61.5318),
  ('POS','Piarco Intl','Port of Spain','Trinidad and Tobago','Caribbean',10.5954,-61.3372),
  ('TAB','A.N.R. Robinson Intl','Scarborough','Trinidad and Tobago','Caribbean',11.1497,-60.8322),
  ('EIS','Terrance B. Lettsome Intl','Tortola','British Virgin Islands','Caribbean',18.4448,-64.5430),
  ('MBJ','Sangster Intl','Montego Bay','Jamaica','Caribbean',18.5037,-77.9134),
  ('KIN','Norman Manley Intl','Kingston','Jamaica','Caribbean',17.9357,-76.7875),
  ('PUJ','Punta Cana Intl','Punta Cana','Dominican Republic','Caribbean',18.5674,-68.3634),
  ('SDQ','Las Américas Intl','Santo Domingo','Dominican Republic','Caribbean',18.4297,-69.6689),
  ('POP','Gregorio Luperón Intl','Puerto Plata','Dominican Republic','Caribbean',19.7579,-70.5700),
  ('LRM','La Romana Intl','La Romana','Dominican Republic','Caribbean',18.4507,-68.9118),
  ('STI','Cibao Intl','Santiago','Dominican Republic','Caribbean',19.4061,-70.6047),
  ('CUN','Cancún Intl','Cancún','Mexico','Caribbean',21.0365,-86.8771),
  ('CZM','Cozumel Intl','Cozumel','Mexico','Caribbean',20.5224,-86.9256),
  ('TQO','Tulum Intl','Tulum','Mexico','Caribbean',20.1396,-87.5208),
  ('PVR','Puerto Vallarta Intl','Puerto Vallarta','Mexico','Pacific',20.6801,-105.2544),
  ('SJD','Los Cabos Intl','San José del Cabo','Mexico','Pacific',23.1518,-109.7215),
  ('MZT','Mazatlán Intl','Mazatlán','Mexico','Pacific',23.1614,-106.2660),
  ('ZIH','Ixtapa-Zihuatanejo Intl','Zihuatanejo','Mexico','Pacific',17.6016,-101.4606),
  ('ACA','Acapulco Intl','Acapulco','Mexico','Pacific',16.7571,-99.7540),
  ('HUX','Huatulco Intl','Huatulco','Mexico','Pacific',15.7753,-96.2626),
  ('ZLO','Manzanillo Intl','Manzanillo','Mexico','Pacific',19.1448,-104.5586),
  ('LTO','Loreto Intl','Loreto','Mexico','Pacific',25.9892,-111.3483),
  ('SJO','Juan Santamaría Intl','San José','Costa Rica','Central America',9.9939,-84.2088),
  ('LIR','Guanacaste Intl','Liberia','Costa Rica','Central America',10.5933,-85.5444),
  ('PTY','Tocumen Intl','Panama City','Panama','Central America',9.0714,-79.3835),
  ('RTB','Juan Manuel Gálvez Intl','Roatán','Honduras','Central America',16.3168,-86.5230),
  ('BZE','Philip S.W. Goldson Intl','Belize City','Belize','Central America',17.5391,-88.3082),
  ('GUA','La Aurora Intl','Guatemala City','Guatemala','Central America',14.5833,-90.5275),
  ('SAL','El Salvador Intl','San Salvador','El Salvador','Central America',13.4409,-89.0557),
  ('MGA','Augusto C. Sandino Intl','Managua','Nicaragua','Central America',12.1415,-86.1682),
  ('CTG','Rafael Núñez Intl','Cartagena','Colombia','Caribbean',10.4424,-75.5130),
  ('SMR','Simón Bolívar Intl','Santa Marta','Colombia','Caribbean',11.1196,-74.2306),
  ('ADZ','Gustavo Rojas Pinilla Intl','San Andrés','Colombia','Caribbean',12.5836,-81.7112),
  ('BAQ','Ernesto Cortissoz Intl','Barranquilla','Colombia','Caribbean',10.8896,-74.7808),
  ('PAP','Toussaint Louverture Intl','Port-au-Prince','Haiti','Caribbean',18.5800,-72.2925),
  ('CAP','Hugo Chávez Intl','Cap-Haïtien','Haiti','Caribbean',19.7330,-72.1947)
ON CONFLICT DO NOTHING;

-- Fallback: any airport code used by curated resorts that isn't listed above
-- gets the centroid of its resorts, so nearest-airport never comes back empty.
INSERT INTO public.airports (iata_code, airport_name, city, country, region, lat, lng)
SELECT r.airport_code, min(r.airport_name), NULL, min(r.country), 'centroid_fallback',
       avg(r.latitude), avg(r.longitude)
FROM public.resorts r
WHERE r.airport_code IS NOT NULL AND r.latitude IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.airports a WHERE a.iata_code = r.airport_code)
GROUP BY r.airport_code
ON CONFLICT DO NOTHING;
