// Unit tests for the family-eligibility, content-safety, and
// indexability rules. Run: node --test scripts/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  familyEligibility, familyEligible, nameMinAge, toddlerFit,
  hasFamilySignals, familyFitScore, mayCallAllInclusive, countAnswer,
  cleanSnippet, sentimentConflict, airportDisplay, indexability,
  slugify, displayName, FAMILY_WHITELIST,
} from "../lib/family-rules.mjs";

const base = { resort_name: "Test Resort", audience: "Family" };

// 1-2. Adults-only / couples-only can never be family_allowed.
test("adults-only audience is excluded", () => {
  assert.equal(familyEligibility({ ...base, audience: "Adults Only" }), "adults_only");
});
test("couples-only name is excluded even when audience says Family", () => {
  assert.equal(familyEligibility({ ...base, resort_name: "Sunny Cove (Couples only)" }), "couples_only");
  assert.equal(familyEligibility({ ...base, resort_name: "Couples Tower Isle" }), "couples_only");
});
test("brand keywords exclude: Sandals, Hedonism, Grand Lido, Secrets, Temptation", () => {
  for (const n of ["Sandals Royal Caribbean", "Hedonism II", "Grand Lido Negril", "Impression by Secrets", "Temptation Cancun"]) {
    assert.notEqual(familyEligibility({ ...base, resort_name: n }), "family_allowed", n);
  }
});
test("clothing-optional / nudist are excluded", () => {
  assert.notEqual(familyEligibility({ ...base, resort_name: "Breezy Bay (Clothing Optional)" }), "family_allowed");
  assert.notEqual(familyEligibility({ ...base, resort_name: "Sunset Nudist Retreat" }), "family_allowed");
});
test("minimum-age 12+ in name is excluded; under 12 is not", () => {
  assert.equal(familyEligibility({ ...base, resort_name: "Quiet Palms (16+)" }), "minimum_age_restricted");
  assert.equal(familyEligibility({ ...base, resort_name: "Family Fun Resort (8+)" }), "family_allowed");
});

// 3. Uncertain is ineligible.
test("missing audience signal is uncertain and ineligible", () => {
  const r = { resort_name: "Mystery Lodge", audience: null };
  assert.equal(familyEligibility(r), "uncertain");
  assert.equal(familyEligible(r), false);
});

// Whitelist protects verified family products that trip brand keywords.
test("whitelisted Finest by Excellence Collection stays family_allowed", () => {
  const name = "Finest Punta Cana By The Excellence Collection All Inclusive";
  assert.ok(FAMILY_WHITELIST.has(slugify(name)));
  assert.equal(familyEligibility({ resort_name: name, audience: "Family" }), "family_allowed");
});
test("non-whitelisted Excellence property is excluded", () => {
  assert.notEqual(familyEligibility({ ...base, resort_name: "Excellence Oyster Bay" }), "family_allowed");
});

// 5. All-inclusive claims require provider-verified status.
test("all-inclusive copy gate requires verified provider evidence", () => {
  assert.equal(mayCallAllInclusive({ ...base, all_inclusive: true }), true);
  assert.equal(mayCallAllInclusive({ ...base, all_inclusive: false }), false);
  assert.equal(mayCallAllInclusive({ ...base, resort_name: "Sunny All Inclusive Resort", all_inclusive: false }), false,
    "name containing 'All Inclusive' must not qualify");
});

// 6-7. Zero/one/many grammar; no affirmative from zero.
test("countAnswer never says Yes for zero", () => {
  const a = countAnswer({ count: 0, thing: "beachfront family resorts", place: "Dominica" });
  assert.match(a, /^No — KindredTrips does not currently track/);
  assert.doesNotMatch(a, /Yes/);
});
test("countAnswer handles one and many", () => {
  assert.match(countAnswer({ count: 1, thing: "kids clubs" }), /1 kids club\b/);
  assert.match(countAnswer({ count: 7, thing: "kids clubs" }), /7 kids clubs/);
});
test("countAnswer treats unknown as zero (no affirmative claim)", () => {
  assert.match(countAnswer({ count: undefined, thing: "water parks" }), /^No — /);
});

// Family-friendly gating.
test("no family signals -> not called family-friendly", () => {
  assert.equal(hasFamilySignals({ ...base }), false);
  assert.equal(hasFamilySignals({ ...base, kids_club: true }), true);
  assert.equal(hasFamilySignals({ ...base, family_max: 6 }), true);
  assert.equal(hasFamilySignals({ ...base, audience: "Adults Only", kids_club: true }), false,
    "adult property can never be family-friendly");
});

// Toddler fit respects name age limits.
test("toddlerFit blocked by name minimum age", () => {
  assert.equal(toddlerFit({ ...base, cribs: true }), true);
  assert.equal(toddlerFit({ ...base, cribs: true, resort_name: "Test Resort (8+)" }), false);
});

// Ranking: adult properties always rank below any family property.
test("familyFitScore hard-penalizes ineligible properties", () => {
  const fam = familyFitScore({ ...base, rating: 60 });
  const adult = familyFitScore({ ...base, audience: "Adults Only", rating: 99, kids_club: true, on_beach: true });
  assert.ok(fam > adult);
});

// Review safety.
test("cleanSnippet drops short fragments and fixes truncation", () => {
  assert.equal(cleanSnippet("Nice."), null);
  const t = cleanSnippet("The pool area was fantastic for our kids and the staff were grea");
  assert.ok(/…$|[.!?]$/.test(t));
});
test("sentimentConflict flags negative text in pros", () => {
  assert.equal(sentimentConflict({ average_score: 9, pros: "Absolutely terrible, worst stay ever" }), true);
  assert.equal(sentimentConflict({ average_score: 9, pros: "Wonderful beach", cons: "Pricey drinks" }), false);
});

// 21. Airport display format.
test("airport display is 'IATA — Full name'", () => {
  assert.equal(airportDisplay({ airport_iata: "MBJ", airport_name: "Sangster" }), "MBJ — Sangster International Airport");
  assert.equal(airportDisplay({ airport_iata: "XXX", airport_name: "Somewhere Intl" }), "XXX — Somewhere Intl");
  assert.equal(airportDisplay({ airport_name: "Somewhere" }), "Somewhere");
});

// Indexability gates.
test("country pages need 5 family-eligible resorts", () => {
  assert.equal(indexability({ template: "country", eligibleResultCount: 4 }).indexable, false);
  assert.equal(indexability({ template: "country", eligibleResultCount: 5 }).indexable, true);
});
test("theme pages need 5 verified matches", () => {
  assert.equal(indexability({ template: "theme", eligibleResultCount: 3 }).indexable, false);
});
test("origin-airport pages need real flight data", () => {
  assert.equal(indexability({ template: "from", hasRealFlightData: false }).indexable, false);
  assert.equal(indexability({ template: "from", hasRealFlightData: true }).indexable, true);
});
test("adult resort pages are not indexable", () => {
  assert.equal(indexability({ template: "resort", resortEligibility: "adults_only" }).indexable, false);
  assert.equal(indexability({ template: "resort", resortEligibility: "uncertain" }).indexable, false);
  assert.equal(indexability({ template: "resort", resortEligibility: "family_allowed" }).indexable, true);
});

// Display names strip policy parentheticals.
test("displayName strips parenthetical policy notes", () => {
  assert.equal(displayName({ resort_name: "Calm Bay (Adults only, No TV)" }), "Calm Bay");
});
test("nameMinAge parses the highest age gate", () => {
  assert.equal(nameMinAge({ resort_name: "X (Jan 12+ Allowed, Jun 6+)" }), 12);
  assert.equal(nameMinAge({ resort_name: "Plain Resort" }), null);
});

// Regression: parent-company brand fields must not poison family
// sibling brands (Beaches carries "Sandals Resorts International").
test("Beaches with Sandals parent brand stays family_allowed", () => {
  assert.equal(familyEligibility({
    resort_name: "Beaches Turks & Caicos",
    hotel_brand: "Sandals Resorts International",
    audience: "Family",
  }), "family_allowed");
});
test("policy phrase in brand/style field still excludes", () => {
  assert.notEqual(familyEligibility({
    resort_name: "Calm Bay Resort", hotel_brand: "X", hotel_style: "Adults Only boutique", audience: "Family",
  }), "family_allowed");
});

// --- toddler vs infant split (added for the toddler-page narrowing) ---
import { infantFriendly, toddlerFriendly, toddlerScore } from "../lib/family-rules.mjs";
test("infantFriendly is broad (infants OR cribs), toddlerFriendly is strict (kc_min<=3)", () => {
  const infantOnly = { ...base, cribs: true };            // no kids-club age
  assert.equal(infantFriendly(infantOnly), true);
  assert.equal(toddlerFriendly(infantOnly), false, "cribs alone is NOT toddler-friendly");
  const toddler = { ...base, kc_min: 3 };
  assert.equal(toddlerFriendly(toddler), true);
  const olderClub = { ...base, kc_min: 4 };
  assert.equal(toddlerFriendly(olderClub), false, "kids club from age 4 is not toddler-grade");
});
test("toddlerFriendly respects name age gates", () => {
  assert.equal(toddlerFriendly({ ...base, kc_min: 3, resort_name: "X (12+)" }), false);
});
test("toddlerScore rewards young childcare age + short transfer, not water parks", () => {
  const closeYoungClub = { ...base, kc_min: 1, transfer_min: 20, on_beach: true };
  const farOldWaterpark = { ...base, kc_min: 3, transfer_min: 130, water_park: true };
  assert.ok(toddlerScore(closeYoungClub) > toddlerScore(farOldWaterpark));
  // water_park adds nothing to the toddler score
  assert.equal(toddlerScore({ ...base, kc_min: 3 }), toddlerScore({ ...base, kc_min: 3, water_park: true }));
});

// --- verified qualifying-room evidence (family-of-five) ---
import { qualifyingRoom5, hasQualifyingRoom5, roomEvidenceLine } from "../lib/family-rules.mjs";
test("qualifyingRoom5 evidence surfaces real room data", () => {
  const r = { ...base, qual_room: { room: "Two-Bedroom Family Suite", occ: 6, ad: 4, ch: 4, beds: "1 King + 2 Double", v: "2026-05" } };
  assert.equal(hasQualifyingRoom5(r), true);
  const line = roomEvidenceLine(r);
  assert.match(line, /Two-Bedroom Family Suite/);
  assert.match(line, /sleeps up to 6/);
  assert.match(line, /max 4 adults, 4 children/);
  assert.match(line, /1 unit/);
  assert.equal(hasQualifyingRoom5({ ...base }), false);
  assert.equal(roomEvidenceLine({ ...base }), null);
});
