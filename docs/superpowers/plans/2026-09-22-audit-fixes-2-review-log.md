# Review log — 2026-09-22-audit-fixes-2.md (PR #43, merged)

Archived from the SDD worktree's local (gitignored) `.superpowers/sdd/2026-09-22-audit-fixes-2/
progress.md` ledger before that worktree was removed. Trimmed of per-task dispatch/agent-id
bookkeeping; keeps every review round's findings and verdicts. Every finding below was checked
against the actual current code before acting — DeepSeek has no filesystem access and CodeRabbit's
suggestions aren't ground truth either, so every claim was a guess until verified. Claude was final
arbiter throughout.

## Per-task review rounds (Tasks 1-14)

Every task went through a Claude task-reviewer + DeepSeek Mode 2 diff review in parallel (batched or
skipped only where explicitly noted below for budget reasons, always with the diff verified directly
instead). Notable findings, verified real and fixed during the run:

- **Task 1** (stale-session redirect + expired banner): DeepSeek found 5 real issues (redirect firing
  on transient server errors not just definitive no-user, `push` vs `.replace` back-button trap,
  unstable router test mock, banner missing in one LoginForm branch, missing negative test) — fixed.
  4 other DeepSeek findings verified false (infinite-loop claim contradicted by `proxy.ts`'s real
  code; a nonexistent `/admin` route; two others).
- **Task 2** ("Log in again" links): 2 of 7 DeepSeek findings real (unconditional link shown even for
  non-auth errors; inconsistent redirect target) — fixed. Also fixed a real gap in
  `deepseek-call.mjs` itself found mid-task (no guard against omitting `--system` on a fresh history
  file — would silently run with zero system prompt).
- **Task 3** (add-another-account flow, most security-adjacent task): 4 of 11 DeepSeek findings real
  (Pull-first UI didn't reset `addingAccount` on success; expired-banner regression in the
  zero-users branch from plan/reality drift; missing `vi.unstubAllGlobals()`; unstable router mock)
  — fixed. The admin-escalation-impossible safety claim was independently verified three times (by
  the SDD runner directly, by the Claude task-reviewer, and stress-tested by a DeepSeek TOCTOU
  challenge that held up under scrutiny) against `UserService.create()`'s real code, not just
  trusted from the plan's prose.
- **Task 4**: Claude reviewer and DeepSeek independently caught the *same* vacuous test (asserted
  before `useCurrentUser`'s async fetch resolved, passing for a coincidental reason) — fixed,
  test-only.
- **Task 6** (worker heartbeat): 3 of 11 DeepSeek findings real (a cosmetic worker-status fetch
  failure could cascade via `Promise.all` and hide context/activity data that loaded fine; first
  heartbeat write waited a full poll interval instead of firing immediately; the alive-threshold
  constant was a hardcoded literal disconnected from the worker's real poll interval) — fixed,
  including moving `POLL_INTERVAL_MS` into `lib/config.ts` as the single source of truth.
- **Task 9** (input labels): found and root-caused a real internal inconsistency in the task's own
  brief before implementing (two unrelated inputs shared identical label text) — renamed the
  pre-existing one rather than creating a duplicate. DeepSeek then found 2 more real, actionable
  gaps (a test that didn't pin which element it matched; a missing test for the 4th labeled input) —
  fixed, and empirically verified via a real RED/GREEN/RED-again run, not just re-reading the diff.
- **Task 10** (dialog Escape/focus): 4 of 10 DeepSeek findings real (Escape handler only caught
  keydowns whose target was inside the dialog's own subtree, so a backdrop click silently broke it;
  `document.activeElement`-based trigger capture is unreliable in Safari; DriveBrowser's trigger
  button could unmount after a move, making `.focus()` on it a silent no-op; the test bypassed the
  real event-bubble path) — fixed with a document-level Escape listener, click-time trigger capture,
  and an `isConnected` guard.
- **Task 11** (keyboard support for crop-boxes): 3 of 7 DeepSeek findings real (JS-managed focus
  outline caused a stuck outline on every mouse drag — fixed with CSS `:focus-visible` matching the
  existing `.btn:focus-visible` pattern; zero test coverage for the vertical-axis resize; new
  keyboard capability undiscoverable to screen readers — fixed with `aria-keyshortcuts`).

Full per-task detail (dispatch order, agent IDs, exact commit ranges) lived only in the worktree's
local ledger and wasn't preserved — the review substance above is what has lasting value.

## Final whole-branch review (all 14 tasks complete)

Ran DeepSeek Mode 2 on the full branch diff (`main...HEAD`, 45 files, ~4350 insertions) per the
plan's own Post-plan mandate. Session paused here at low weekly budget; resumed 2026-09-24. All 8
findings verified against real code:

1. **LoginForm "+Add another account" gated on `!expired`** — REAL. Removed the condition: a user
   whose account was deleted (hence session expired) had no way to add themselves back. No spec
   justification existed for the gate.
2. **`dashboard/page.tsx` style-item Link possible 404** — FALSE. `app/dashboard/styles/[id]/
   page.tsx` exists.
3. **`createError === 'Not logged in'` fragile exact-match** — FALSE. 70+ API routes use this exact
   string as the established house convention for the auth-guard error.
4. **Dead `try/catch` around `Promise.allSettled`** — REAL. `Promise.allSettled` never rejects and
   nothing in the block could throw (verified against all 3 backing routes). Removed.
5. **Export page missing loading state** — REAL. Added, matching the Assets/Overview convention.
6. **Focus-return inconsistency, DriveBrowser vs presets/page.tsx** — FALSE. The presets trigger
   button genuinely never unmounts while its dialog is open (no background refresh reachable behind
   the modal overlay); DriveBrowser's `isConnected` guard has no equivalent failure mode to guard
   against there.
7. **Spec doc says plain-visible labels, shipped code uses visually-hidden** — REAL (doc-only).
   Updated the spec to describe the actual shipped behavior.
8. **`force` field comment implies server-side enforcement it doesn't have** — REAL (comment-only).
   Reworded; not reopening the already-proven-safe admin-escalation question.

Fix-round diff (the 5 real findings) went through a second DeepSeek pass. 3 findings back, all
rejected on verification: a `data.alive`-throws claim disproven by reading all 3 backing routes; a
"functionally equivalent" doc claim tightened to state the actual accessibility rationale; a
`force`/403 "dead end" claim disproven by re-reading `LoginForm.tsx`'s actual branch structure.

**Manual browser-verification pass** (Playwright, real account creation, not fixtures): confirmed
live — the expired-session → add-account flow end-to-end, Overview loading without hanging, Export's
loading state, the generated favicon serving correctly (distinguishing it from an unrelated
browser-quirk 404), and the asset-type field rendering as a fixed single-option select.

## PR #43 — CodeRabbit review round

Pushed, opened PR #43. CI green. CodeRabbit posted 6 findings (5 inline + 1 outside-diff). All 6
verified real (unusually high hit rate vs. DeepSeek's typical ~1-in-5 — CodeRabbit has actual
repo/diff access, DeepSeek has none):

1. **No Tab-containment in either modal dialog** (Major) — both `DriveBrowser.tsx`'s Move dialog and
   `presets/page.tsx`'s Apply dialog claimed `aria-modal="true"` with only an Escape handler; Tab
   could reach background page controls. The original spec explicitly scoped out full
   focus-trapping, but this is a basic ARIA dialog requirement, not scope creep. Fixed: extracted
   `lib/utils/trapTabFocus.ts` (a shared pure function, not a shared component — matches this
   codebase's own precedent of sharing `boxKeyboardDelta` but not extracting a `<Modal>` component
   for just two call sites). New test added, verified against the real rendered dialog.
2. **Focus lost after a successful Drive move** (Major) — traced the exact timing: the trigger-focus
   effect fires while the old item list is still rendered, then `fetchItems()` resolves and removes
   that row (and the now-focused button) from the DOM, silently dropping focus to `document.body`.
   Fixed with a stable fallback focus target on the component's own root.
3. **Arrow keys on the crop-box include/exclude/remove buttons move the box** (Minor) — the sibling
   label `<input>` already guarded with `stopPropagation`; the buttons didn't. Fixed identically in
   both files.
4. **Worker-status fetched once on mount only** (Minor) — moved into the codebase's existing shared
   `usePolling` hook at `POLL_INTERVAL_MS`.
5. **Stale user object survives the session-expired redirect** (Minor) — `setUser(null)` before
   `router.replace`.
6. **Silent failure on network error in both login submit paths** (Minor, flagged on one function but
   present in both) — added matching `catch` blocks to `loginAs` and `handleCreateAccount`.

## Fix-round DeepSeek pass (while CodeRabbit was rate-limited)

CodeRabbit's free-tier review cap meant its "review" of the fix commit was a stale walkthrough of the
pre-fix diff, not a real second pass. Ran DeepSeek Mode 2 on the fix-round diff instead, to close the
same-model-family gap a Claude-only pre-push-review can't. 12 findings back; only 2 held up (back to
the expected ~1-in-5 base rate):

- **REAL, fixed:** `trapTabFocus` didn't pull focus back in if it started outside the container —
  added an explicit containment check.
- **REAL, fixed:** the new focus-fallback target had no accessible name — added `aria-label`.
- **10 rejected, each verified concretely, not dismissed on a prior:**
  - Selector omitting `summary`/`iframe`/`video`/`contenteditable` — neither dialog contains any.
  - `[href]` matching non-tabbable nodes — neither dialog renders any `<a href>` (the Move dialog's
    nested picker specifically never renders its "Open" link in `selectMode`).
  - Empty-focusables fallback — the Cancel button is unconditionally present in both dialogs.
  - Worker-status "stale until one interval elapses" / "interval recreated every render" — both false
    against `usePolling.ts`'s actual source (fires immediately; callback stored via ref, not a
    dependency).
  - "Steals focus from a still-present trigger" — traced the guard clauses: a same-folder move
    returns before reaching that code, so a real cross-folder move always removes the item from the
    refreshed list.
  - "stopPropagation breaks a global Escape listener via React's root delegation" — no
    `document.addEventListener` exists on either page; also matches an already-shipped identical
    pattern on the sibling label input.
  - "`setUser(null)` only clears one hook instance" — `useCurrentUser` is a plain per-instance
    `useState` hook with no shared store; each consumer independently detects and self-corrects.
  - "Blanket catch risks a duplicate-account retry" — not realistically reachable
    (`NextResponse.json()` always produces valid JSON); matches an established codebase convention.
  - "New test passes even with the fix deleted" — **checked empirically**: temporarily disabled the
    fix and re-ran the test. It failed (jsdom doesn't simulate native Tab-key focus movement at all),
    proving the test genuinely exercises the fix.

Final verification: `npx tsc --noEmit` clean, `npx eslint app lib worker.ts` 0 errors (2 pre-existing
warnings, unrelated files), `npx vitest run` 1247/1247 passing throughout. Merged 2026-09-24.
