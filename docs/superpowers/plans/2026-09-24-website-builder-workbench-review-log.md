# DeepSeek plan review — 2026-09-24 Website Builder Workbench

Plan: `docs/superpowers/plans/2026-09-24-website-builder-workbench.md`
Spec: `docs/superpowers/specs/2026-09-24-website-builder-workbench-design.md`
Provider: OpenRouter, `deepseek/deepseek-v4.1-flash`.

## Round 1 — DeepSeek

7 findings, verdict REVISE. Verified each against the actual repo source (not assumed):

1. **Task 2 test #3 "reuses previous test's DOM"** — FALSE POSITIVE. `test/inspectFrame.test.ts`'s `beforeEach` recreates the iframe fresh (plain single-button fixture, no wrapper) before every `it`; test order doesn't matter.
2. **`?editable=1&download=1` leaks `data-gf-id`/`data-gf-component-asset-id` into a downloaded export** — CONFIRMED, real bug. Fixed: `editable` now also requires `download !== '1'`; added a regression test for the combined-params case.
3. **No literal workbench-page-level "click→patch→reload" integration test** — PARTIALLY VALID, judged already mitigated: the loop is covered end-to-end across two untouched-by-this-plan files (`test/elementPatchPanel.test.tsx` for instruction→POST→success, `test/previewFrame.test.tsx` Task 4 for click→resolve→render-panel), matching this codebase's existing convention of never RTL-testing top-level dashboard pages (`styles/[id]/page.tsx`, `components/page.tsx`, `jobs/page.tsx` all have none either). No plan change; Task 8's manual walkthrough is the backstop, consistent with standing practice.
4. **`documentHash` might not match `componentPatchService`'s own hash** — FALSE POSITIVE. Both sides do `fsPromises.readFile(path, 'utf-8')` then `hashDocument(<string>)` against the same file path — identical operation, match by construction.
5. **Component prop shapes (`PreviewFrame.width`, `StyleBiblePicker`, `PageEditor`, `JobCard`) "asserted without citation"** — FALSE POSITIVE. All read directly from the real files before writing the plan (`width: number | string` confirmed in `PreviewFrame.tsx`, etc.), not guessed.
6. **Unguarded `JSON.parse(page.component_asset_ids)`** — accepted as a style note, not a plan defect: identical unguarded pattern already shipped in `app/dashboard/styles/[id]/page.tsx` for the same field.
7. **Stale-closure risk on `kind` in `handleClick`/`attachAll`** — FALSE POSITIVE. `handleClick` is a plain function nested inside `attachAll`'s own `useCallback` body (deps `[kind, selectMode]`, confirmed in the real file), not a separately memoized callback — no staleness possible.

## Round 2 — DeepSeek

Presented the above verification plus the Task 3 fix. DeepSeek accepted all seven rebuttals point-by-point, tried once more to find a new blocker (checked the nav-route arithmetic and the copilot enum), found none.

**VERDICT: APPROVED.**

## Outcome

1 of 7 findings was real and is fixed in the plan (Task 3's `editable`/`download` precedence + new test). 6 of 7 were false positives from a model with no filesystem access — consistent with this project's own calibration note ("expect roughly 1-in-5 'Important' findings to hold up, not more"). Proceeding to subagent-driven execution.
