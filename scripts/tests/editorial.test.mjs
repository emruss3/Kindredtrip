// Editorial guides (data/editorial/*.json) may only shortlist resorts that
// admit children, and every shortlisted fact must be backed by a source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { familyEligibility, slugify } from "../lib/family-rules.mjs";

const resorts = JSON.parse(readFileSync(new URL("../../data/resorts-seo.json", import.meta.url), "utf8"));
const elig = new Map(resorts.map((r) => [slugify(r.resort_name), familyEligibility(r)]));
const dir = new URL("../../data/editorial/", import.meta.url);

for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const g = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
  test(`${f}: shortlist is family_allowed only`, () => {
    for (const x of g.resorts) assert.equal(elig.get(x.slug), "family_allowed", x.slug);
    for (const s of g.excludedAdultsOnly || []) assert.ok(!g.resorts.some((x) => x.slug === s), `${s} excluded but shortlisted`);
  });
  test(`${f}: facts carry sources and a verification date`, () => {
    assert.match(g.verified, /^\d{4}-\d{2}-\d{2}$/);
    for (const x of g.resorts) {
      assert.ok(x.route?.length && /^International flight/.test(x.route[0].leg), `${x.slug}: route must start with the international leg`);
      if (x.searchable) assert.ok(x.ageSource && g.sources[x.ageSource], `${x.slug}: age rule needs a source`);
      else assert.match(x.ageRule, /Check directly with the resort/, `${x.slug}: unsearchable property must say "Check directly with the resort"`);
      for (const rm of x.rooms) assert.ok(rm.occupancy >= 1 && rm.maxAdults >= 1, `${x.slug}: room occupancy`);
      if (x.fitsFour) assert.ok(x.rooms.some((rm) => rm.occupancy >= 4), `${x.slug}: fitsFour needs a 4+ room`);
    }
  });
}
