// price_packages_mock — RETIRED (2026-06-25)
//
// KindredTrips no longer fabricates prices. Pricing is live LiteAPI only;
// packages that can't be priced live are left unpriced ('pending'/'no_fit').
// This function generated tier-based mock prices and has been removed from
// the pipeline. It is kept as a tombstone (HTTP 410) so any stale caller
// fails loudly instead of silently producing invented numbers.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(() =>
  new Response(
    JSON.stringify({
      error: "gone",
      message: "price_packages_mock has been retired. Pricing is live LiteAPI only.",
    }),
    { status: 410, headers: { "content-type": "application/json" } },
  )
);
