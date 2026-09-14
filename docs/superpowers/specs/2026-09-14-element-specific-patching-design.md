# Element-Specific Patching — Design

## Goal

Let a user click a single element inside a component's live preview and ask the AI to change
just that element, instead of the whole component being regenerated from scratch. This closes
the largest gap found in the 2026-09-12 Open WebUI comparison (see
`project_openwebui_comparison_findings` memory): `ComponentGenerator.generate()` always produces
a full new HTML+CSS document, even when `basedOnContent` feedback targets one small change. It's
also the root cause blocking token/delta efficiency for the same reason.

## Why this needs a sandbox change, and why that's safe

Every preview in GameForge renders inside `<iframe sandbox="">` — the empty, maximally strict
sandbox (`app/components/PreviewFrame.tsx`). To detect which element was clicked, GameForge's own
trusted parent-page code needs to read the iframe's live DOM (`iframe.contentDocument`,
`event.target`, `getBoundingClientRect()` for a hover-highlight overlay). With `sandbox=""`,
`contentDocument` is `null` and nothing in the iframe can be read from the parent at all.

**Change:** for component-preview call sites only, relax `sandbox=""` to
`sandbox="allow-same-origin"`. `allow-scripts` is never added, now or ever. Without it, nothing
inside the iframe can execute code regardless of what `allow-same-origin` grants — this is the
one invariant the whole design leans on.

This reasoning went through two rounds of independent, adversarial review (not self-assessed),
cross-model (DeepSeek v4.1-flash) — first a dedicated security audit of the sandbox change in
isolation, then a second pass reviewing this full design. Every concrete, checkable claim from
both rounds was independently verified against GameForge's actual source and, where the claim was
about browser behavior, against a real two-iframe empirical test — not accepted on the reviewer's
word. Two claims from the second round turned out to be false (see "Rejected findings" below);
the rest held up. Verdict after both rounds: **SAFE WITH CHANGES**.

1. **No script-execution bypass exists** for `allow-same-origin` without `allow-scripts` — checked
   nested iframes, SVG, `javascript:` navigation, plugins, all blocked. This is the load-bearing
   claim and it holds.

2. **The parent becomes a renderer of untrusted markup.** Reading `contentDocument` is safe by
   itself; the risk is what the parent does with what it reads. If a "show selected element" UI
   ever did `dangerouslySetInnerHTML(el.outerHTML)`, an `<img onerror=...>` from generated markup
   would fire in GameForge's own origin. **Addressed:** every frame-DOM read goes through a single
   module, `lib/preview/inspectFrame.ts`, whose only export returns `{ tagName, classes, id, rect }`
   — never a node, never `outerHTML`/`innerHTML`. No other file reads `contentDocument` directly.
   This makes the "don't re-insert frame content as markup" rule a code boundary, not a convention
   the next contributor has to remember.

3. **`allow-same-origin` makes the frame's own subresource requests credentialed and
   same-origin-labelled**, where `sandbox=""` makes them cross-site with no cookies attached at
   all — confirmed empirically with a real two-iframe test (zero cookies + `Sec-Fetch-Site:
   cross-site` for `sandbox=""`; real session cookie + `Sec-Fetch-Site: same-origin` for
   `allow-same-origin`). This matters because subresource loads (`<img>`, CSS `url()`, `@import`)
   aren't gated by the sandbox at all — only scripts, forms, and top-navigation are.

   **The actual control here is the route's CSP, not the sanitizer — confirmed with a second
   empirical test.** The component-serving route already sends
   `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:;`. Adding
   this exact header to the two-iframe test and repeating the credentialed-request scenario: both
   the `<img src>` and the CSS `background: url()` request were **blocked by the browser before
   leaving the page** — zero requests reached the test server at all, independent of sandbox value.
   An earlier draft of this design credited `sanitizeComponentCss`'s CSS-function allowlist (no
   `url()`, no at-rules) for closing this gap; that sanitizer does still matter as defense in depth
   for the AI-generation path, but the CSP is what actually makes the credentialed-request scenario
   unreachable on the real served route, regardless of what CSS the document contains or how it got
   there. **Consequence:** this route's CSP header is now a required invariant of the sandbox
   relaxation, not an unrelated hardening detail — see Testing below for the regression test this
   needs.

   One consequence of this: the CSS-credential risk that originally motivated forcing
   `sanitizeComponentCss` to run unconditionally on `edited_externally` ("trusted") hand-edited
   assets is already closed by the CSP, independent of sanitizer state. **Decision: trusted assets
   keep their existing behavior — sanitization stays skipped for both HTML and CSS when
   `edited_externally` is set.** Forcing CSS sanitization there would have thrown a hard `500` on
   any existing hand-edited component using an `@media` query or a CSS function outside the narrow
   allowlist (`sanitizeComponentCss` rejects every at-rule and any function not in a short
   allowlist) — a real regression for the hand-editing flow this design isn't meant to touch, for
   a security property the CSP already provides.

4. **Navigation is not an escape.** `<meta refresh>`/`<a href>` only navigate the frame itself
   (`allow-top-navigation` would be required to escape upward, and it's never granted);
   `javascript:` navigation is blocked by the absent `allow-scripts`. No action needed on the
   navigation-as-escape question. Separately (not a security issue, a functional one): clicking an
   `<a href>` inside the preview while select mode is active would navigate the frame away from the
   component entirely, after which `contentDocument` throws and select mode silently stops
   working. **Addressed:** while select mode is active, the same `inspectFrame.ts` module attaches
   a capturing click listener on `contentDocument` that calls `preventDefault()` on any click whose
   target is or is inside an `<a>`, and re-attaches on every iframe `load` event (in case a
   full regenerate reloads the frame mid-session).

5. **A comment isn't enforcement.** `PreviewFrame.tsx` takes a closed-union prop
   (`sandbox: '' | 'allow-same-origin'`) resolved internally, never a free-form string a call site
   assembles. The regression test for this asserts the actual rendered `<iframe>` element's
   `sandbox` attribute is exactly `''` or `'allow-same-origin'` for each of the app's call sites,
   and that no other component in the app renders an `<iframe sandbox=...>` at all — a plain
   source-grep for the string `allow-scripts` would pass even if a call site built its own
   sandbox string some other way, so the test asserts against the rendered DOM, not source text.

6. **Direct navigation to `/api/components/[filename]` has no sandbox at all** (only the sanitizer,
   and now confirmed the CSP, protect it). Already mitigated independent of this change; no new
   work needed.

### Rejected findings from the design review

Two claims from the second review round were checked against real code/behavior and found false —
noted here so the reasoning trail is honest about what didn't hold up, not just what did:

- *"`themeCss` is injected into the served document without sanitization."* False —
  `AssetService.loadThemeCssForStyle` (`lib/services/AssetService.ts:95`) already calls
  `sanitizeComponentCss(rawCss)` before returning it. The reviewer only saw the serving route, not
  this file.
- *"Component CSS and theme CSS share the cascade, so a patched class rule can be silently
  overridden by a same-specificity theme rule."* False — theme CSS is exclusively a `:root {
  --var: value; }` block (`lib/services/themeTokens.ts:44`), never class selectors. There is no
  selector overlap with a patched `.foo { ... }` rule to collide with.

## Element identification

Each element in a stored component's HTML gets a permanent `data-gf-id="<n>"` attribute.

**Where IDs are assigned:** a new, dedicated `assignElementIds()` function (`lib/services/
componentSanitize.ts`, alongside but separate from `sanitizeComponentHtml`) — not folded into the
sanitizer itself. `sanitizeComponentHtml` is a general-purpose helper used by export, share-to-drive,
and page-render as well as component write paths; changing its output shape for every caller would
mean every one of those has to remember to strip an attribute it never asked for. Only the
component-storage write paths (generate, manual edit, reset) call `assignElementIds()`, after
`sanitizeComponentHtml`. A test asserts `sanitizeComponentHtml`'s own output never contains
`data-gf-id`, pinning the boundary.

**Trust at write time:** `assignElementIds()` strips any incoming `data-gf-id` attribute and
renumbers from scratch, every time it runs at a write path. AI output (or, in principle, a prompt
injection) could otherwise include its own `data-gf-id="1"` on several elements, and since the
attribute is allowlisted for storage, an "only assign if absent" rule would trust it as-is. Fresh
numbering on every write means IDs aren't stable across a full regenerate — a click-to-select
session holding an old ID that clicks "Apply" after a concurrent regenerate must detect that (see
Concurrency below), not silently patch whatever element now happens to hold that number.

**Serve-time behavior:** the existing re-sanitization pass in `GET /api/components/[filename]`
does *not* call `assignElementIds()` — the IDs it serves are exactly whatever the stored file
already has (assigned at the last write), so a single preview session sees stable IDs across
reloads within that session, and the click → patch → re-fetch round trip in this design always
operates against one specific write's numbering.

Consequences:
- `sanitizeComponentHtml`'s `ALLOWED_ATTRIBUTES['*']` gains `data-gf-id` (currently just `class`,
  `id`), so it survives sanitization once assigned — sanitizer and ID-assignment order is
  sanitize-then-assign at write time.
- `data-gf-id` is a GameForge-internal handle, not something that belongs in a user's real,
  exported website — `SiteExporter`, `share-to-drive`, and page-render strip it during export,
  after their existing sanitization/scoping, before the file is written or shared.
- Click-to-select reads `data-gf-id` via `inspectFrame.ts`, off `event.target` (walking up to the
  nearest ancestor that has one, for clicks landing on inline text/pseudo-content).

## Patch generation

**Context sent to the AI:** just the selected element's `outerHTML` plus the user's instruction —
not the full document, not surrounding siblings. Cheapest option, matches the token-efficiency
motivation behind the whole feature. Trade-off, accepted: requests like "match the button next to
it" won't work well without sibling context — out of scope for this iteration.

**CSS scope:** a patch can modify the CSS rule matching the selected element's class in the shared
`<style>` block — not just the element's HTML. Necessary for the feature's most common real use
case ("make this blue"); HTML-only patching would defer all styling to full regeneration.

**New `ComponentGenerator.patchElement()` method**: takes the element's `outerHTML`, the
instruction, and the existing style rule for its class (if any); returns a replacement `outerHTML`
fragment and an optional CSS rule. Prompted narrowly: change only what's asked, preserve the
element's `data-gf-id` and other untouched attributes, return CSS as a full rule block (never a
bare declaration list) whose selector is exactly one class — never a grouped selector
(`.a, .b`), compound selector (`.a .b`), or pseudo-class (`.a:hover`); those are rejected at the
validation step below, not attempted in this iteration. If the element has no class, the class to
use is `gf-<data-gf-id>` — deterministic and already guaranteed unique, rather than an
AI-invented name that could collide across edits.

## Splicing the patch back into the stored document

Locating and replacing a specific element's subtree needs real HTML-tree manipulation —
`sanitize-html`'s `transformTags` hook can rewrite a tag's own attributes as it walks past it, but
it has no supported way to excise and replace an entire subtree. This uses `htmlparser2` directly
(already a transitive dependency via `sanitize-html`, no new package) for the find-and-replace step,
not an attempt to force it through the sanitizer's tag-transform API.

1. Load the stored component file, `parseComponentHtml` it into `{ html, css }` tokens.
2. Walk the HTML (via `htmlparser2`) for the element whose `data-gf-id` matches the target. Not
   found (file hand-edited outside GameForge and lost the attribute, or a concurrent regenerate
   renumbered it — see Concurrency) → reject with a clear, distinct error, no automatic
   regeneration fallback.
3. Run the AI's returned HTML fragment through `sanitizeComponentHtml`. Because that sanitizer
   silently discards disallowed tags/attributes rather than throwing (confirmed against its actual
   implementation — only `sanitizeComponentCss` raises), a silently-over-stripped patch (e.g. a
   fragment that sanitizes down to nothing) would otherwise look like a successful patch that
   deletes the element. This flow adds an explicit check the general sanitizer doesn't provide:
   reject if the sanitized fragment is empty/whitespace-only, and reject if it doesn't parse to
   exactly one root element.
4. Run the AI's returned CSS rule (if present) through `sanitizeComponentCss`, then validate its
   selector: must be exactly one class selector, and that class must be the target element's own
   class (or `gf-<data-gf-id>` for a newly introduced one) — reject anything else (grouped,
   compound, pseudo-augmented, or targeting an unrelated class). A patch is not a trusted source
   just because it's scoped; it goes through the same checks as any other AI output, plus this
   extra validation specific to single-rule patches.
5. Call `assignElementIds()` on the sanitized fragment, seeded at `max(existing data-gf-id in the
   full document) + 1` — not restarted from a fresh counter on the isolated fragment, which would
   collide with IDs already used elsewhere in the document. Assert uniqueness across the combined
   document before writing.
6. Replace the old element's subtree with the sanitized new one; if a CSS rule was returned and a
   rule for that exact class selector already exists, replace it; otherwise append it.
7. `combineComponentHtml` back into a full document, write to storage through the same write
   helper `ComponentGenerator`'s write paths use (so asset metadata stays consistent) — and this
   write must not set `edited_externally`; a patch is not a hand-edit.
8. Client re-fetches the preview (cache-busting the iframe `src`) rather than patching the live DOM
   in place — the served document stays the single source of truth after every edit.

### Concurrency

The read-modify-write above has an AI call inside it, so it isn't instantaneous, and two things can
race it: a second patch, or a full regenerate on the same file.

- **Two concurrent patches / a patch racing a regenerate:** a per-filename in-process async mutex
  serializes writes to the same component file. The AI call itself does not need to hold the mutex
  (it doesn't touch the file) — only the read-locate-sanitize-write sequence does, so the mutex is
  held for a short, bounded window.
- **ABA problem:** a full `generate()` call rewrites the file and reassigns IDs from a fresh
  counter, so a patch request holding `data-gf-id="3"` from before a regenerate could otherwise
  silently splice into whatever element now happens to be numbered `3`, not the element the user
  actually selected. Before splicing, the server re-checks a content signature the client captured
  at select time (the target element's `data-gf-id` plus a hash of its `outerHTML` at selection
  time) against the current stored document; a mismatch fails with a distinct "element changed,
  re-select" error rather than patching the wrong element.

### Endpoint contract

`POST /api/jobs/[id]/component/patch-element` (exact route TBD at plan time, following the existing
`app/api/jobs/[id]/component/*` pattern) takes `{ filename, dataGfId, elementSignature, instruction
}` — not just `{ dataGfId, instruction }`, since a `data-gf-id` is only unique within one document
and the server needs to know which file to load. Reuses the existing filename validator (the
`/`, `\`, `..` check already duplicated across the read routes) — this is a case where the plan
should extract it into one shared helper rather than adding a fourth copy.

## Click-to-select UI/UX

- A new toolbar toggle on `PreviewFrame` (alongside the existing fullscreen/breakpoint controls,
  fullscreen-only, component previews only) enters "select mode."
- Because the frame is now genuinely same-origin, the parent reads `iframe.contentDocument`
  directly via `inspectFrame.ts` — no `postMessage`, no bridge script.
- **Highlight overlay:** injected as a single `position: fixed` element into the frame's *own*
  document (via the same same-origin DOM write access `allow-same-origin` grants), not computed as
  parent-page coordinates. Computing `getBoundingClientRect()` in the parent and positioning an
  overlay over the iframe from outside would need to account for the iframe's own offset, parent
  scroll, internal frame scroll, and the `scale()` transform the breakpoint-preview toolbar
  (PR #30) applies when a Mobile/Tablet breakpoint is active — all avoidable by putting the
  highlight element inside the frame's own coordinate space instead, where none of that applies.
- Clicking locks the selection and opens a small side panel: selected element's tag/class, a text
  input for the instruction, and an Apply button. Reuses the existing feedback-style interaction
  already established by `ComponentGenerator.generate()`'s `basedOnContent` parameter for
  whole-document regeneration, just scoped to one element.
- Apply calls the patch endpoint with `{ filename, dataGfId, elementSignature, instruction }`,
  passing an `AbortSignal` (the same pattern `generate()` already uses) so navigating away or
  closing the panel mid-request cancels the in-flight AI call rather than leaving it running against
  a file the mutex is holding. On success, reloads the preview iframe.

## Error handling

Structured error codes returned by the patch endpoint, surfaced in the side panel rather than a
generic failure message:
- `ELEMENT_NOT_FOUND` — target `data-gf-id` missing at patch time (hand-edited file, or the
  element genuinely no longer exists).
- `ELEMENT_CHANGED` — the concurrency signature check failed; tell the user to re-select.
- `SANITIZE_REJECTED` — the AI's returned HTML or CSS failed sanitization/validation; the stored
  document is left untouched.
- `CONFLICT` — a concurrent write is already in progress for this file (mutex contention beyond a
  short wait); retry.
- `WRITE_FAILED` — filesystem error on save; logged server-side via `console.error`, matching the
  rest of the codebase's pattern for file-write failures.

## Out of scope for this iteration

- Sibling/parent context in patch prompts ("match the one next to it").
- Multi-element (rectangle-select) patching.
- Pseudo-class-targeted patches ("add a hover effect").
- Undo/redo beyond whatever GameForge's existing edit history already covers.

## Testing

In addition to the usual unit coverage for the new functions above:
- A regression test asserting the component-serving route's CSP header is present with
  `img-src data:` (or stricter) — this is now a required invariant of the sandbox relaxation, not
  an unrelated hardening detail, per the empirical finding above.
- A test asserting every `PreviewFrame` call site's *rendered* `sandbox` attribute (not source
  text) is exactly `''` or `'allow-same-origin'`, and that no other component in the app renders an
  `<iframe sandbox=...>`.
- A test asserting `sanitizeComponentHtml`'s output never contains `data-gf-id` (pins the
  sanitizer/ID-assignment boundary).
- A concurrency test: two patches (or a patch and a regenerate) racing the same file resolve to one
  applied write and one `CONFLICT`/`ELEMENT_CHANGED`, never a silently lost update.
