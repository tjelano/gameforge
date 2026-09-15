export interface FrameElementInfo {
  tagName: string;
  classes: string[];
  id: string | null; // the DOM `id` attribute the element may carry, NOT data-gf-id
  dataGfId: string | null;
  rect: DOMRect;
}

/**
 * The ONLY module in this codebase allowed to read `iframe.contentDocument` directly for the
 * click-to-select feature. Every export here returns a narrow, copied value — never a node,
 * never outerHTML/innerHTML. This boundary is load-bearing for the security reasoning behind
 * relaxing the preview sandbox to allow-same-origin; see
 * docs/superpowers/specs/2026-09-14-element-specific-patching-design.md.
 */
export function getElementAt(frame: HTMLIFrameElement, clientX: number, clientY: number): FrameElementInfo | null {
  const doc = frame.contentDocument;
  if (!doc) return null;
  const el = doc.elementFromPoint(clientX, clientY);
  if (!el || !(el instanceof doc.defaultView!.HTMLElement)) return null;
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
  return {
    tagName: target.tagName.toLowerCase(),
    classes: Array.from(target.classList),
    id: target.id || null,
    dataGfId: target.getAttribute('data-gf-id'),
    rect,
  };
}

export function getRevisionHash(frame: HTMLIFrameElement): string | null {
  const doc = frame.contentDocument;
  if (!doc) return null;
  const meta = doc.querySelector('meta[name="gf-rev"]');
  return meta?.getAttribute('content') ?? null;
}

export function preventFrameAnchorNavigation(frame: HTMLIFrameElement): () => void {
  const doc = frame.contentDocument;
  if (!doc) return () => {};
  function handler(e: Event) {
    const target = e.target as HTMLElement | null;
    if (target?.closest('a')) e.preventDefault();
  }
  doc.addEventListener('click', handler, true);
  return () => doc.removeEventListener('click', handler, true);
}

export function injectHighlight(frame: HTMLIFrameElement, rect: DOMRect): void {
  const doc = frame.contentDocument;
  if (!doc) return;
  removeHighlight(frame);
  const el = doc.createElement('div');
  el.setAttribute('data-gf-highlight', '');
  // Order matters: `all: initial` resets every property, INCLUDING pointer-events and position —
  // it must come first in this same declaration, with the properties this element actually
  // needs applied after it, or the reset silently wins and the highlight becomes interactive.
  el.style.cssText = `
    all: initial;
    position: fixed;
    top: ${rect.top}px;
    left: ${rect.left}px;
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
