import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const F = createRequire(import.meta.url)("../../flex-dates.js");

const live = (resort_id, total, extra = {}) => ({
  resort_id, total_price: total, hotel_supplier: "liteapi", flight_supplier: "liteapi",
  flight_price_basis: "summed_oneway", resorts: { resort_name: "Resort " + resort_id }, ...extra,
});

test("shifts the whole trip, keeping the nights, across month ends", () => {
  assert.deepEqual(F.shiftTrip("2027-03-13", "2027-03-20", -1), { date_start: "2027-03-12", date_end: "2027-03-19" });
  assert.deepEqual(F.shiftTrip("2027-02-28", "2027-03-07", 1), { date_start: "2027-03-01", date_end: "2027-03-08" });
  assert.deepEqual(F.shiftTrip("2026-12-31", "2027-01-07", 1), { date_start: "2027-01-01", date_end: "2027-01-08" });
  assert.equal(F.shiftTrip("bad", "2027-01-07", 1), null);
});

test("skips an earlier window that would start today or in the past", () => {
  assert.deepEqual(F.flexWindows("2027-03-13", "2027-03-20", "2026-11-17").map((w) => w.offset), [-1, 1]);
  assert.deepEqual(F.flexWindows("2026-11-18", "2026-11-25", "2026-11-17").map((w) => w.offset), [1]);
});

test("re-prices only the top live results, once per resort", () => {
  const pkgs = [live("a", 5000), { ...live("b", 5100), flight_supplier: "pending" }, live("a", 5200), live("c", 5300), live("d", 5400)];
  assert.deepEqual(F.pickResorts(pkgs, 2), ["a", "c"]);
});

test("summary compares the same resorts in every window and flags the cheapest", () => {
  const ids = ["a", "c"];
  const rows = F.summarize(
    { date_start: "2027-03-13", date_end: "2027-03-20", packages: [live("a", 5000), live("c", 5300), live("z", 100)] },
    [
      { offset: -1, date_start: "2027-03-12", date_end: "2027-03-19", packages: [live("a", 4700), live("c", 5600)], status: "done" },
      { offset: 1, date_start: "2027-03-14", date_end: "2027-03-21", packages: [], status: "done" },
    ],
    ids,
  );
  assert.deepEqual(rows.map((r) => r.offset), [-1, 0, 1]);
  // "z" isn't in the compared set, so its $100 never counts.
  assert.equal(rows[1].cheapest.total, 5000);
  assert.equal(rows[0].cheapest.total, 4700);
  assert.equal(rows[0].isCheapest, true);
  assert.equal(rows[1].isCheapest, false);
  assert.equal(rows[2].cheapest, null);
});

test("non-live and outbound-only prices never count", () => {
  const ids = ["a"];
  const rows = F.summarize(
    { date_start: "2027-03-13", date_end: "2027-03-20", packages: [live("a", 5000)] },
    [{ offset: 1, date_start: "2027-03-14", date_end: "2027-03-21", packages: [
      live("a", 3000, { flight_price_basis: "oneway_outbound" }),
      live("a", 2000, { hotel_supplier: "pending" }),
    ] }],
    ids,
  );
  assert.deepEqual(rows.map((r) => r.offset), [0, 1]);
  assert.equal(rows[0].cheapest.total, 5000);
  assert.equal(rows[1].cheapest, null);
});

test("per-resort savings: best shifted window above the threshold", () => {
  const base = [live("a", 5000), live("c", 5300)];
  const shifted = [
    { offset: -1, date_start: "2027-03-12", date_end: "2027-03-19", packages: [live("a", 4800), live("c", 5290)] },
    { offset: 1, date_start: "2027-03-14", date_end: "2027-03-21", packages: [live("a", 4600)] },
  ];
  const s = F.savingsByResort(base, shifted, ["a", "c"], 25);
  assert.deepEqual(s.a, { offset: 1, date_start: "2027-03-14", date_end: "2027-03-21", total: 4600, saving: 400 });
  assert.equal(s.c, undefined); // $10 saving is below the threshold
});

test("day labels don't drift with the viewer's time zone", () => {
  assert.equal(F.dayLabel("2027-03-12"), "Fri, Mar 12");
  assert.equal(F.dayLabel("2027-01-01"), "Fri, Jan 1");
});
