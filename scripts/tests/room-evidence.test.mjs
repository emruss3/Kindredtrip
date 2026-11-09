import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadOfficialRooms, officialLargest, capsText, connectingText, fitsParty } from "../lib/room-evidence.mjs";

const { bySlug } = loadOfficialRooms(new URL("./fixtures/official-rooms.json", import.meta.url).pathname);
const ziva = bySlug.get("hyatt-ziva-cancun"), finest = bySlug.get("finest-playa-mujeres");

test("largest uses the hotel's stated TOTAL, sorted", () => {
  assert.equal(officialLargest(ziva).max_occupancy, 6);
  assert.equal(officialLargest(ziva).room_code, "2BDS");
});
test("separate adult/child caps are never summed into a total", () => {
  assert.equal(officialLargest(finest), null, "4 adults + 3 children caps must not become 'sleeps 7'");
  assert.equal(capsText(finest[0]), "max 4 adults · max 3 children");
  assert.doesNotMatch(capsText(finest[0]), /7/);
});
test("connecting-on-request is never presented as guaranteed", () => {
  assert.match(connectingText(finest[0]), /on request only — not guaranteed/);
  assert.equal(connectingText(ziva.find((r) => r.room_code === "BLST")), "connecting policy not stated");
  assert.equal(connectingText(ziva.find((r) => r.room_code === "2BDS")), "one bookable unit");
});
test("party fit follows published caps and combinations", () => {
  assert.equal(fitsParty(ziva.find((r) => r.room_code === "BLST"), 2, [8, 6, 3]), true);   // 5 total, 3 children
  assert.equal(fitsParty(ziva.find((r) => r.room_code === "BLST"), 2, [8, 6, 3, 1]), false); // 4 children > cap 3
  assert.equal(fitsParty(finest[0], 2, [9, 6, 3]), true);   // listed combination
  assert.equal(fitsParty(finest[0], 3, [9, 6, 3]), null);   // not listed, no stated total -> unknown
});

// Integrity of the real evidence file: every record is traceable to an
// official hotel page, dated, and uses only known connecting values.
test("data/room-evidence/official.json records are sourced and dated", () => {
  const path = new URL("../../data/room-evidence/official.json", import.meta.url);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const OK_CONNECT = new Set(["connected_unit", "connecting_on_request", "not_stated"]);
  const OK_METHOD = new Set(["automated_fetch", "manual_review"]);
  assert.ok(doc.rooms.length >= 20);
  for (const r of doc.rooms) {
    assert.match(r.official_url, /^https:\/\/www\.(hyatt|finestresorts|riu|hilton|palaceresorts|melia|velasresorts|hotelxcaret|nickresorts)\.com\//, r.room_name);
    assert.ok(r.verified || doc.collected_at, r.room_name);
    assert.ok(OK_CONNECT.has(r.connecting), `${r.room_name}: ${r.connecting}`);
    assert.ok(OK_METHOD.has(r.evidence_method), r.room_name);
    // Manual-review figures must say so on the page.
    if (r.evidence_method === "manual_review") assert.ok(r.source_note, r.room_name);
    assert.ok(Array.isArray(r.quotes) && r.quotes.length, r.room_name);
  }
  const hyatt = doc.rooms.filter((r) => r.resort_slug === "hyatt-ziva-cancun");
  assert.deepEqual(hyatt.map((r) => [r.room_code, r.max_occupancy, r.max_children]).sort(), [["2BDS", 6, 4], ["BLST", 5, 3]]);
  const fam = doc.rooms.find((r) => r.resort_slug === "finest-playa-mujeres" && r.room_name === "Family Suite");
  assert.ok(fam.combinations.includes("2 Adults, 3 Children"));
});
