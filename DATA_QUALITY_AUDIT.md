# DATA_QUALITY_AUDIT.md

Date: 2026-07-13. Source: `data/resorts-seo.json` (781 properties) + live Supabase checks.

## Eligibility distribution (rule: scripts/lib/family-rules.mjs)

| Class | Count | Treatment |
|---|---|---|
| family_allowed | 522 | Only class allowed on family surfaces |
| adults_only | 232 | Neutral noindexed pages, excluded everywhere family |
| couples_only | 24 | Same as adults_only |
| minimum_age_restricted (12+) | 3 | Same as adults_only |
| uncertain (no audience signal) | 5 | Excluded until verified |

## Eligibility contradictions found & resolved

- Historic: "(Couples only)" / "(16+)" names carrying `audience=Family` — now hard-blocked by the two-tier name detector; zero contradictions remain (validated in CI).
- Sandals/Couples/Hedonism II/Grand Lido/adults-only Hideaway and Royalton "Adults Only" properties: all classified out of family surfaces (232+24+3 records).
- **False positive fixed**: Beaches (family brand) was briefly excluded via parent brand "Sandals Resorts International"; brand keywords now match property names only. Regression test added.

## Uncertain records needing manual verification

Hamanasi Adventure and Dive Resort (Belize) · Turneffe Island Resort (Belize) · Iberostar Origin Laguna Azul (Mexico) · Krystal Grand Los Cabos (Mexico) · The Soco House (Saint Lucia)

## All-inclusive status

- 408→(post-dedupe) provider-verified AI properties: flag derives ONLY from observed live AI-board rate offers. 96 properties have "All Inclusive" in their display name; the name alone never sets the flag, and pages for unverified ones say "Not confirmed — check live rates".
- No optional-package data source exists yet (`offersOptionalAllInclusivePackage: null` in the model).

## Duplicates

- 16 duplicate rows (same property, thinner copy) service-excluded in the DB (`service_exclude_reason='duplicate_row_thin'`), incl. Merrils Beach II/III, The Royal Suites, Armar House. CI fails if a name+country duplicate reappears in the snapshot.
- Provider-ID duplicates prevented by unique partial index `uq_resorts_bookable_liteapi_id`.
- Beaches Negril + Negril Escape both mapped to LiteAPI `lp365c4`, which is actually "Negril Beach Club" → both excluded as misbooking risk; Beaches Negril verified ABSENT from LiteAPI's Jamaica inventory (cannot be offered).
- Name typos fixed at source: "Beaches/Riu Ochos Rios" → "Ocho Rios".

## Verification & staleness

- Kids-club ages: 23 properties verified against official brand pages (source URL + date in `resorts.kids_club_notes`); ~339 kids-club resorts remain "ages not confirmed" (displayed as such).
- 173 matched resorts lack a partner (LiteAPI) hotel name — the partner data endpoint returns nothing for these IDs; recommend a re-match pass.
- Transfer times: 4 implausible values (>80 mph implied) auto-nulled each build; all displayed transfer times are labeled approximate.
- Freshness fields (`verifiedAt` per fact) exist only for kids-club data today; extending Verification metadata to amenities/occupancy requires the enrichment pipeline to stamp `cap_fetched_at` per field (currently one timestamp per record).
