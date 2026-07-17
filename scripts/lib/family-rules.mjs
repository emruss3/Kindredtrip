// family-rules.mjs
//
// Single source of truth for KindredTrips' family-eligibility, content-
// safety, ranking, and indexability rules. Imported by the page
// generator (scripts/generate-seo-pages.mjs), the post-build validator
// (scripts/validate-site.mjs), and the unit tests
// (scripts/tests/*.test.mjs) so the rules can never drift between
// rendering and enforcement.
//
// PAGE-GENERATION FREEZE: no new indexable programmatic page TYPES may
// be added until the CI gates in .github/workflows/ci.yml pass — family
// eligibility, canonical/dedupe, indexability, and sitemap checks are
// build-blocking.

// ---------- names & slugs ----------
export function slugify(s) {
  return String(s ?? "")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 80) || "resort";
}

export function displayName(r) {
  const n = String(r.resort_name ?? "").replace(/\s*\([^)]*\)/g, "").replace(/\s{2,}/g, " ").trim();
  return n || r.resort_name;
}

// ---------- family eligibility ----------
// Controlled vocabulary. Only "family_allowed" may appear on ANY family
// surface (search results, destination pages, family-size pages, kids
// pages, related-resort modules, family ItemList schema, family sitemap
// entries). "uncertain" is ineligible until verified.
export const FAMILY_ELIGIBILITY = [
  "family_allowed", "adults_only", "couples_only",
  "minimum_age_restricted", "uncertain", "temporarily_closed",
];

// Secondary name/brand/style safety detector. This is a BACKUP for the
// structured audience field, not the source of truth — but it hard-
// blocks obvious contradictions (a "Sandals (Couples only)" row labeled
// Family still gets excluded).
//
// Two tiers:
//  - POLICY phrases (adults only, nude, …) match against name AND the
//    brand/style fields.
//  - BRAND-NAME keywords (Sandals, Secrets, …) match the PROPERTY NAME
//    only. A parent-company brand field must not poison sibling family
//    brands — e.g. Beaches resorts carry hotel_brand "Sandals Resorts
//    International" but are Sandals' flagship FAMILY product.
export const ADULT_POLICY_RE = new RegExp(
  [
    "adults?[ -]?only", "couples?[ -]?only",
    "clothing\\s*optional", "nudist", "nude", "au\\s*naturel", "topless",
  ].join("|"), "i");
export const ADULT_BRAND_RE = new RegExp(
  [
    "couples\\s*resorts?", "temptation", "hedonism", "\\bsecrets\\b",
    "breathless", "\\bzilara\\b", "\\bsandals\\b", "\\bcouples\\b",
    "\\bexcellence\\b", "grand\\s+lido", "\\bhideaway\\b",
  ].join("|"), "i");
// Combined matcher retained for callers that only have a name string.
export const ADULT_NAME_RE = new RegExp(`${ADULT_POLICY_RE.source}|${ADULT_BRAND_RE.source}`, "i");

// Explicit whitelist: properties that trip a brand keyword but are
// verified family products. Keyed by slugified resort name; each entry
// needs a reason.
export const FAMILY_WHITELIST = new Set([
  // Excellence Collection's FAMILY brand is "Finest" — the parent-brand
  // name inside the resort name must not exclude it.
  "finest-punta-cana-by-the-excellence-collection-all-inclusive",
]);

// Highest minimum age found in the property name (e.g. "(16+)").
export function nameMinAge(r) {
  let max = null;
  for (const m of String(r.resort_name ?? "").matchAll(/(\d{1,2})\s*\+/g)) {
    const age = Number(m[1]);
    if (age >= 2 && age <= 21 && (max == null || age > max)) max = age;
  }
  return max;
}

// Classify a snapshot row into the controlled vocabulary.
export function familyEligibility(r) {
  if (r.status === "closed" || r.status === "renovating") return "temporarily_closed";
  const name = String(r.resort_name ?? "");
  const hay = `${name} ${r.hotel_brand ?? ""} ${r.hotel_style ?? ""}`;
  const whitelisted = FAMILY_WHITELIST.has(slugify(name));
  if (/couples?[ -]?only/i.test(hay) && !whitelisted) return "couples_only";
  if (/couples\s*resorts?|\bcouples\b/i.test(name) && !whitelisted) return "couples_only";
  if (r.audience === "Adults Only") return "adults_only";
  if (ADULT_POLICY_RE.test(hay) && !whitelisted) return "adults_only";
  if (ADULT_BRAND_RE.test(name) && !whitelisted) return "adults_only";
  const minAge = nameMinAge(r);
  if (minAge != null && minAge >= 12) return "minimum_age_restricted";
  // No structured audience signal at all → uncertain, which is
  // ineligible for family surfaces until verified.
  if (r.audience == null) return "uncertain";
  return "family_allowed";
}

export const familyEligible = (r) => familyEligibility(r) === "family_allowed";

// ---------- family-positive signals ----------
// "family-friendly" may only be said about a family_allowed property
// with at least one confirmed family-positive signal.
// Infant-friendly (BROAD): the resort accepts infants or provides cribs,
// with no minimum-age policy in the name. A welcome signal for the
// youngest travelers — NOT proof of a toddler program.
export const infantFriendly = (r) =>
  (r.infants === true || r.cribs === true) && nameMinAge(r) == null;

// Toddler-friendly (STRICT): a *verified* young kids-club minimum age
// (<= 3) — the only toddler-grade programming signal we actually track.
// (A confirmed nursery or verified toddler program would also qualify
// once that data exists; we never fabricate it.) Much narrower than
// infant-friendly, so "best for toddlers" means the resort genuinely
// programs for that age — not just "accepts infants."
export const toddlerFriendly = (r) =>
  nameMinAge(r) == null && r.kc_min != null && Number(r.kc_min) <= 3;

// Back-compat alias: broad "infant & toddler" contexts use the infant signal.
export const toddlerFit = infantFriendly;

// Toddler-specific ranking. Unlike familyFitScore it heavily weights what
// matters with a 1–3-year-old — a short travel day, a young childcare
// age, and room separation for naps — and deliberately does NOT reward
// water parks (a big-kid feature). Fields we don't track (shallow pools,
// nursery, stroller access, beach swimmability) are absent, never invented.
export function toddlerScore(r) {
  let s = 0;
  if (r.kc_min != null) s += Math.max(0, 5 - Number(r.kc_min)) * 8; // age 1→32, 3→16
  if (r.transfer_min != null) {
    if (r.transfer_min <= 30) s += 12;
    else if (r.transfer_min <= 45) s += 7;
    else if (r.transfer_min <= 60) s += 3;
    else if (r.transfer_min > 120) s -= 8;
  }
  if (r.connecting || Number(r.family_max) >= 5) s += 6;
  if (r.cribs) s += 5;
  if (r.infants) s += 3;
  if (r.on_beach) s += 5;
  if (r.pool) s += 4;
  if (r.rating != null) s += (Number(r.rating) / 100) * 8;
  if (Number(r.stars) >= 5) s += 2;
  return s;
}

export function hasFamilySignals(r, familyReviewCount = 0) {
  if (!familyEligible(r)) return false;
  if (r.kids_club || r.water_park || toddlerFit(r) || r.connecting) return true;
  if (Number(r.family_max) >= 5) return true;
  if (r.family_room || r.child_allowed) return true;
  if (Number(familyReviewCount) >= 5) return true;
  return false;
}

// How many family-fit fields we actually know — used for thin-data
// watch-outs and comparison-page indexability.
export function knownFieldCount(r) {
  const keys = ["rating", "stars", "transfer_min", "family_max"];
  let n = keys.filter((k) => r[k] != null).length;
  for (const k of ["kids_club", "on_beach", "water_park", "pool", "spa", "connecting", "infants", "cribs", "all_inclusive", "sofa_bed"]) {
    if (r[k]) n++;
  }
  return n;
}

// ---------- family-fit score ----------
// Ranks every editorial list. Inputs are ONLY tracked fields; price is
// deliberately excluded (live search re-ranks by total trip cost).
export function familyFitScore(r) {
  let s = 0;
  if (r.rating != null) s += (Number(r.rating) / 100) * 25;
  if (r.kids_club) s += 12;
  if (r.on_beach) s += 10;
  if (r.water_park) s += 8; else if (r.pool) s += 4;
  const fm = Number(r.family_max || 0);
  if (fm >= 6) s += 8; else if (fm >= 5) s += 5;
  if (r.connecting) s += 6;
  if (r.infants) s += 3;
  if (r.cribs) s += 3;
  if (r.all_inclusive) s += 5;
  if (r.transfer_min != null) {
    if (r.transfer_min <= 30) s += 6;
    else if (r.transfer_min <= 60) s += 3;
    else if (r.transfer_min > 120) s -= 4;
  }
  if (Number(r.stars) >= 5) s += 4; else if (Number(r.stars) >= 4) s += 2;
  if (!familyEligible(r)) s -= 100;
  return s;
}

// ---------- meal plan / all-inclusive ----------
// The snapshot's all_inclusive flag is PROVIDER-VERIFIED: it is set only
// when live LiteAPI rate offers with an all-inclusive board type have
// actually been observed for the property (hotel_rate_offers.
// is_all_inclusive). It is never inferred from the resort name. Copy
// must only use "all-inclusive" when this returns true.
export function mealPlanStatus(r) {
  return {
    isAllInclusiveResort: r.all_inclusive === true ? true : null, // false unknowable from rate absence
    offersOptionalAllInclusivePackage: null, // no data source yet
    offersMealPlan: r.all_inclusive === true ? true : null,
    breakfastIncluded: null,
    sourceType: r.all_inclusive === true ? "provider" : "unknown",
  };
}
export const mayCallAllInclusive = (r) => mealPlanStatus(r).isAllInclusiveResort === true;

// ---------- content safety: counts & grammar ----------
// Deterministic zero/one/many language. Never "Yes — 0 …"; never an
// affirmative claim from an unknown or zero count.
export function countAnswer({ count, thing, place, yesText, zeroText }) {
  const n = Number(count) || 0;
  if (n <= 0) {
    return zeroText ??
      `No — KindredTrips does not currently track any ${thing}${place ? ` in ${place}` : ""}.`;
  }
  return yesText ?? `Yes — ${n === 1 ? `1 ${thing.replace(/s$/, "")}` : `${n} ${thing}`}${place ? ` in ${place}` : ""}.`;
}

export const plural = (n, singular, pluralWord) =>
  `${n} ${Number(n) === 1 ? singular : (pluralWord ?? singular + "s")}`;

// Null-state phrases for unknown facts — never affirmative.
export const UNKNOWN_COPY = {
  amenity: "We have not yet verified this amenity.",
  transfer: "This transfer time is an estimate — confirm with your transfer provider.",
  occupancy: "Room occupancy should be confirmed before booking.",
  noMatch: "We currently do not have a verified matching resort.",
};

// ---------- review snippet safety ----------
export function cleanSnippet(s, max = 260) {
  if (!s) return null;
  let t = String(s).replace(/\s+/g, " ").trim();
  if (t.length < 25) return null;
  if (t.length > max) t = t.slice(0, max);
  if (!/[.!?…)]$/.test(t)) {
    const cut = Math.max(t.lastIndexOf(". "), t.lastIndexOf("! "), t.lastIndexOf("? "));
    if (cut > 60) t = t.slice(0, cut + 1);
    else t = t.replace(/\s+\S*$/, "") + "…";
  }
  return t;
}

// A "pros" snippet that reads as clearly negative (or vice versa) means
// the provider mislabeled the field — drop the review from display.
const NEGATIVE_RE = /\b(terrible|awful|horrible|worst|disgusting|filthy|scam|never again|do not stay)\b/i;
export function sentimentConflict(rv) {
  const score = Number(rv.average_score);
  if (Number.isFinite(score) && score >= 8 && rv.cons && NEGATIVE_RE.test(rv.cons) && !rv.pros) return true;
  if (Number.isFinite(score) && score <= 3 && rv.pros && !rv.cons && !NEGATIVE_RE.test(rv.pros)) return false;
  if (rv.pros && NEGATIVE_RE.test(rv.pros)) return true;
  return false;
}

// ---------- airports ----------
// Canonical display: "MBJ — Sangster International Airport". Full names
// for destination airports we track; fall back to the short name from
// the snapshot when unmapped. Never display a bare truncated name when
// the IATA code is known.
export const AIRPORT_FULL_NAMES = {
  MBJ: "Sangster International Airport",
  KIN: "Norman Manley International Airport",
  CUN: "Cancún International Airport",
  CZM: "Cozumel International Airport",
  PUJ: "Punta Cana International Airport",
  POP: "Gregorio Luperón International Airport",
  AZS: "Samaná El Catey International Airport",
  STI: "Cibao International Airport",
  SDQ: "Las Américas International Airport",
  NAS: "Lynden Pindling International Airport",
  AUA: "Queen Beatrix International Airport",
  BGI: "Grantley Adams International Airport",
  PLS: "Providenciales International Airport",
  ANU: "V.C. Bird International Airport",
  SLU: "George F. L. Charles Airport",
  UVF: "Hewanorra International Airport",
  SXM: "Princess Juliana International Airport",
  GND: "Maurice Bishop International Airport",
  LIR: "Guanacaste (Daniel Oduber Quirós) International Airport",
  SJO: "Juan Santamaría International Airport",
  BZE: "Philip S. W. Goldson International Airport",
  CUR: "Curaçao International Airport (Hato)",
  MTY: "Monterrey International Airport",
  PVR: "Licenciado Gustavo Díaz Ordaz International Airport",
  SJD: "Los Cabos International Airport",
  ZIH: "Ixtapa-Zihuatanejo International Airport",
  ACA: "Acapulco International Airport",
  MZT: "Mazatlán International Airport",
  HUX: "Bahías de Huatulco International Airport",
  TQO: "Tulum Felipe Carrillo Puerto International Airport",
  CTM: "Chetumal International Airport",
  RTB: "Juan Manuel Gálvez International Airport (Roatán)",
  GCM: "Owen Roberts International Airport",
  STX: "Henry E. Rohlsen Airport",
  STT: "Cyril E. King Airport",
  SVD: "Argyle International Airport",
  BON: "Flamingo International Airport",
  EIS: "Terrance B. Lettsome International Airport",
  BDA: "L.F. Wade International Airport",
  GUA: "La Aurora International Airport",
  FDF: "Martinique Aimé Césaire International Airport",
  PTY: "Tocumen International Airport",
  BOG: "El Dorado International Airport",
  CTG: "Rafael Núñez International Airport",
  SAL: "El Salvador International Airport",
  MGA: "Augusto C. Sandino International Airport",
  PAP: "Toussaint Louverture International Airport",
  CAP: "Hugo Chávez International Airport (Cap-Haïtien)",
};

export function airportDisplay(r) {
  const iata = r.airport_iata ? String(r.airport_iata).toUpperCase() : null;
  const full = iata ? AIRPORT_FULL_NAMES[iata] : null;
  if (iata && full) return `${iata} — ${full}`;
  if (iata && r.airport_name) return `${iata} — ${r.airport_name}`;
  if (iata) return iata;
  return r.airport_name || null;
}

// ---------- indexability ----------
// One decision function used by page rendering AND sitemap generation.
// Gates (defaults per template):
//   destination page:   >= 5 family_allowed resorts (guide content exists)
//   attribute page:     >= 5 verified matching family_allowed resorts
//   resort page:        family_allowed only (adult/uncertain → noindex)
//   compare page:       both sides family_allowed with >= 5 known fields
//   origin-airport page: requires REAL flight/airfare data — distance
//                        estimates alone do not qualify → noindex, follow
//   search-result URLs: never crawlable (client-side only on this site)
export const GATES = {
  COUNTRY_MIN: 5,
  THEME_MIN: 5,
  COMPARE_MIN_FIELDS: 5,
};

export function indexability({ template, eligibleResultCount = 0, hasRealFlightData = false, bothSidesRich = false, resortEligibility = "family_allowed" }) {
  switch (template) {
    case "resort":
      return resortEligibility === "family_allowed"
        ? { indexable: true, reason: "family_allowed resort page" }
        : { indexable: false, reason: `resort eligibility=${resortEligibility}` };
    case "country":
      return eligibleResultCount >= GATES.COUNTRY_MIN
        ? { indexable: true, reason: `${eligibleResultCount} family-eligible resorts` }
        : { indexable: false, reason: `only ${eligibleResultCount} family-eligible resorts (<${GATES.COUNTRY_MIN})` };
    case "theme":
      return eligibleResultCount >= GATES.THEME_MIN
        ? { indexable: true, reason: `${eligibleResultCount} verified matches` }
        : { indexable: false, reason: `only ${eligibleResultCount} matches (<${GATES.THEME_MIN})` };
    case "compare":
      return bothSidesRich
        ? { indexable: true, reason: "both sides data-rich" }
        : { indexable: false, reason: "one or both sides data-thin" };
    case "from":
      return hasRealFlightData
        ? { indexable: true, reason: "real flight data present" }
        : { indexable: false, reason: "distance estimates only — no real airfare data yet" };
    case "static":
    case "index":
      return { indexable: true, reason: "core page" };
    default:
      return { indexable: false, reason: `unknown template ${template}` };
  }
}

// ---------- business-model language ----------
export const DISALLOWED_BUSINESS_LANGUAGE = [
  /book (directly )?with kindredtrips/i,
  /kindredtrips books your/i,
  /kindredtrips owns this inventory/i,
  /we book your (flight|hotel|trip)/i,
];
