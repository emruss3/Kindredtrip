import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const S = createRequire(import.meta.url)("../../room-split.js");

// Two offers for a 14-person party split into 4 rooms (shape written by
// start_pricing v23 into raw_offer._room_parts).
const part = (occ, name, total, adults, kids, tag = "RFN") => ({
  occ, name, total, adults, children_ages: kids, max_occupancy: 4,
  board_type: "AI", board_name: "All Inclusive", refundable_tag: tag, mapped_room_id: null,
});
const cheap = {
  offer_id: "o1", total_price: 13350.76,
  room_parts: [
    part(1, "Junior Suite Partial Ocean View King", 3200, 2, [8, 6]),
    part(2, "Junior Suite Partial Ocean View King", 3200, 2, [5, 3]),
    part(3, "Preferred Club Junior Suite Ocean View Double", 3475.38, 2, [2]),
    part(4, "Preferred Club Junior Suite Ocean View Double", 3475.38, 2, [0]),
  ],
};
const club = {
  offer_id: "o2", total_price: 14308.88,
  room_parts: [
    part(1, "Preferred Club Junior Suite Ocean View Double", 3577.22, 2, [8, 6]),
    part(2, "Preferred Club Junior Suite Ocean View Double", 3577.22, 2, [5, 3]),
    part(3, "Preferred Club Junior Suite Ocean View Double", 3577.22, 2, [2]),
    part(4, "Preferred Club Junior Suite Ocean View Double", 3577.22, 2, [0]),
  ],
};
const single = { offer_id: "s1", total_price: 900, room_parts: null };

test("builds one picker per room with every room type seen for that room", () => {
  const rooms = S.buildRoomOptions([cheap, club, single]);
  assert.equal(rooms.length, 4);
  assert.deepEqual(rooms[0].options.map((o) => o.name), [
    "Junior Suite Partial Ocean View King",
    "Preferred Club Junior Suite Ocean View Double",
  ]);
  assert.equal(rooms[0].adults, 2);
  assert.deepEqual(rooms[0].children_ages, [8, 6]);
  // Room 3 has the same type in both offers: keep the lower live price.
  assert.equal(rooms[2].options.length, 1);
  assert.equal(rooms[2].options[0].total, 3475.38);
});

test("default picks reproduce the selected offer and its total", () => {
  const rooms = S.buildRoomOptions([cheap, club]);
  const picks = S.defaultPicks(rooms, cheap);
  assert.equal(S.totalFor(rooms, picks), 13350.76);
  assert.equal(S.matchingOffer([cheap, club], rooms, picks).offer_id, "o1");
});

test("upgrading one room changes only that room's price", () => {
  const rooms = S.buildRoomOptions([cheap, club]);
  const picks = S.defaultPicks(rooms, cheap);
  picks[0] = rooms[0].options.find((o) => o.name.startsWith("Preferred")).key;
  assert.equal(S.totalFor(rooms, picks), Math.round((13350.76 - 3200 + 3577.22) * 100) / 100);
  // A mix no single offer contains: no stored offer matches.
  assert.equal(S.matchingOffer([cheap, club], rooms, picks), null);
});

test("refundable and non-refundable rates are separate choices", () => {
  const nr = { ...cheap, offer_id: "o3", room_parts: cheap.room_parts.map((p) => ({ ...p, total: p.total - 100, refundable_tag: "NRFN" })) };
  const rooms = S.buildRoomOptions([cheap, nr]);
  assert.equal(rooms[0].options.length, 2);
  assert.equal(rooms[0].options[0].refundable, false);
  assert.equal(rooms[0].options[1].refundable, true);
});

test("no partial totals: a missing pick yields null", () => {
  const rooms = S.buildRoomOptions([cheap]);
  assert.equal(S.totalFor(rooms, [rooms[0].options[0].key, null, null, null]), null);
});

test("single-room and legacy offers produce no per-room picker", () => {
  assert.deepEqual(S.buildRoomOptions([single]), []);
  assert.deepEqual(S.buildRoomOptions([{ offer_id: "x", room_parts: [] }]), []);
});

test("guest labels name infants and pluralize correctly", () => {
  assert.equal(S.guestsLabel({ adults: 2, children_ages: [8, 0] }), "2 adults, 2 kids (8, infant)");
  assert.equal(S.guestsLabel({ adults: 1, children_ages: [] }), "1 adult");
  assert.equal(S.guestsLabel({ adults: 2, children_ages: [5] }), "2 adults, 1 kid (5)");
});

test("legacy combo names are parsed for a readable fallback", () => {
  assert.deepEqual(
    S.parseComboName("Preferred Club Junior Suite Ocean View Double  + Junior Suite Partial Ocean View King (4 rooms)"),
    { rooms: 4, types: ["Preferred Club Junior Suite Ocean View Double", "Junior Suite Partial Ocean View King"] },
  );
  assert.equal(S.parseComboName("Junior Suite King"), null);
});
