// Known-property canaries: real records whose classification is
// unambiguous. Run on every build; if any of these flips, the
// eligibility pipeline is broken regardless of what the unit tests say.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { familyEligibility, mayCallAllInclusive } from "../lib/family-rules.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const snapshot = JSON.parse(readFileSync(join(ROOT, "data/resorts-seo.json"), "utf8"));
const find = (needle) => snapshot.find((r) => r.resort_name.toLowerCase().includes(needle));

// --- classifier-level canaries (synthetic records, no snapshot needed) ---
test("canary: Sandals Royal Plantation classifies out of family", () => {
  assert.notEqual(familyEligibility({ resort_name: "Sandals Royal Plantation", audience: "Family" }), "family_allowed");
});
test("canary: Hedonism II classifies out of family", () => {
  assert.notEqual(familyEligibility({ resort_name: "Hedonism II", audience: "Family" }), "family_allowed");
});
test("canary: Couples Tower Isle classifies couples_only", () => {
  assert.equal(familyEligibility({ resort_name: "Couples Tower Isle", audience: "Family" }), "couples_only");
});
test("canary: Beaches Negril name classifies family_allowed", () => {
  // Beaches Negril is intentionally absent from the bookable catalogue
  // (its provider ID resolved to a different hotel and the property is
  // absent from the supplier's inventory) — but the CLASSIFIER must
  // treat the Beaches family brand as family_allowed.
  assert.equal(familyEligibility({
    resort_name: "Beaches Negril",
    hotel_brand: "Sandals Resorts International",
    audience: "Family",
  }), "family_allowed");
});

// --- snapshot-level canaries (the real catalogue rows) ---
test("canary: snapshot Sandals Royal Plantation is not family_allowed", () => {
  const r = find("sandals royal plantation");
  assert.ok(r, "expected in snapshot");
  assert.notEqual(familyEligibility(r), "family_allowed");
});
test("canary: snapshot Hedonism II is not family_allowed", () => {
  const r = find("hedonism");
  assert.ok(r, "expected in snapshot");
  assert.notEqual(familyEligibility(r), "family_allowed");
});
test("canary: snapshot Couples Tower Isle is couples_only", () => {
  const r = find("couples tower isle");
  assert.ok(r, "expected in snapshot");
  assert.equal(familyEligibility(r), "couples_only");
});
test("canary: snapshot Westin Reserva Conchal is family_allowed + verified all-inclusive", () => {
  const r = find("westin reserva conchal");
  assert.ok(r, "expected in snapshot");
  assert.equal(familyEligibility(r), "family_allowed");
  assert.equal(mayCallAllInclusive(r), true);
});
test("canary: no property named Sandals/Hedonism/Couples is family_allowed in the snapshot", () => {
  for (const r of snapshot) {
    if (/\b(sandals|hedonism)\b|couples (tower|resorts|negril|sans|swept)/i.test(r.resort_name)) {
      assert.notEqual(familyEligibility(r), "family_allowed", r.resort_name);
    }
  }
});
