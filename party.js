/* KindredTrips — shared party (traveler) normalization.
 *
 * One parser for every entry point that carries a family into search:
 * homepage deep links, SEO-page wizard forms (?adults=2&kids=8%2C+6%2C+3),
 * and the edit-search popover. Loaded before the app script in index.html
 * and importable from Node tests.
 *
 * Distinguishes three kid states:
 *   absent   — no `kids` parameter at all  -> kids: null (caller keeps its default)
 *   explicit — `kids=` present but empty    -> kids: []   (adults only)
 *   ages     — `kids=8, 6, 3`               -> kids: [8, 6, 3]
 * Age 0 (under 1) is valid. Anything unreadable or out of range is returned
 * in `invalid` so the UI can ask the parent to fix it — never dropped
 * silently (that is how "8, 6, 3" used to become one child aged 8).
 */
(function (root) {
  "use strict";
  var MAX_CHILD_AGE = 17;
  var MAX_CHILDREN = 12; // Search edge function limit
  var MIN_ADULTS = 1;
  var MAX_ADULTS = 16;   // Search edge function limit

  function parseKids(raw) {
    if (raw === null || raw === undefined) return { kids: null, invalid: [] };
    var tokens = String(raw).split(/[,;\s]+/).filter(Boolean);
    var kids = [];
    var invalid = [];
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t === "<1") { kids.push(0); continue; }
      if (/^\d{1,2}$/.test(t) && Number(t) <= MAX_CHILD_AGE) kids.push(Number(t));
      else invalid.push(t);
    }
    if (kids.length > MAX_CHILDREN) {
      invalid.push("more than " + MAX_CHILDREN + " children");
      kids = kids.slice(0, MAX_CHILDREN);
    }
    return { kids: kids, invalid: invalid };
  }

  function parseAdults(raw) {
    if (raw === null || raw === undefined || String(raw).trim() === "") return { adults: null, invalid: [] };
    var t = String(raw).trim();
    if (/^\d{1,2}$/.test(t) && Number(t) >= MIN_ADULTS && Number(t) <= MAX_ADULTS) return { adults: Number(t), invalid: [] };
    return { adults: null, invalid: ["adults: " + t] };
  }

  // `params` is a URLSearchParams (or anything with .get()).
  function parseParty(params) {
    var a = parseAdults(params.get("adults"));
    var k = parseKids(params.get("kids"));
    return {
      adults: a.adults,
      kids: k.kids,
      kidsExplicit: k.kids !== null,
      invalid: a.invalid.concat(k.invalid),
    };
  }

  // Human label used in summaries: "family of 5 (kids ages 8, 6, 3)".
  function describe(adults, kids) {
    var n = adults + kids.length;
    return "family of " + n + (kids.length ? " (kids ages " + kids.join(", ") + ")" : "");
  }

  var api = { parseKids: parseKids, parseAdults: parseAdults, parseParty: parseParty, describe: describe };
  root.KTParty = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
