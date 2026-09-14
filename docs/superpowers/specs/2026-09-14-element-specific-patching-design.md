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

This reasoning was independently audited (not self-assessed) by an adversarial review, cross-model
(DeepSeek v4.1-flash), and the audit's own claims were independently verified — one empirically,
via a real two-iframe browser test comparing `sandbox=""` against `sandbox="allow-same-origin"`,
and others against GameForge's actual source rather than taken on the audit's word. Verdict: **SAFE
WITH CHANGES**. Findings and how each is addressed in this design:

1. **No script-execution bypass exists** for `allow-same-origin` without `allow-scripts` — the
   audit checked nested iframes, SVG, `javascript:` navigation, plugins, all blocked. Confirmed
   correct; this is the load-bearing claim and it holds.

2. **The parent becomes a renderer of untrusted markup.** Reading `contentDocument` is safe by
   itself; the risk is what the parent does with what it reads. If a "show selected element" UI
   ever did `dangerouslySetInnerHTML(el.outerHTML)`, an `<img onerror=...>` from generated markup
   would fire in GameForge's own origin. **Addressed:** the click-to-select code path reads only
   `tagName` and a fixed allowlist of attributes (`class`, `id`) from the frame's DOM — never
   `innerHTML`/`outerHTML` re-inserted into the parent as markup, and never `dangerouslySetInnerHTML`
   anywhere in this feature.

3. **`allow-same-origin` makes the frame's own subresource requests credentialed and
   same-origin-labelled**, where `sandbox=""` makes them cross-site with no cookies attached at
   all. Verified empirically: a real two-iframe test showed the `sandbox=""` frame's request
   carrying zero cookies and `Sec-Fetch-Site: cross-site`, while the `allow-same-origin` frame's
   request carried real session cookies and `Sec-Fetch-Site: same-origin`. This matters because
   subresource loads (`<img>`, CSS `url()`, `@import`, etc.) aren't gated by the sandbox at all —
   only scripts, forms, and top-navigation are. **Addressed two ways:**
   - The normal (AI-generated) path already can't reach this: `sanitizeComponentCss` is an
     allowlist of CSS functions that does not include `url()`, and rejects every at-rule
     (`@import` included) outright — verified against `lib/services/componentSanitize.ts` and its
     existing test coverage (hex-escaped `url()`, `image-set()`, `cross-fade()` evasions all
     covered).
   - **Real gap found during verification, now closed by this design:** `edited_externally`
     ("trusted") assets from the reverse-sync hand-edit flow skip sanitization entirely at
     `app/api/components/[filename]/route.ts:60-63` — including CSS. This design changes that
     route to run `sanitizeComponentCss` unconditionally, even when `trusted` is true. HTML
     sanitization stays governed by `trusted` as before (that's what hand-editing actually needs
     preserved — structure/attributes, not CSS resource-loading functions). This is scoped to the
     preview-serving route only; `SiteExporter`, `share-to-drive`, and page-render keep their
     existing trust behavior, since those produce the user's real, exported website and full CSS
     trust is the whole point of marking something hand-edited there.

4. **Navigation is not an escape.** `<meta refresh>`/`<a href>` only navigate the frame itself
   (`allow-top-navigation` would be required to escape upward, and it's never granted);
   `javascript:` navigation is blocked by the absent `allow-scripts`. No action needed.

5. **A comment isn't enforcement.** `PreviewFrame.tsx` will take a closed-union prop
   (`sandbox: '' | 'allow-same-origin'`) resolved internally, never a free-form string a call site
   assembles — plus a test asserting the literal string `allow-scripts` never appears anywhere in
   the sandbox value used by any call site, so a future change can't silently reintroduce the one
   combination (`allow-same-origin` + `allow-scripts`) that actually is a full escape.

6. **Direct navigation to `/api/components/[filename]` has no sandbox at all** (only the sanitizer
   protects it). Already mitigated independent of this change: the route sets
   `Content-Security-Policy: default-src 'none'; ...`, and `script-src` falls back to `default-src`
   per the CSP spec when not explicitly set — script execution is already blocked there. No new
   work needed; confirmed by reading `app/api/components/[filename]/route.ts:77` directly rather
   than assuming.

## Element identification

Each element in a stored component's HTML gets a permanent `data-gf-id="<n>"` attribute, injected
once at write time (inside `sanitizeComponentHtml`, so every existing write path — generate, manual
edit, reset — gets it automatically). IDs are assigned only to elements that don't already have
one, so re-sanitizing at serve time (the existing defense-in-depth re-sanitization pass) never
renumbers anything.

Consequences, all handled in this design:
- `sanitizeComponentHtml`'s `ALLOWED_ATTRIBUTES['*']` gains `data-gf-id` (currently just `class`,
  `id`).
- `data-gf-id` is a GameForge-internal handle, not something that belongs in a user's real,
  exported website — `SiteExporter`, `share-to-drive`, and page-render strip it during export,
  after sanitization/scoping, before the file is written or shared.
- Click-to-select reads `data-gf-id` off `event.target` (walking up to the nearest ancestor that
  has one, for clicks that land on inline text/pseudo-content) — no path-matching or DOM-diffing
  needed to identify the target.

## Patch generation

**Context sent to the AI:** just the selected element's `outerHTML` plus the user's instruction —
not the full document, not surrounding siblings. This is the cheapest option and matches the
token-efficiency motivation behind the whole feature. Trade-off, accepted: requests like "match the
button next to it" won't work well without sibling context — out of scope for this iteration.

**CSS scope:** a patch can modify the CSS rule(s) matching the selected element's existing class in
the shared `<style>` block — not just the element's HTML. This is necessary for the feature's most
common real use case ("make this blue"); HTML-only patching would defer all styling to full
regeneration and defeat much of the point. The CSS the AI returns for the patch goes through the
same `sanitizeComponentCss` allowlist as full-document generation — no separate, looser path.

**New `ComponentGenerator.patchElement()` method**: takes the element's `outerHTML`, the
instruction, and the existing style rule matching its first class (if any); returns a replacement
`outerHTML` fragment and an optional CSS rule update. Prompted narrowly: change only what's asked,
preserve the element's `data-gf-id` and other untouched attributes, return CSS as a full rule block
scoped to the existing class (never a bare declaration list). If the element has no class, the AI
may introduce one (e.g. `gf-patch-<n>`) and return a new rule for it — never an inline `style`
attribute, since the sanitizer's attribute allowlist doesn't and won't permit one.

## Splicing the patch back into the stored document

1. Load the stored component file, `parseComponentHtml` it into `{ html, css }` tokens.
2. Walk the HTML for the element whose `data-gf-id` matches the target. Not found (e.g. the file
   was hand-edited outside GameForge and lost the attribute) → reject with a clear error, no
   regeneration fallback attempted automatically.
3. Run the AI's returned HTML fragment through `sanitizeComponentHtml`, and its CSS rule (if any)
   through `sanitizeComponentCss`, exactly as any other AI output is sanitized — a patch is not a
   trusted source just because it's scoped.
4. If the sanitized fragment contains new child elements, assign them fresh `data-gf-id`s (same
   "only elements without one" rule as full-document sanitization) so they're immediately
   selectable too.
5. Replace the old element's subtree with the sanitized new one; if a CSS rule was returned, replace
   the existing rule for that class in the stored `<style>` block (or append it, if none existed).
6. `combineComponentHtml` back into a full document, write to storage.
7. Client re-fetches the preview (cache-busting the iframe `src`) rather than trying to patch the
   live DOM in place — keeps the served document as the single source of truth after every edit.

## Click-to-select UI/UX

- A new toolbar toggle on `PreviewFrame` (alongside the existing fullscreen/breakpoint controls,
  fullscreen-only, component previews only) enters "select mode."
- Because the frame is now genuinely same-origin, the parent reads `iframe.contentDocument`
  directly — no `postMessage`, no bridge script (there's nothing inside the frame capable of
  sending one anyway).
- Hovering computes `getBoundingClientRect()` on the element under the cursor and draws a highlight
  as an absolutely-positioned overlay in the *parent* page over the iframe — never injected into
  the iframe itself.
- Clicking locks the selection and opens a small side panel: selected element's tag/class, a text
  input for the instruction, and an Apply button. This reuses the existing feedback-style
  interaction already established by `ComponentGenerator.generate()`'s `basedOnContent` parameter
  for whole-document regeneration, just scoped to one element.
- Apply calls the new patch endpoint with `{ dataGfId, instruction }`, waits for success, then
  reloads the preview iframe.

## Error handling

- Target element's `data-gf-id` missing at patch time → reject, tell the user to use full
  regeneration instead (no silent fallback).
- AI's returned patch fails `sanitizeComponentHtml`/`sanitizeComponentCss` → reject the patch,
  leave the stored document untouched, surface the sanitizer's error message.
- `iframe.contentDocument` access throws or returns null (should not happen once
  `allow-same-origin` is set for a same-origin `src`, but defensively) → disable select mode with a
  message rather than silently failing hover/click handlers.

## Out of scope for this iteration

- Sibling/parent context in patch prompts ("match the one next to it").
- Multi-element (rectangle-select) patching.
- Undo/redo beyond whatever GameForge's existing edit history already covers.
