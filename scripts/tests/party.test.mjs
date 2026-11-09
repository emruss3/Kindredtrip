// Regression coverage for the traveler-loss bug: the BNA landing form sent
// kids=8%2C+6%2C+3 and results showed "family of 3, kids ages 8".
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const KTParty = createRequire(import.meta.url)("../../party.js");
const qs = (s) => new URLSearchParams(s);

test("exact BNA reproduction: kids=8%2C+6%2C+3 -> three children", () => {
  const p = KTParty.parseParty(qs("origin=BNA&adults=2&kids=8%2C+6%2C+3"));
  assert.deepEqual(p.kids, [8, 6, 3]);
  assert.equal(p.adults, 2);
  assert.equal(p.invalid.length, 0);
  assert.equal(KTParty.describe(p.adults, p.kids), "family of 5 (kids ages 8, 6, 3)");
});
test("other encodings of the same ages", () => {
  for (const s of ["kids=8,6,3", "kids=8%2C6%2C3", "kids=8+6+3", "kids=%208%20,%206%20,3%20"])
    assert.deepEqual(KTParty.parseParty(qs(s)).kids, [8, 6, 3], s);
});
test("single child and infant aged zero", () => {
  assert.deepEqual(KTParty.parseParty(qs("kids=5")).kids, [5]);
  assert.deepEqual(KTParty.parseParty(qs("kids=0")).kids, [0]);
  assert.deepEqual(KTParty.parseParty(qs("kids=7,0")).kids, [7, 0]);
  assert.deepEqual(KTParty.parseKids("<1").kids, [0]);
});
test("explicit adults-only vs absent parameter", () => {
  const explicit = KTParty.parseParty(qs("adults=2&kids="));
  assert.deepEqual(explicit.kids, []);
  assert.equal(explicit.kidsExplicit, true);
  const absent = KTParty.parseParty(qs("adults=2"));
  assert.equal(absent.kids, null);
  assert.equal(absent.kidsExplicit, false);
});
test("malformed and out-of-range values are surfaced, not dropped", () => {
  const p = KTParty.parseParty(qs("adults=2&kids=8,abc,18,6"));
  assert.deepEqual(p.kids, [8, 6]);
  assert.deepEqual(p.invalid, ["abc", "18"]);
  assert.deepEqual(KTParty.parseParty(qs("kids=-3")).invalid, ["-3"]);
  assert.deepEqual(KTParty.parseParty(qs("kids=4.5")).invalid, ["4.5"]);
});
test("adults validation", () => {
  assert.equal(KTParty.parseParty(qs("adults=3")).adults, 3);
  assert.equal(KTParty.parseParty(qs("")).adults, null);
  assert.deepEqual(KTParty.parseParty(qs("adults=0")).invalid, ["adults: 0"]);
  assert.deepEqual(KTParty.parseParty(qs("adults=two")).invalid, ["adults: two"]);
});
test("more than 12 children is flagged and capped at the Search limit", () => {
  const p = KTParty.parseKids(Array(13).fill(5).join(","));
  assert.equal(p.kids.length, 12);
  assert.ok(p.invalid.length === 1);
});
