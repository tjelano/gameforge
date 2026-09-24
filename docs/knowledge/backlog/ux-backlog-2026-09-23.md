---
title: UX backlog raised 2026-09-23
date: 2026-09-23
tags: [ux, performance, backlog]
---

Five items the user raised mid-session on 2026-09-23, explicitly "planned for later" — not yet
scoped or actioned, no design/plan exists for any of them. Do not start on these without the user
opening the topic first.

1. **Dashboard navigation feels slow — REAL CAUSE FOUND AND FIXED 2026-09-24, was not the
   `loading.tsx` theory.** The original theory (missing `loading.tsx` files, or dev-mode Turbopack
   on-demand compilation) was re-checked empirically before acting on it and both turned out to be
   minor at most: a cold client-side transition measured ~178ms to first paint, and even a fully
   cold `next dev` process (cache cleared, first-ever request) loaded a heavy page in ~615ms — nowhere
   near the reported 14-18s LCP.
   **The real cause:** `AssetCard.tsx` (rendered in a `.map()` on the Assets list page and the Style
   Hub's asset grid) fetched its own WCAG contrast-check data independently per card
   (`GET /api/assets/[id]/contrast`). With 50+ theme-kind assets on a page, that's 50+ simultaneous
   HTTP requests all queuing behind the browser's per-origin connection limit — measured at ~2-3
   seconds just for that data to resolve on this project's real dev data, and scaling worse as more
   assets accumulate (exactly the "gets slower over time" pattern this kind of complaint usually
   describes). See [[gotchas/per-card-fetch-n-plus-1]] for the full diagnosis and the general
   pattern to watch for elsewhere.
   **Fix:** moved the contrast computation server-side into the list endpoints themselves
   (`AssetService.withContrastData()`), so it's computed once per page load instead of fetched N
   times. Verified live: the same 50-badge page now loads in ~103ms via one API call instead of 100
   queued ones. `loading.tsx` files still don't exist anywhere in the app and may still be worth
   adding as a general polish item, but they were never the load-bearing fix here.

2. **Assets page previews are a real bug, not just rough UX** — every asset's preview looks
   identical; they don't reflect how each asset actually looks. Treat as broken functionality when
   picked up, not a polish item.

3. **Dashboard IA doesn't distinguish UI-asset creation from website creation, and there's no
   single "create a full website" flow.** Two related asks:
   - Make it visually/structurally clear which parts are for UI/asset creation (Style Bibles,
     sprite/theme/component generation) versus website creation (Page Composer, Site Export) —
     likely a restructured sidebar with the two grouped and labeled distinctly.
   - A dedicated page to build a full website from scratch, with everything needed in one place,
     rather than the current spread across separate pages with no guided path. Likely a
     wizard/guided page tying existing pieces together, not new generation capability.
   - **Clarification:** the shipped "design preview" feature (PR #28, a live in-app editor for the
     dashboard's own theme tokens) was a miscommunication — what's actually wanted is a live editor
     for the website-creation flow itself (this item's "create a full website" page): build a site,
     then edit it live, not edit the dashboard's own styling. PR #28 is real and works as built,
     just doesn't cover this need. Fold "live editing" in as a requirement when this item gets
     brainstormed.

4. **Google Drive connection fails: "Error 400: invalid_request"** on Google's own OAuth consent
   screen when connecting a drive. Not yet diagnosed — classic Google OAuth error, usually a
   redirect-URI mismatch, wrong/missing client ID, or a scope misconfiguration in the Google Cloud
   Console project backing this integration. Check `app/api/drive/connect/route.ts` and whatever
   env vars configure the OAuth client first.

5. **Copilot conversation history doesn't seem to persist/load**, though it's unclear if this is a
   real bug or a symptom of item 1 (slow nav/loading generally). Needs isolating from general
   slowness before diagnosing — check whether history genuinely fails to save/load vs. just takes a
   long time to appear.
