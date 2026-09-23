---
title: UX backlog raised 2026-09-23
date: 2026-09-23
tags: [ux, performance, backlog]
---

Five items the user raised mid-session on 2026-09-23, explicitly "planned for later" — not yet
scoped or actioned, no design/plan exists for any of them. Do not start on these without the user
opening the topic first.

1. **Dashboard navigation feels slow — diagnosed, not yet fixed or confirmed live.** Root cause
   candidate: zero `loading.tsx` files exist anywhere in the app. Next.js App Router shows nothing
   during a client-side navigation unless the route segment has its own `loading.tsx` — without
   one, a click sits with no feedback until the destination page's JS loads and fully renders
   (including its client-side `useEffect`-driven data fetch, this app's established per-page
   pattern). Fix candidate: add a `loading.tsx` per dashboard route segment (or at least one
   dashboard-wide) with a simple skeleton/spinner.
   **Complication:** user measured LCP of 14-18 seconds in Chrome DevTools — much worse than a
   missing `loading.tsx` alone typically explains (that mostly hurts perceived responsiveness
   during client-side nav, not raw paint timing this badly). If testing was on `next dev` (not a
   production build), Next.js dev-mode on-demand route compilation (each route recompiles fresh on
   first visit) is a strong, cheap-to-rule-out alternative/contributing cause. Check whether LCP
   drops sharply on a second visit to the same route (would confirm compile-time, not runtime) and
   whether it holds up under `next build && next start` before treating the `loading.tsx` theory as
   the whole story. Both causes could be contributing simultaneously.

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
