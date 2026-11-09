// Official room evidence — the hotel's PUBLISHED occupancy policy, kept
// separate from partner (LiteAPI) inventory.
//
// Source: data/room-evidence/official.json, collected from hotel-brand room
// pages only. Each record carries the official URL, verbatim quotes and the
// collection date. Two facts must never be mixed:
//   - published policy: what the hotel says a named room can sleep
//   - partner coverage: the largest room our booking partner currently prices
//     (resorts.family_max / LiteAPI room catalogue), which can be smaller
// Separate adult and child caps stay separate caps — never summed into a
// party size. Only `max_occupancy` (a stated total) is a total.
import { readFileSync, existsSync } from "node:fs";

export function loadOfficialRooms(path) {
  const bySlug = new Map();
  if (!existsSync(path)) return { bySlug, collectedAt: null };
  const doc = JSON.parse(readFileSync(path, "utf8"));
  for (const r of doc.rooms || []) {
    if (!r.resort_slug || !r.room_name || !r.official_url) continue;
    if (!bySlug.has(r.resort_slug)) bySlug.set(r.resort_slug, []);
    bySlug.get(r.resort_slug).push({ ...r, verified: r.verified || doc.collected_at || null });
  }
  for (const list of bySlug.values()) list.sort((a, b) => (b.max_occupancy ?? 0) - (a.max_occupancy ?? 0));
  return { bySlug, collectedAt: doc.collected_at || null };
}

// Largest STATED total occupancy among a resort's official rooms.
export function officialLargest(rooms) {
  const withTotal = (rooms || []).filter((r) => Number.isFinite(r.max_occupancy) && r.max_occupancy > 0);
  return withTotal.length ? withTotal[0] : null;
}

// Human description of a room's caps, never adding adult + child caps.
export function capsText(r) {
  const parts = [];
  if (Number.isFinite(r.max_occupancy)) parts.push(`up to ${r.max_occupancy} guests total`);
  if (Number.isFinite(r.max_adults)) parts.push(`max ${r.max_adults} adults`);
  if (Number.isFinite(r.max_children)) parts.push(`max ${r.max_children} children`);
  if (!parts.length) return "occupancy not stated by the hotel";
  return parts.join(" · ");
}

export function connectingText(r) {
  if (r.connecting === "connected_unit") return "one bookable unit";
  if (r.connecting === "connecting_on_request") return "connecting rooms on request only — not guaranteed";
  return "connecting policy not stated";
}

// Does a published room fit a party under its stated caps? Returns
// true / false, or null when the hotel doesn't state enough to tell.
export function fitsParty(r, adults, childAges) {
  const kids = (childAges || []).length;
  const total = adults + kids;
  if (Array.isArray(r.combinations) && r.combinations.length) {
    const listed = r.combinations.some((c) => {
      const m = /(\d+)\s*adults?\D+(\d+)\s*child/i.exec(c);
      return m && Number(m[1]) >= adults && Number(m[2]) >= kids;
    });
    if (listed) return true;
  }
  if (Number.isFinite(r.max_occupancy) && total > r.max_occupancy) return false;
  if (Number.isFinite(r.max_adults) && adults > r.max_adults) return false;
  if (Number.isFinite(r.max_children) && kids > r.max_children) return false;
  if (Number.isFinite(r.max_occupancy)) return true;
  return null;
}
