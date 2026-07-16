# SEO_FIX_SUMMARY.md — why the fixes were invisible, and the proof

## Root cause (proven from live rendered output, not code)

**The production domain `https://kindredtrips.com` is aliased to a stale Vercel deployment built around 2026-05-20 — roughly two months before any of the SEO overhaul work.** Every fix has been committed, merged (PR #50 → default branch, commit `0534739`), and passes CI, but the live domain has never been re-pointed to a current deployment.

### Evidence — live vs. committed HTML

Fetched from the live domain via the Vercel MCP `web_fetch_vercel_url` (the sandbox network otherwise blocks the host):

| Page | LIVE (`kindredtrips.com`) | COMMITTED repo (`0534739`) |
|---|---|---|
| CSS fingerprint (all pages) | `styles.css?v=20260520-score-retune` | `styles.css?v=20260713-seo-depth` |
| `/caribbean/jamaica` H1 | "Family Resorts in Jamaica" (old) | "Jamaica Family Vacation Guide" |
| `/caribbean/jamaica` family section | leaks Sandals, Couples Tower/Resorts/Sans/Swept, Hedonism, Grand Lido, Zilara, Secrets, Breathless, JOIA Rose, The Caves, Ocean Eden | 0 adult brands; separate labeled "Adults-only properties" section |
| `/caribbean/best-resorts-for-family-of-5` title/H1 | "Best Caribbean **All-Inclusive** Resorts for a Family of 5" | "Best Caribbean Resorts for a Family of 5" (no "All-Inclusive") |

The `20260520` vs `20260713` CSS stamp is a deterministic deploy fingerprint: the live site is serving the May build. The committed HTML — which Vercel serves verbatim (static passthrough, **no build command**, HTML is committed, not generated at deploy) — is correct on every count.

### Why deploys never reached production

Vercel posts "Deployment has completed" statuses on recent commits, but those are **Preview** deployments. The domain stays on whatever was last promoted to **Production** (May 20). The most likely misconfiguration: the repo's default branch was changed to `claude/caribbean-vacation-optimizer-9L8Pp`, but Vercel's **Production Branch** setting still points at the original branch (e.g. `main`), so commits to the new default produce previews only and never re-alias the domain.

## The fix (requires one Vercel dashboard action — see PRODUCTION_VALIDATION_REPORT.md)

1. Vercel → Project `kindredtrip` → Settings → Git → set **Production Branch** to `claude/caribbean-vacation-optimizer-9L8Pp` (the current default) **or** promote the `0534739` deployment to Production.
2. Redeploy / promote → the domain re-aliases to the July-13 build.
3. Purge CDN cache (automatic on new production alias).
4. Re-run `node scripts/crawl-production.mjs https://kindredtrips.com` to confirm the live HTML flipped.

Nothing in the repository needs to change to fix the reported symptoms — they are already fixed in the served artifact; the artifact just isn't live.

## What was already correct in the committed build (verified this session)

Sweep across all 900 generated pages + 35 unit/canary tests + the build validator:

- Adults-only/couples-only in family sections: **0** (classifier respects the well-populated DB `audience` field; every user-flagged property — Sandals, Couples, Hedonism, Grand Lido, Zilara, Excellence, Secrets, Breathless, JOIA Rose Hall, The Caves, Ti Kaye, Ocean Eden Bay — resolves to `adults_only`/`couples_only`; The Soco House → `uncertain` → excluded).
- `family-of-5` page "All-Inclusive" in title/H1: **0**.
- "Yes — 0" affirmations: **0**.
- "KindredTrips books" language: **0**.
- Counts: single `STATS` source (520+ family resorts / 780+ properties / 30 destinations / 56 airports).
- Adults-only resort pages (e.g. `sandals-ochi-beach-resort`): `noindex, follow`, neutral "Resort Overview" H1, zero family language.
