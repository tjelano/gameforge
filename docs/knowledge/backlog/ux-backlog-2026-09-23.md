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

2. **Assets page previews are a real bug — one real cause FIXED 2026-09-24, root cause not fully
   confirmed against what the user actually saw.** Investigated with no real sprite/image assets
   available locally to compare against (`storage/images/` was empty — this dev DB has only ever
   generated theme assets). Ruled out via direct code reading: the DB has a real UNIQUE constraint
   on `image_path` (two assets can never share a file), the image-serving route and promotion flow
   both correctly use per-asset unique filenames, and multi-state assets (`states` field) are just
   text tags, not separate per-state images.
   **Confirmed and fixed:** `MockGenerator` (`lib/services/ImageGenerator.ts`, used whenever
   `PIXELLAB_API_KEY` is unset) called a pure function of `size` only
   (`createPlaceholderPng`, `lib/utils/placeholderImage.ts`) — every mock-generated sprite at the
   same size was byte-for-byte identical, the prompt completely ignored. Verified live: two
   differently-prompted mock sprites now render as genuinely different colors (derived by hashing
   the prompt), instead of the same fixed amber square. This is a real, independently-verified bug
   regardless of whether it's the exact one the user saw — user wasn't sure/didn't confirm whether
   their affected assets were `mock-*` files.
   **Separate, discovered while investigating, RESOLVED 2026-09-24:** the project's `PIXELLAB_API_KEY`
   in `.env.local` was invalid — a direct test generation and a raw `curl` against Pixellab's
   `/v2/balance` endpoint both returned `401: Invalid API token`. Confirmed the auth scheme itself
   was correct (`Authorization: Bearer <token>`, matches Pixellab's live OpenAPI spec's
   `HTTPBearer`/`bearer` scheme exactly) — a wrong/revoked token value, not a code bug. User updated
   the key in `.env.local`; re-verified against `/v2/balance` and it now returns 200. **If real
   generation had been silently failing for a while before this, that was a stronger candidate for
   what the user originally saw** than the MockGenerator bug — worth reconciling if identical-preview
   reports resurface: check whether affected assets are real `pixellab-*` files (generated before the
   key broke) vs. `mock-*` files.

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

4. **Google Drive connection fails: "Error 400: invalid_request" — ROOT-CAUSED AND FIXED 2026-09-24.**
   `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` were never set in `.env.local`.
   `google-auth-library`'s `generateAuthUrl()` doesn't validate these locally — with them missing it
   silently builds a URL like `...&client_id=&redirect_uri=` and redirects the browser straight to
   Google, which rejects it with exactly this generic error (confirmed by calling
   `generateAuthUrl()` directly with undefined credentials and inspecting the output). The app
   already had a friendly `?error=not_configured` fallback built for this exact case
   (`app/api/drive/connect/route.ts`'s own try/catch) — it was just unreachable, since nothing threw
   before reaching Google. **Fix:** `newOAuthClient()` (`lib/services/DriveService.ts`) now checks
   for both env vars up front and throws a clear error if either is missing, so the existing
   try/catch in the connect route actually fires. Verified live: clicking "Connect Google Drive" now
   redirects to `?error=not_configured` and shows "Connection failed: not_configured" in-app, never
   reaching Google's page at all. Real Drive integration still needs actual OAuth credentials set up
   in a Google Cloud Console project — that's on the user if/when they want Drive working, not
   something fixable from this repo.

5. **Copilot conversation history doesn't seem to persist/load — ROOT-CAUSED AND FIXED 2026-09-24.**
   Server-side persistence (`CopilotConversationService`/`CopilotMessageService`, the two
   `/api/copilot/conversations*` routes) was always correct — verified by reading both. The bug was
   entirely client-side: `CopilotPanel.tsx` held `conversationId`/`messages` in plain React state with
   zero use of `localStorage`/`sessionStorage`. A full page reload silently started a brand-new empty
   chat every time; the actual conversation was still safely in the database and reachable via
   "History," but nothing auto-resumed it, so it read exactly like "history doesn't persist."
   **Fix:** persist the active conversation id to `localStorage` and auto-resume it on mount (once
   the async `useCurrentUser` fetch resolves). **A real bug was found and fixed in this fix itself**
   during verification: an initial version used a `useEffect` reactively watching `conversationId` to
   sync it to storage — that effect also fires on the component's very first mount, while
   `conversationId` is still its initial `null`, and immediately wiped whatever a *previous* mount had
   stored, racing ahead of the async resume effect. A unit test written against a naive synchronous
   `useCurrentUser` mock did not catch this (it passed even with the bug, since `loadConversation` had
   already captured the id as a function argument before the wipe mattered) — only a test whose mock
   genuinely deferred `user` becoming truthy (matching the real hook's actual async timing) could
   reproduce it. Fixed by replacing the reactive effect with explicit persistence calls at each actual
   state-change site (send, load, new chat) instead of a generic "watch this state" effect. Verified
   live end-to-end (real dev server, real Ollama-backed conversation, multiple independent page
   reloads to different routes) after the unit test first caught the regression.

6. **Copilot should always run on the connected Ollama model when one is available** — raised
   2026-09-24. Currently the copilot lets the user pick Claude vs. Ollama vs. OpenRouter per message
   (see `lib/services/CopilotMessageService.ts` or equivalent); the ask is to default to/prefer
   Ollama automatically whenever a local model is connected, rather than requiring an explicit
   per-message choice. Not yet scoped — needs deciding: is this a changed default with the picker
   still available, or should the picker go away entirely when Ollama is connected? Check
   `app/dashboard/settings/ollama` for how "connected" is currently detected before implementing.
