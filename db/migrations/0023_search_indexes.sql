-- Two filters search-service.ts already applies with no supporting index:
-- `lower(p.district) = lower($x)` (independent of city — property_city_idx
-- alone doesn't help a district-only or cross-city district search) and
-- `p.property_type = ANY($x)`. Both partial on PUBLISHED, matching
-- property_city_idx's own scope (0002_properties.sql) — search only ever
-- reads published listings.

CREATE INDEX property_district_idx ON property (lower(district)) WHERE status = 'PUBLISHED';
CREATE INDEX property_type_idx ON property (property_type) WHERE status = 'PUBLISHED';
