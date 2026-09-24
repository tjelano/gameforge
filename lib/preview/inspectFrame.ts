export interface FrameElementInfo {
  // Every string field below is read out of AI-generated or hand-edited preview markup — it is
  // attacker-influenced content, not GameForge's own trusted text. Render it as plain text (JSX
  // interpolation, which auto-escapes) — never via dangerouslySetInnerHTML, and never interpolated
  // into a CSS or query selector string.
  tagName: string;
  classes: string[];
  id: string | null; // the DOM `id` attribute the element may carry, NOT data-gf-id
  dataGfId: string | null;
  // Populated only inside a page-mode composed document (composeEditablePageHtml, Task 1 of the
  // website-builder-workbench plan) -- null for a single-component preview or any click that lands
  // outside every composed item's wrapper.
  componentAssetId: string | null;
  componentRevisionHash: string | null;
  rect: DOMRect;
}

/**
 * The ONLY module in this codebase allowed to read `iframe.contentDocument` directly for the
 * click-to-select feature. Every export here returns a narrow, copied value — never a node,
 * never outerHTML/innerHTML. This boundary is load-bearing for the security reasoning behind
 * relaxing the preview sandbox to allow-same-origin; see
 * docs/superpowers/specs/2026-09-14-element-specific-patching-design.md.
 */
export function getElementAt(frame: HTMLIFrameElement, frameX: number, frameY: number): FrameElementInfo | null {
  // frameX/frameY must already be relative to the iframe's own viewport, not the parent page's —
  // callers that listen on `frame.contentWindow` (rather than the parent window) get this for
  // free, since mouse-event clientX/clientY are always relative to whichever window the listener
  // is attached to.
  const doc = frame.contentDocument;
  if (!doc) return null;
  const win = doc.defaultView;
  const el = doc.elementFromPoint(frameX, frameY);
  // `el instanceof win.Element`, not `win.HTMLElement`: hand-edited/trusted content (the only
  // content that skips the AI-output sanitizer, whose allowlist excludes <svg> entirely) can
  // contain real <svg> markup, and SVG elements are SVGElement, not HTMLElement. Narrowing to
  // HTMLElement here would return null before ever reaching the closest() ancestor-walk below —
  // exactly the case that walk exists to handle for icon buttons like
  // <button data-gf-id="1"><svg>...</svg></button>. Checking the broader Element interface and
  // letting closest() do the real work handles both HTML and SVG content correctly. `win` is
  // read from `doc.defaultView` (not asserted with `!`) because it can transiently be null around
  // a frame navigation/reload — e.g. right after a patch-triggered reload — and a thrown error
  // here would crash a hover/click handler rather than just fail this one lookup.
  if (!el || !win || !(el instanceof win.Element)) return null;
  // A click/hover can land on an inline text/pseudo-content element nested inside the element
  // that actually carries data-gf-id (e.g. a <span> inside <button data-gf-id="1">Go</button>).
  // The "selection" IS the data-gf-id'd ancestor as a whole — not whichever inner element the
  // point happened to hit — so the highlight outlines that whole element and the patch panel
  // describes that element, not an inner span. closest() is inclusive of el itself. If no
  // ancestor (including el) carries data-gf-id at all — hand-edited/trusted content, which never
  // gets ids assigned on any write path — fall back to the hovered element itself so select mode
  // still has something to show (dataGfId: null signals "unselectable" to the caller, rather than
  // returning null and showing nothing at all).
  const target = el.closest<HTMLElement>('[data-gf-id]') ?? el;
  const rect = target.getBoundingClientRect();
  // Independent of `target` above -- a page-mode wrapper (composeEditablePageHtml) is an ancestor
  // of whatever data-gf-id element target resolved to, so walking from `el` (inclusive) finds the
  // same nearest wrapper either way. Null for single-component previews, which never emit this
  // attribute at all.
  const componentWrapper = el.closest<HTMLElement>('[data-gf-component-asset-id]');
  return {
    tagName: target.tagName.toLowerCase(),
    classes: Array.from(target.classList),
    id: target.id || null,
    // `|| null`, not a bare attribute read: getAttribute returns "" (not null) for a literal
    // empty attribute value. A stray `data-gf-id=""` in hand-edited content must still mean
    // "absent" — not "has a value" — to satisfy the "null means absent/unselectable" contract
    // ElementPatchPanel's `dataGfId === null` check relies on.
    dataGfId: target.getAttribute('data-gf-id') || null,
    componentAssetId: componentWrapper?.getAttribute('data-gf-component-asset-id') || null,
    componentRevisionHash: componentWrapper?.getAttribute('data-gf-rev') || null,
    rect,
  };
}

export function getRevisionHash(frame: HTMLIFrameElement): string | null {
  const doc = frame.contentDocument;
  if (!doc) return null;
  const meta = doc.querySelector('meta[name="gf-rev"]');
  // `|| null`: same empty-string-vs-absent contract as getElementAt's dataGfId above — `??` would
  // only catch meta being null/undefined, not a meta tag present with a literal `content=""`.
  return meta?.getAttribute('content') || null;
}

export function preventFrameAnchorNavigation(frame: HTMLIFrameElement): () => void {
  const doc = frame.contentDocument;
  if (!doc) return () => {};
  // Captured in its own const (rather than referencing the outer `doc` from inside the nested
  // handler below) so the null-check above actually narrows the type TS sees inside the closure.
  const frameDoc = doc;
  function handler(e: Event) {
    // Re-read defaultView on every click rather than capturing it once: it can transiently be
    // null around a frame navigation/reload, same reasoning as getElementAt above. e.target is
    // typed as EventTarget, which in rare edge cases (a click outside all content) can be the
    // Document itself rather than an Element — .closest() doesn't exist on that, so this checks
    // `instanceof win.Element` before calling it, rather than asserting the type with a cast that
    // could throw and kill the whole capturing listener.
    const win = frameDoc.defaultView;
    const target = e.target;
    if (win && target instanceof win.Element && target.closest('a')) e.preventDefault();
  }
  frameDoc.addEventListener('click', handler, true);
  return () => frameDoc.removeEventListener('click', handler, true);
}

export function injectHighlight(frame: HTMLIFrameElement, rect: DOMRect): void {
  const doc = frame.contentDocument;
  // doc.body can transiently be null in the same reload window noted above, if the new document
  // hasn't finished parsing yet.
  if (!doc || !doc.body) return;
  removeHighlight(frame);
  const el = doc.createElement('div');
  el.setAttribute('data-gf-highlight', '');
  // Order matters: `all: initial` resets every property, INCLUDING pointer-events and position —
  // it must come first in this same declaration, with the properties this element actually
  // needs applied after it, or the reset silently wins and the highlight becomes interactive.
  //
  // `position: absolute`, not `fixed`: `fixed` anchors to the iframe's viewport, so if the
  // component's own content is taller than the preview and the user scrolls *within* the frame,
  // a fixed highlight stays frozen at its original screen position instead of following the
  // element. `rect` (from getBoundingClientRect) is viewport-relative; adding the frame
  // document's own scroll offset converts it to document-relative, which is what an absolutely
  // positioned element (with no positioned ancestor, so its containing block is the document
  // itself) needs in order to scroll together with the content it's highlighting.
  el.style.cssText = `
    all: initial;
    position: absolute;
    top: ${rect.top + doc.documentElement.scrollTop}px;
    left: ${rect.left + doc.documentElement.scrollLeft}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    z-index: 2147483647;
    pointer-events: none;
    outline: 2px solid #4d90fe;
    outline-offset: -1px;
    box-sizing: border-box;
  `;
  doc.body.appendChild(el);
}

export function removeHighlight(frame: HTMLIFrameElement): void {
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.querySelector('[data-gf-highlight]')?.remove();
}
