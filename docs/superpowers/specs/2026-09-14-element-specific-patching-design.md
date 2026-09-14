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
cross-model (DeepSeek v4.1-flash) — a dedicated security audit of the sandbox change first, then
two further rounds reviewing this full design as it was written and then revised. Every concrete,
checkable claim across all rounds was independently verified against GameForge's actual source
and, where the claim was about browser behavior, against a real two-iframe empirical test — never
accepted on the reviewer's word alone. Three claims across the process turned out to be false (see
"Rejected findings" below); everything else held up, including two rounds of the reviewer
confirming its own earlier claims after seeing the code it hadn't originally had. Final verdict on
the security posture, after the reviewer inspected the closed-out design: **no remaining objection
to `sandbox="allow-same-origin"` without `allow-scripts` on this route**, given the CSP is enforced
there and the frame-DOM read path is confined to one module.

1. **No script-execution bypass exists** for `allow-same-origin` without `allow-scripts` — checked
   nested iframes, SVG, `javascript:` navigation, plugins, all blocked. This is the load-bearing
   claim and it holds.

2. **The parent becomes a renderer of untrusted markup.** Reading `contentDocument` is safe by
   itself; the risk is what the parent does with what it reads. If a "show selected element" UI
   ever did `dangerouslySetInnerHTML(el.outerHTML)`, an `<img onerror=...>` from generated markup
   would fire in GameForge's own origin. **Addressed:** every frame-DOM read goes through a single
   module, `lib/preview/inspectFrame.ts`, whose only export returns `{ tagName, classes, id, rect }`
   — never a node, never `outerHTML`/`innerHTML`. No other file reads `contentDocument` directly.
   This module's return shape is deliberately narrow enough that it cannot leak markup even by
   accident; the concurrency design below does not require widening it (see "Concurrency").

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
   The CSP is what makes the credentialed-request scenario unreachable on the real served route,
   regardless of what CSS the document contains or how it got there — the sanitizer's CSS-function
   allowlist still matters as defense in depth for the AI-generation path, but isn't what's
   actually closing this gap.

   **This makes the CSP header a cross-route invariant, not a per-route detail.** It's exported as
   one shared constant (`lib/services/componentSanitize.ts`'s module, or a small dedicated
   `lib/preview/previewCsp.ts` — implementation detail for the plan), imported by the
   component-serving route, and asserted by name in its test rather than duplicated as a literal
   string — so a second route that ever serves HTML into a relaxed-sandbox frame doesn't silently
   miss it. The `sandbox=` closed-union type (finding 5, below) carries a comment pointing at this
   constant, since the sandbox relaxation and the CSP are now a matched pair, not two independent
   hardening details.

   One consequence: the CSS-credential risk that originally motivated forcing
   `sanitizeComponentCss` to run unconditionally on `edited_externally` ("trusted") hand-edited
   assets is already closed by the CSP, independent of sanitizer state. **Decision: trusted assets
   keep their existing behavior — sanitization stays skipped for both HTML and CSS when
   `edited_externally` is set.** Forcing CSS sanitization there would have thrown a hard `500` on
   any existing hand-edited component using an `@media` query or a CSS function outside the narrow
   allowlist — a real regression for the hand-editing flow this design isn't meant to touch, for a
   security property the CSP already provides. (This has a real, separate downstream consequence
   for element identification on trusted files — see "Trusted/hand-edited components" below.)

4. **Navigation is not an escape.** `<meta refresh>`/`<a href>` only navigate the frame itself
   (`allow-top-navigation` would be required to escape upward, and it's never granted);
   `javascript:` navigation is blocked by the absent `allow-scripts`. No action needed on the
   navigation-as-escape question. Separately (not a security issue, a functional one): clicking an
   `<a href>` inside the preview while select mode is active would navigate the frame away from the
   component entirely, after which `contentDocument` throws and select mode silently stops
   working. **Addressed:** while select mode is active, `inspectFrame.ts` attaches a capturing
   click listener on `contentDocument` that calls `preventDefault()` on any click whose target is
   or is inside an `<a>`, and re-attaches on every iframe `load` event (in case a full regenerate
   reloads the frame mid-session).

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

Three claims made across the review process were checked against real code/behavior and found
false — noted here so the reasoning trail is honest about what didn't hold up, not just what did:

- *"`themeCss` is injected into the served document without sanitization."* False —
  `AssetService.loadThemeCssForStyle` (`lib/services/AssetService.ts:95`) already calls
  `sanitizeComponentCss(rawCss)` before returning it. The reviewer only saw the serving route, not
  this file — confirmed by the reviewer itself on the next round, once shown the source.
- *"Component CSS and theme CSS share the cascade, so a patched class rule can be silently
  overridden by a same-specificity theme rule."* False as originally stated — theme CSS is
  exclusively a `:root { --var: value; }` block (`lib/services/themeTokens.ts:44`), never class
  selectors, so there's no selector overlap with theme CSS to collide with. The reviewer confirmed
  this on the next round but correctly noted the underlying *class* of bug — a patch's rule losing
  to a higher- or equal-specificity existing rule — still exists inside the component's own
  stylesheet. That's addressed directly below (see "CSS scope").
- An earlier draft credited `sanitizeComponentCss`'s allowlist for closing the CSS-credential gap
  from finding 3. Superseded, not exactly "false" — the sanitizer does still matter as defense in
  depth, but the CSP is what actually closes the gap on the real route, independent of the
  sanitizer. Corrected in finding 3 above.

## Element identification

Each element in a stored component's HTML gets a permanent `data-gf-id="<n>"` attribute.

**Where IDs are assigned:** a new, dedicated `assignElementIds()` function (`lib/services/
componentSanitize.ts`, alongside but separate from `sanitizeComponentHtml`) — not folded into the
sanitizer itself, since that's a general-purpose helper also used by export, share-to-drive, and
page-render; changing its output shape for every caller would mean every one of those has to
remember to strip an attribute it never asked for. Only the component-storage write paths
(generate, manual edit, reset) call `assignElementIds()`, after `sanitizeComponentHtml`. A test
asserts `sanitizeComponentHtml`'s own output never contains `data-gf-id`, pinning the boundary.

**Trust at write time:** on a fresh write (generate/manual-edit/reset, not a patch — see below),
`assignElementIds()` strips any incoming `data-gf-id` attribute and renumbers the whole document
from scratch. AI output (or, in principle, a prompt injection) could otherwise include its own
`data-gf-id="1"` on several elements, and since the attribute is allowlisted for storage, trusting
whatever's already present would let that stand unchecked.

**Preserving identity across a patch:** a patch (see "Splicing" below) calls
`assignElementIds(fragment, { preserveRootId: targetId, startAt: n })` — a second mode this
function supports. The fragment's root element (the one the AI was told to preserve the id on)
keeps `targetId` unchanged; only new descendant elements introduced by the patch get fresh ids,
starting at `n` (the caller passes `max(existing data-gf-id in the full document) + 1`). Without
this distinction, the same "strip and renumber everything" behavior used for fresh writes would
strip the very id the patch just spliced by, immediately invalidating the id the client's UI is
still holding.

**Serve-time behavior:** the existing re-sanitization pass in `GET /api/components/[filename]`
does *not* call `assignElementIds()` at all — the IDs it serves are exactly whatever the stored
file already has, so a single preview session sees stable IDs across reloads.

**Trusted/hand-edited components:** `edited_externally` assets skip `sanitizeComponentHtml`
entirely (existing behavior, kept as-is per the CSP finding above), and this design does **not**
call `assignElementIds()` on that path either — reverse-synced hand-edits never get `data-gf-id`
attributes at all, on any write. Consequence, and how it's handled: every element in a trusted
preview is unselectable. This is detected client-side, not discovered only after a failed patch —
`inspectFrame.ts` already reads an element's attributes on hover, so if the hovered element (and
every ancestor up to `<body>`) has no `data-gf-id`, the hover/select UI shows "hand-edited content
— use full regeneration to change this" instead of a selectable highlight, and Apply is never
reachable for it. No AI round-trip gets spent on a patch that was always going to fail.

Consequences for the normal (non-trusted) path:
- `sanitizeComponentHtml`'s `ALLOWED_ATTRIBUTES['*']` gains `data-gf-id` (currently just `class`,
  `id`), so it survives sanitization once assigned — sanitizer and ID-assignment order is
  sanitize-then-assign at write time.
- `data-gf-id` is a GameForge-internal handle, not something that belongs in a user's real,
  exported website — `SiteExporter`, `share-to-drive`, and page-render strip it during export,
  after their existing sanitization/scoping, before the file is written or shared.
- Click-to-select reads `data-gf-id` via `inspectFrame.ts`, off `event.target` (walking up to the
  nearest ancestor that has one, for clicks landing on inline text/pseudo-content).
- **Duplicate ids:** the write-time "strip and renumber everything" rule prevents duplicates from
  ever being freshly written, but a hand-edited-then-later-generated history, or a bug, could in
  principle still produce one. If the server's locate-by-id step (see "Splicing") ever finds more
  than one match, it treats that as ambiguous and fails closed (`ELEMENT_NOT_FOUND`) rather than
  silently acting on the first match — and the "assert uniqueness" check in the splice flow runs
  as a precondition on the freshly-read document, not only as a postcondition on the newly-written
  one.

## Patch generation

**Context sent to the AI:** just the selected element's `outerHTML` plus the user's instruction —
not the full document, not surrounding siblings. Cheapest option, matches the token-efficiency
motivation behind the whole feature. Trade-off, accepted: requests like "match the button next to
it" won't work well without sibling context — out of scope for this iteration.

**CSS scope:** a patch can add or modify a CSS rule for the selected element — not just its HTML.
Necessary for the feature's most common real use case ("make this blue"); HTML-only patching would
defer all styling to full regeneration.

Rules are **not** targeted by the element's existing class. A class-selector rule is exactly as
specific as any other single-class rule already in the stylesheet (CSS specificity is positional,
not semantic), so a patch appended at the end of `tokens.css` can lose to an existing
higher-or-equal-specificity rule already styling that element (e.g. a `.card .foo` rule at 0,2,0
beats an appended `.foo` at 0,1,0 outright, and even an equal-specificity rule earlier in the file
only loses on source-order — fragile to rely on). Instead, patches target the element's own
`data-gf-id` via an attribute selector: `[data-gf-id="<n>"] { ... }`, appended at the end of
`tokens.css`. This doesn't need a class to exist on the element at all (no more "if the element has
no class, invent one" case), and gives every patch a dedicated, unshared selector that only ever
matches the one element it was written for — no risk of a patch accidentally restyling siblings
that share a class. Known, accepted limitation for this iteration: an existing rule with genuinely
higher specificity than a single attribute selector (e.g. a multi-level descendant selector) can
still visually override a patch: computing and out-specifying arbitrary existing selectors is out
of scope here (see "Out of scope").

**New `ComponentGenerator.patchElement()` method**: takes the element's `outerHTML` and the
instruction; returns a replacement `outerHTML` fragment and an optional CSS declaration list (not
a full rule — the server wraps it in the `[data-gf-id="<n>"] { ... }` selector itself, so the AI
never needs to know or reproduce the element's id). Prompted narrowly: change only what's asked,
preserve the element's `data-gf-id` and other untouched attributes.

## Splicing the patch back into the stored document

Locating and replacing a specific element's subtree needs real HTML-tree manipulation —
`sanitize-html`'s `transformTags` hook can rewrite a tag's own attributes as it walks past it, but
it has no supported way to excise and replace an entire subtree. This uses `htmlparser2` directly
(already a transitive dependency via `sanitize-html`, no new package) for the find-and-replace step.

1. Client-side, before the AI call: fetch the stored file's current content hash (a cheap `HEAD` or
   small `GET` against a hash endpoint, computed server-side over the raw stored file) at the
   moment select mode is entered, and hold it alongside the selected `data-gf-id`. This is a
   *document*-level revision check, not a per-element one — an earlier draft of this design tried
   to hash the selected element's own `outerHTML` client-side and compare it against a
   server-recomputed hash, which doesn't work: `inspectFrame.ts` deliberately never exposes
   `outerHTML` (see finding 2 above), and even if it did, a browser-serialized fragment and an
   `htmlparser2`-reserialized one differ on attribute order/quoting/whitespace, so the hashes
   would mismatch even with no real change. A whole-document hash sidesteps both problems.
2. `ComponentGenerator.patchElement()` runs — **without holding any file lock**. This is a
   potentially-slow network call; nothing about it touches the file, so nothing needs to
   serialize against it yet.
3. Acquire a per-filename in-process async mutex (assumes a single Node process — true for
   `next dev` and single-instance `next start`; if GameForge ever runs multiple instances behind a
   load balancer, this stops being sufficient and `CONFLICT` silently degrades to last-writer-wins).
4. Re-read the stored file. Compare its current content hash against the one the client sent; a
   mismatch means the document changed since selection (another patch, or a full regenerate) —
   fail with `ELEMENT_CHANGED`, release the mutex, no write.
5. `parseComponentHtml` the freshly-read file into `{ html, css }`. Walk the HTML (via
   `htmlparser2`) for the element whose `data-gf-id` matches the target — more than one match is
   ambiguous, treated as `ELEMENT_NOT_FOUND` (see "Duplicate ids" above); no match likewise.
6. Run the AI's returned HTML fragment through `sanitizeComponentHtml`. Because that sanitizer
   silently discards disallowed tags/attributes rather than throwing (confirmed against its actual
   implementation — only `sanitizeComponentCss` raises), this flow adds an explicit check the
   general sanitizer doesn't provide: reject if the sanitized fragment is empty/whitespace-only,
   and reject if it doesn't parse to exactly one root element.
7. If the AI returned a CSS declaration list, wrap it as `[data-gf-id="<n>"] { <declarations> }`
   and run that through `sanitizeComponentCss`.
8. Call `assignElementIds(sanitizedFragment, { preserveRootId: targetId, startAt: max(existing
   data-gf-id in the freshly-read document) + 1 })`. Assert the resulting document has no duplicate
   ids before proceeding.
9. Replace the old element's subtree with the sanitized new one; if a CSS rule was produced and a
   rule for that exact `[data-gf-id="<n>"]` selector already exists (from an earlier patch),
   replace it; otherwise append it.
10. `combineComponentHtml` back into a full document. Immediately `parseComponentHtml` that result
    again and assert it round-trips to the same `{ html, css }` tokens before writing — this
    format's `parseComponentHtml`/`combineComponentHtml` are naive `indexOf` splits on literal
    `<style>`/`</style>`/`<body>`/`</body>` markers, and while `sanitizeComponentCss` already
    guards its own input against embedding those literal strings, this is a different, later stage
    (post-serialization, whole-document) — the round-trip assertion catches any way a marker
    sequence could still have ended up somewhere it corrupts the next read, without having to
    reason precisely about every serializer's escaping guarantees.
11. Write to storage through the same write path `ComponentGenerator`'s other write methods use —
    this must (a) not set `edited_externally`, since a patch is not a hand-edit, and (b) update the
    asset's recorded prompt/notes the same way `generate()` does, appending the patch instruction
    rather than leaving the stored history describing a document that no longer matches. Without
    this, "Out of scope: undo/redo beyond whatever GameForge's existing edit history already
    covers" (below) would be a false promise — there'd be no history covering patches at all.
12. Release the mutex. Client re-fetches the preview (cache-busting the iframe `src`) rather than
    patching the live DOM in place.

## Endpoint contract

`POST /api/jobs/[id]/component/patch-element` (exact route TBD at plan time, following the
existing `app/api/jobs/[id]/component/*` pattern) takes `{ filename, dataGfId, documentHash,
instruction }`. Reuses the existing filename validator (the `/`, `\`, `..` check already
duplicated across the read routes — extract it into one shared helper rather than adding a fourth
copy). Whether `filename` must additionally be verified as belonging to job `[id]` should follow
whatever the existing sibling routes (`app/api/jobs/[id]/component/route.ts`,
`.../reset/route.ts`) already do for that same check — this design doesn't introduce a new
authorization model, it matches the established one.

## Click-to-select UI/UX

- A new toolbar toggle on `PreviewFrame` (alongside the existing fullscreen/breakpoint controls,
  fullscreen-only, component previews only) enters "select mode."
- Because the frame is now genuinely same-origin, the parent reads `iframe.contentDocument`
  directly via `inspectFrame.ts` — no `postMessage`, no bridge script.
- **Highlight overlay:** injected as a single element into the frame's *own* document (via the
  same same-origin DOM write access `allow-same-origin` grants) — not computed as parent-page
  coordinates, which would need to account for the iframe's own offset, parent scroll, internal
  frame scroll, and the `scale()` transform the breakpoint-preview toolbar (PR #30) applies at a
  Mobile/Tablet breakpoint. Two things this requires beyond just "inject a positioned div": the
  highlight must have `pointer-events: none`, or it becomes the actual hover/click target instead
  of the element underneath it, defeating its own purpose; and it needs a hard style reset (an
  `all: initial`-equivalent), since it's a child of the component's own `<body>` and would
  otherwise inherit arbitrary AI-generated or hand-written CSS from the very component it's
  overlaying. Re-injected after every frame `load`.
- Clicking locks the selection and opens a small side panel: selected element's tag/class, a text
  input for the instruction, and an Apply button (disabled, with an inline explanation, if the
  selected element has no `data-gf-id` — see "Trusted/hand-edited components"). Reuses the
  existing feedback-style interaction already established by `ComponentGenerator.generate()`'s
  `basedOnContent` parameter for whole-document regeneration, just scoped to one element.
- Apply calls the patch endpoint with `{ filename, dataGfId, documentHash, instruction }`, passing
  an `AbortSignal` (the same pattern `generate()` already uses) so navigating away or closing the
  panel mid-request cancels the in-flight AI call. On success, the response includes the patched
  element's id map (root id unchanged, any new descendant ids) and the new document hash, so the
  panel can immediately re-select the same element without a round trip; then reloads the preview
  iframe.

## Error handling

Structured error codes returned by the patch endpoint, surfaced in the side panel rather than a
generic failure message:
- `COMPONENT_NOT_FOUND` — the file was deleted between selection and Apply (matches the existing
  serving route's 404-on-ENOENT handling).
- `ELEMENT_NOT_FOUND` — target `data-gf-id` missing, or matched more than once.
- `ELEMENT_CHANGED` — the document hash didn't match at write time (concurrent patch or
  regenerate); tell the user to re-select.
- `SANITIZE_REJECTED` — the AI's returned HTML or CSS failed sanitization/validation; the stored
  document is left untouched.
- `CONFLICT` — mutex contention beyond a short wait; retry.
- `WRITE_FAILED` — filesystem error on save; logged server-side via `console.error`, matching the
  rest of the codebase's pattern for file-write failures.

## Out of scope for this iteration

- Sibling/parent context in patch prompts ("match the one next to it").
- Multi-element (rectangle-select) patching.
- Pseudo-class-targeted patches ("add a hover effect").
- Out-specifying an existing rule with genuinely higher specificity than a single attribute
  selector (see "CSS scope").
- Undo/redo beyond whatever GameForge's existing edit history already covers (now true — see
  Splicing step 11).

## Testing

In addition to the usual unit coverage for the new functions above:
- A regression test asserting the component-serving route's CSP header (imported from its shared
  constant, not re-typed) is present with `img-src data:` (or stricter) — this is now a required
  invariant of the sandbox relaxation, not an unrelated hardening detail.
- A test asserting every `PreviewFrame` call site's *rendered* `sandbox` attribute (not source
  text) is exactly `''` or `'allow-same-origin'`, and that no other component in the app renders an
  `<iframe sandbox=...>`.
- A test asserting `sanitizeComponentHtml`'s output never contains `data-gf-id` (pins the
  sanitizer/ID-assignment boundary).
- A concurrency test: two patches (or a patch and a regenerate) racing the same file resolve to one
  applied write and one `ELEMENT_CHANGED`/`CONFLICT`, never a silently lost update.
- Negative tests for the AI-returned CSS declaration list wrapping: confirm the server-built
  selector is always exactly `[data-gf-id="<n>"]` regardless of what the AI returns (the AI never
  supplies a selector, only declarations, so there's no selector-injection surface to test against
  on that input — but a test still confirms the wrapping is applied correctly for a representative
  declaration list).
- A test asserting a patch preserves the target element's `data-gf-id` unchanged while any new
  descendants introduced by the patch receive fresh, non-colliding ids.
