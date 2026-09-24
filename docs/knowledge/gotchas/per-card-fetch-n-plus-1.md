---
title: A per-list-item component fetching its own data creates an unbounded N+1
date: 2026-09-24
tags: [performance, react, api-design]
---

`AssetCard.tsx` used to fetch its own contrast-check data (`GET /api/assets/[id]/contrast`) in a
`useEffect` keyed on the asset's own id. That's fine for a single-asset detail page (one card, one
fetch), but `AssetCard` is also rendered N times in a `.map()` on the Assets list page and the Style
Hub's asset grid — so N assets meant N independent HTTP round trips, all fired at once.

This wasn't slow because the per-request work was expensive (the route just reads a small CSS file
and does a pure-math contrast calculation, microseconds of real work). It was slow because of the
browser's own per-origin concurrent-connection limit: with 50+ simultaneous `fetch()` calls to the
same origin, only a handful run at a time and the rest queue. Measured on this codebase's real dev
data (50 theme assets): total time for all contrast badges to resolve went from ~2-3 seconds (100
requests once React StrictMode's dev-only double-invoke is factored in) down to ~100ms once fixed.

**Fix:** compute the per-item data server-side, once, as part of the list endpoint's own response
(`AssetService.withContrastData()`, called from both `/api/assets` and `/api/styles/[id]/assets`)
instead of letting the list-item component fetch it independently. The component becomes purely
prop-driven — no fetch of its own, no per-card `useEffect`.

**How to spot this pattern before it ships:** a component meant to render inside a list has its own
`useEffect` + `fetch()` keyed on its own id/props, with no batching. It reads fine in isolation (one
card, one fetch, looks harmless) — the bug only appears once you consider what happens when 50 of
them mount at once. `JobCard.tsx` has a similar-looking per-item `usePolling` fetch (job similarity
check) that was deliberately left as-is: the Jobs list is small and short-lived (jobs get promoted to
Assets, they don't accumulate), so the same pattern is much lower-risk there — check whether the list
this component renders in only ever grows (like Assets) before deciding a per-item fetch needs the
same batching treatment.
