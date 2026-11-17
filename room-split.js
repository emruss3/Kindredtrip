/* KindredTrips — multi-room stays, one room at a time.
 *
 * Big families are priced as N separate rooms (start_pricing splits the
 * party ~4 guests per room). Each hotel offer then carries `room_parts`:
 * one live LiteAPI rate per room, in room order, with that room's guests.
 * The offer's total is the sum of its parts.
 *
 * This module turns those offers into a per-room picker:
 *   buildRoomOptions(offers)  -> [{ index, adults, children_ages, options[] }]
 *     options for room k = every distinct room type/board/cancellation seen
 *     for room k across all offers, at its lowest live price.
 *   defaultPicks(rooms, offer) -> option keys matching one offer's rooms
 *   totalFor(rooms, picks)     -> sum of the picked rooms' live prices
 *   matchingOffer(offers, rooms, picks) -> the offer whose rooms are exactly
 *     these picks, if any (so the stored offer id is kept when possible)
 *
 * Every price here is a live per-room rate from the partner; nothing is
 * estimated. Loaded before the app script in index.html; importable from
 * Node tests.
 */
(function (root) {
  "use strict";

  function partsOf(o) {
    return o && Array.isArray(o.room_parts) && o.room_parts.length > 1 ? o.room_parts : null;
  }

  function optionKey(part) {
    return [part.name || "", part.board_type || "", part.refundable_tag || ""].join("|");
  }

  // Rooms are identified by position. Offers with a different room count
  // (shouldn't happen inside one package) are ignored.
  function buildRoomOptions(offers) {
    var list = (offers || []).filter(partsOf);
    if (!list.length) return [];
    var n = partsOf(list[0]).length;
    var rooms = [];
    for (var k = 0; k < n; k++) rooms.push({ index: k, adults: null, children_ages: [], options: [], _byKey: {} });
    list.forEach(function (o) {
      var parts = partsOf(o);
      if (parts.length !== n) return;
      parts.forEach(function (p, k) {
        var total = Number(p.total);
        if (!(total > 0)) return;
        var room = rooms[k];
        if (room.adults == null && p.adults != null) {
          room.adults = Number(p.adults);
          room.children_ages = Array.isArray(p.children_ages) ? p.children_ages.map(Number) : [];
        }
        var key = optionKey(p);
        var prev = room._byKey[key];
        if (!prev || total < prev.total) {
          room._byKey[key] = {
            key: key, name: p.name || "Room", total: total,
            board_type: p.board_type || null, board_name: p.board_name || null,
            refundable: p.refundable_tag === "RFN" ? true : (p.refundable_tag === "NRFN" ? false : null),
            max_occupancy: p.max_occupancy != null ? Number(p.max_occupancy) : null,
            mapped_room_id: p.mapped_room_id || null,
          };
        }
      });
    });
    rooms.forEach(function (room) {
      room.options = Object.keys(room._byKey).map(function (k) { return room._byKey[k]; })
        .sort(function (a, b) { return a.total - b.total; });
      delete room._byKey;
    });
    return rooms;
  }

  function defaultPicks(rooms, offer) {
    var parts = partsOf(offer);
    return rooms.map(function (room, k) {
      var want = parts && parts[k] ? optionKey(parts[k]) : null;
      var hit = want && room.options.some(function (o) { return o.key === want; });
      return hit ? want : (room.options[0] ? room.options[0].key : null);
    });
  }

  function optionFor(room, key) {
    for (var i = 0; i < room.options.length; i++) if (room.options[i].key === key) return room.options[i];
    return null;
  }

  // Null when any room has no priced pick: never show a partial total.
  function totalFor(rooms, picks) {
    var sum = 0;
    for (var k = 0; k < rooms.length; k++) {
      var o = optionFor(rooms[k], picks[k]);
      if (!o) return null;
      sum += o.total;
    }
    return Math.round(sum * 100) / 100;
  }

  function matchingOffer(offers, rooms, picks) {
    var list = (offers || []).filter(partsOf);
    for (var i = 0; i < list.length; i++) {
      var parts = partsOf(list[i]);
      if (parts.length !== picks.length) continue;
      var same = parts.every(function (p, k) { return optionKey(p) === picks[k]; });
      if (same) return list[i];
    }
    return null;
  }

  // "2 adults, 2 kids (8, 3)" — infants (<2) named as such.
  function guestsLabel(room) {
    var a = Number(room.adults) || 0;
    var ages = room.children_ages || [];
    var out = a + " adult" + (a === 1 ? "" : "s");
    if (ages.length) {
      var kidAges = ages.map(function (x) { return x < 2 ? "infant" : String(x); });
      out += ", " + ages.length + " kid" + (ages.length === 1 ? "" : "s") + " (" + kidAges.join(", ") + ")";
    }
    return out;
  }

  // Legacy offers (cached before per-room parts existed): "A + B (4 rooms)".
  function parseComboName(name) {
    var m = /^(.*)\((\d+) rooms\)\s*$/.exec(String(name || ""));
    if (!m) return null;
    var types = m[1].split(" + ").map(function (s) { return s.replace(/\s+/g, " ").trim(); }).filter(Boolean);
    return { rooms: Number(m[2]), types: types };
  }

  // Room photos live on the hotel's room catalog (resort_rooms), keyed by
  // LiteAPI's mapped room id. Match by that id first. Without it, accept
  // only an exact name match after ignoring case, punctuation and a
  // trailing "Bed"/"Beds"/"Room" ("…Ocean View King" = "…Ocean View King
  // Bed"), and only when exactly one catalog room matches. No fuzzy
  // guessing: a wrong photo is worse than none.
  function normRoomName(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
      .replace(/\s+(bed|beds|room)$/, "").trim();
  }
  function matchCatalogRoom(catalog, ref) {
    var list = catalog || [];
    if (ref && ref.mapped_room_id != null) {
      for (var i = 0; i < list.length; i++) if (String(list[i].room_id) === String(ref.mapped_room_id)) return list[i];
    }
    var n = normRoomName(ref && ref.name);
    if (!n) return null;
    var hits = list.filter(function (c) { return normRoomName(c.room_name) === n; });
    return hits.length === 1 ? hits[0] : null;
  }

  var api = {
    matchCatalogRoom: matchCatalogRoom, normRoomName: normRoomName,
    buildRoomOptions: buildRoomOptions, defaultPicks: defaultPicks, totalFor: totalFor,
    matchingOffer: matchingOffer, optionFor: optionFor, guestsLabel: guestsLabel,
    parseComboName: parseComboName, optionKey: optionKey,
  };
  root.KTRoomSplit = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
