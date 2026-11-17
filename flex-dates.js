/* KindredTrips — flexible dates (±1 day).
 *
 * After the main search, the top results are re-priced with the whole trip
 * moved one day earlier and one day later (same number of nights, party
 * and airport). Those two searches are scoped to the same resorts, so every
 * window compares the same set of trips. Pure helpers here; the app script
 * runs the searches. Importable from Node tests.
 *
 * Only LIVE complete prices count (both suppliers LiteAPI, a total, and a
 * full flight basis) — the same rule as the result cards. A window with no
 * live price says so instead of showing a number.
 */
(function (root) {
  "use strict";

  var DAY = 86400000;

  function iso(d) { return d.toISOString().slice(0, 10); }

  // Move the whole trip by `days` (negative = earlier), UTC date math.
  function shiftTrip(dateStart, dateEnd, days) {
    var s = new Date(dateStart + "T00:00:00Z"), e = new Date(dateEnd + "T00:00:00Z");
    if (isNaN(s) || isNaN(e)) return null;
    return { date_start: iso(new Date(s.getTime() + days * DAY)), date_end: iso(new Date(e.getTime() + days * DAY)) };
  }

  // -1 / +1 windows; a window that would start before `today` is skipped.
  function flexWindows(dateStart, dateEnd, today) {
    var out = [];
    [-1, 1].forEach(function (off) {
      var w = shiftTrip(dateStart, dateEnd, off);
      if (w && (!today || w.date_start > today)) out.push({ offset: off, date_start: w.date_start, date_end: w.date_end });
    });
    return out;
  }

  function isLive(p) {
    return !!p && p.hotel_supplier === "liteapi" && p.flight_supplier === "liteapi" &&
      p.total_price != null && Number(p.total_price) > 0 && p.flight_price_basis !== "oneway_outbound";
  }

  // The resorts to re-price: the top `n` live results, in display order.
  function pickResorts(packages, n) {
    var seen = {}, out = [];
    (packages || []).forEach(function (p) {
      if (out.length >= n || !isLive(p) || !p.resort_id || seen[p.resort_id]) return;
      seen[p.resort_id] = true;
      out.push(p.resort_id);
    });
    return out;
  }

  function cheapestByResort(packages, resortIds) {
    var want = {}, best = {};
    (resortIds || []).forEach(function (id) { want[id] = true; });
    (packages || []).forEach(function (p) {
      if (!isLive(p) || !want[p.resort_id]) return;
      var t = Number(p.total_price);
      if (!best[p.resort_id] || t < Number(best[p.resort_id].total_price)) best[p.resort_id] = p;
    });
    return best;
  }

  // One entry per window (earlier, chosen, later), each with the cheapest
  // live trip among the SAME resorts, so the windows are comparable.
  //   base:    { date_start, date_end, packages }
  //   shifted: [{ offset, date_start, date_end, packages, status }]
  function summarize(base, shifted, resortIds) {
    function entry(offset, w, packages, status) {
      var best = cheapestByResort(packages, resortIds), cheapest = null;
      Object.keys(best).forEach(function (id) {
        if (!cheapest || Number(best[id].total_price) < Number(cheapest.total_price)) cheapest = best[id];
      });
      return {
        offset: offset, date_start: w.date_start, date_end: w.date_end, status: status || "done",
        cheapest: cheapest ? { total: Math.round(Number(cheapest.total_price)), resort_id: cheapest.resort_id,
          resort_name: (cheapest.resorts && cheapest.resorts.resort_name) || null } : null,
        priced: Object.keys(best).length,
      };
    }
    var rows = [entry(0, base, base.packages, "done")];
    (shifted || []).forEach(function (s) { rows.push(entry(s.offset, s, s.packages, s.status)); });
    rows.sort(function (a, b) { return a.offset - b.offset; });
    var done = rows.filter(function (r) { return r.cheapest; });
    var low = done.length ? Math.min.apply(null, done.map(function (r) { return r.cheapest.total; })) : null;
    rows.forEach(function (r) { r.isCheapest = !!(r.cheapest && done.length > 1 && r.cheapest.total === low); });
    return rows;
  }

  // Per resort: the best shifted window if it beats the chosen dates by at
  // least `minSaving` dollars. Map resort_id -> { offset, date_start,
  // date_end, total, saving }.
  function savingsByResort(basePackages, shifted, resortIds, minSaving) {
    var min = minSaving == null ? 25 : minSaving;
    var base = cheapestByResort(basePackages, resortIds), out = {};
    (shifted || []).forEach(function (s) {
      var best = cheapestByResort(s.packages, resortIds);
      Object.keys(best).forEach(function (id) {
        if (!base[id]) return;
        var saving = Math.round(Number(base[id].total_price) - Number(best[id].total_price));
        if (saving >= min && (!out[id] || saving > out[id].saving)) {
          out[id] = { offset: s.offset, date_start: s.date_start, date_end: s.date_end,
            total: Math.round(Number(best[id].total_price)), saving: saving };
        }
      });
    });
    return out;
  }

  // "Thu, Mar 12" without time-zone drift.
  function dayLabel(isoDate) {
    var d = new Date(isoDate + "T00:00:00Z");
    var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return days[d.getUTCDay()] + ", " + months[d.getUTCMonth()] + " " + d.getUTCDate();
  }

  var api = { shiftTrip: shiftTrip, flexWindows: flexWindows, isLive: isLive, pickResorts: pickResorts,
    summarize: summarize, savingsByResort: savingsByResort, dayLabel: dayLabel };
  root.KTFlexDates = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
