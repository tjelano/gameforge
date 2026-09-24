// @vitest-environment jsdom
//
// This file is the one exception to this project's default vitest
// `environment: 'node'` (see vitest.config.ts) — inspectFrame.ts exists to
// read a real iframe's contentDocument, so its tests need a real DOM, not
// mocks of the DOM APIs themselves. No other test/ file in this repo touches
// the DOM (checked: no existing .test.tsx convention, no jsdom devDependency
// before this task), so the override is scoped to this file via the vitest
// docblock pragma rather than changing the global environment for all 155+
// other (non-DOM) tests.
//
// jsdom performs no CSS layout at all: every element's getBoundingClientRect()
// is hard-zeroed and document.elementFromPoint does not exist as a function
// (confirmed against the installed jsdom 30.0.1, and against happy-dom
// 20.14.5 too — neither implements real layout/paint; this is a fundamental
// property of every non-browser DOM library, not a version gap). So
// getElementAt()'s coordinate-based hit-testing is real-browser-only
// behavior no Node DOM library can execute natively. To still exercise
// getElementAt()'s REAL logic (the null-doc guard, the Element instanceof
// check, and the narrow-shape copying) rather than mocking
// getElementAt itself or its return value, this file supplies a generic,
// non-test-specific elementFromPoint that does real point-in-rect
// containment over the iframe's actual elements — the standard workaround
// for testing position-dependent DOM code under jsdom — plus explicit
// getBoundingClientRect overrides on the elements under test, since jsdom
// has no layout engine to compute real ones from. Neither stubs
// getElementAt's own behavior.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getElementAt,
  getRevisionHash,
  preventFrameAnchorNavigation,
  injectHighlight,
  removeHighlight,
} from '@/lib/preview/inspectFrame';

function installElementFromPointPolyfill(doc: Document) {
  doc.elementFromPoint = (x: number, y: number) => {
    const all = Array.from(doc.querySelectorAll('*'));
    for (let i = all.length - 1; i >= 0; i--) {
      const rect = all[i].getBoundingClientRect();
      if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) return all[i];
    }
    return null;
  };
}

describe('inspectFrame', () => {
  let iframe: HTMLIFrameElement;

  beforeEach(() => {
    iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    iframe.contentDocument!.open();
    iframe.contentDocument!.write(`
      <html><head><meta name="gf-rev" content="abc123def"></head>
      <body><button class="btn primary" data-gf-id="1">Go</button></body></html>
    `);
    iframe.contentDocument!.close();
    installElementFromPointPolyfill(iframe.contentDocument!);
  });

  it('getElementAt returns only the narrow shape — never a node reference', () => {
    const btn = iframe.contentDocument!.querySelector('button')!;
    // jsdom has no layout engine (see file header) — supply a real, concrete
    // rect so the generic elementFromPoint polyfill above has real geometry
    // to hit-test against, instead of jsdom's hard-zeroed default.
    btn.getBoundingClientRect = () => new DOMRect(100, 50, 80, 30);
    const rect = btn.getBoundingClientRect();
    const info = getElementAt(iframe, rect.left + 1, rect.top + 1);
    expect(info).not.toBeNull();
    expect(info!.tagName).toBe('button');
    expect(info!.classes).toEqual(['btn', 'primary']);
    expect(info!.dataGfId).toBe('1');
    expect(Object.keys(info!).sort()).toEqual(['classes', 'componentAssetId', 'componentRevisionHash', 'dataGfId', 'id', 'rect', 'tagName']);
  });

  it('getElementAt resolves to the nearest data-gf-id ancestor, not the element literally hit', () => {
    iframe.contentDocument!.open();
    iframe.contentDocument!.write(`
      <html><body>
        <button class="btn primary" data-gf-id="1"><span class="label">Go</span></button>
      </body></html>
    `);
    iframe.contentDocument!.close();
    installElementFromPointPolyfill(iframe.contentDocument!);
    const btn = iframe.contentDocument!.querySelector('button')!;
    const span = iframe.contentDocument!.querySelector('span')!;
    // The span fills its button on screen — jsdom has no layout (see file
    // header), so both rects are supplied explicitly, overlapping.
    btn.getBoundingClientRect = () => new DOMRect(100, 50, 80, 30);
    span.getBoundingClientRect = () => new DOMRect(100, 50, 80, 30);
    // The polyfill's reverse document-order scan hits the span first (it's
    // later in the tree than its button), exercising the ancestor walk.
    const info = getElementAt(iframe, 110, 60);
    expect(info).not.toBeNull();
    expect(info!.tagName).toBe('button');
    expect(info!.classes).toEqual(['btn', 'primary']);
    expect(info!.dataGfId).toBe('1');
  });

  it('getElementAt falls back to the hovered element when no ancestor has data-gf-id (hand-edited/trusted content)', () => {
    iframe.contentDocument!.open();
    iframe.contentDocument!.write(`
      <html><body>
        <div class="trusted-content"><p class="greeting">Hello</p></div>
      </body></html>
    `);
    iframe.contentDocument!.close();
    installElementFromPointPolyfill(iframe.contentDocument!);
    const p = iframe.contentDocument!.querySelector('p')!;
    p.getBoundingClientRect = () => new DOMRect(0, 0, 50, 20);
    const info = getElementAt(iframe, 5, 5);
    expect(info).not.toBeNull();
    expect(info!.tagName).toBe('p');
    expect(info!.classes).toEqual(['greeting']);
    expect(info!.dataGfId).toBeNull();
  });

  it('getElementAt returns null instead of throwing when defaultView is transiently unavailable', () => {
    // defaultView can genuinely be null around a frame navigation/reload (e.g. right after a
    // patch-triggered reload) — force that real, spec-legal state onto the real document (not a
    // mock of getElementAt's own logic) and confirm the null-doc-guard style check actually
    // prevents a throw, rather than asserting via `!`.
    Object.defineProperty(iframe.contentDocument, 'defaultView', { value: null, configurable: true });
    expect(() => getElementAt(iframe, 1, 1)).not.toThrow();
    expect(getElementAt(iframe, 1, 1)).toBeNull();
  });

  it('getElementAt walks up through an SVGElement to find its data-gf-id ancestor (icon button)', () => {
    // Hand-edited/trusted content is the only content that can contain <svg> at all — the
    // AI-output sanitizer's allowlist excludes it — but that content never gets sanitized, so an
    // icon button like this is a real case. SVG descendants are SVGElement, not HTMLElement; this
    // pins that the instanceof check no longer excludes them before closest() can run.
    iframe.contentDocument!.open();
    iframe.contentDocument!.write(`
      <html><body>
        <button class="icon-btn" data-gf-id="1"><svg><circle cx="5" cy="5" r="5"></circle></svg></button>
      </body></html>
    `);
    iframe.contentDocument!.close();
    installElementFromPointPolyfill(iframe.contentDocument!);
    const btn = iframe.contentDocument!.querySelector('button')!;
    const svg = iframe.contentDocument!.querySelector('svg')!;
    btn.getBoundingClientRect = () => new DOMRect(100, 50, 80, 30);
    svg.getBoundingClientRect = () => new DOMRect(100, 50, 80, 30);
    const info = getElementAt(iframe, 110, 60);
    expect(info).not.toBeNull();
    expect(info!.tagName).toBe('button');
    expect(info!.classes).toEqual(['icon-btn']);
    expect(info!.dataGfId).toBe('1');
  });

  it('getElementAt normalizes a literal empty data-gf-id attribute to null, not ""', () => {
    // The attribute-presence selector [data-gf-id] matches regardless of value, so closest()
    // still finds this element — the narrow return shape is what must turn "" into "absent".
    iframe.contentDocument!.open();
    iframe.contentDocument!.write(`
      <html><body><div class="stray" data-gf-id=""></div></body></html>
    `);
    iframe.contentDocument!.close();
    installElementFromPointPolyfill(iframe.contentDocument!);
    const div = iframe.contentDocument!.querySelector('div')!;
    div.getBoundingClientRect = () => new DOMRect(0, 0, 40, 40);
    const info = getElementAt(iframe, 5, 5);
    expect(info).not.toBeNull();
    expect(info!.dataGfId).toBeNull();
  });

  it('getElementAt resolves componentAssetId and componentRevisionHash from the nearest data-gf-component-asset-id wrapper', () => {
    iframe.contentDocument!.open();
    iframe.contentDocument!.write(`
      <html><body>
        <div class="page-item-0" data-gf-component-asset-id="asset-1" data-gf-rev="hash-1">
          <button class="btn" data-gf-id="1">Go</button>
        </div>
        <div class="page-item-1" data-gf-component-asset-id="asset-2" data-gf-rev="hash-2">
          <button class="btn" data-gf-id="1">Also Go</button>
        </div>
      </body></html>
    `);
    iframe.contentDocument!.close();
    installElementFromPointPolyfill(iframe.contentDocument!);
    const buttons = iframe.contentDocument!.querySelectorAll('button');
    buttons[0].getBoundingClientRect = () => new DOMRect(0, 0, 80, 30);
    buttons[1].getBoundingClientRect = () => new DOMRect(0, 40, 80, 30);

    const first = getElementAt(iframe, 10, 10);
    expect(first).not.toBeNull();
    expect(first!.componentAssetId).toBe('asset-1');
    expect(first!.componentRevisionHash).toBe('hash-1');

    // Two different wrapped components reuse the same data-gf-id ("1") -- confirms resolution is
    // scoped per-wrapper, not accidentally global across the composed page.
    const second = getElementAt(iframe, 10, 50);
    expect(second).not.toBeNull();
    expect(second!.componentAssetId).toBe('asset-2');
    expect(second!.componentRevisionHash).toBe('hash-2');
  });

  it('getElementAt resolves componentAssetId through an icon-inside-button, same as the data-gf-id ancestor walk', () => {
    iframe.contentDocument!.open();
    iframe.contentDocument!.write(`
      <html><body>
        <div class="page-item-0" data-gf-component-asset-id="asset-1" data-gf-rev="hash-1">
          <button class="icon-btn" data-gf-id="1"><svg><circle cx="5" cy="5" r="5"></circle></svg></button>
        </div>
      </body></html>
    `);
    iframe.contentDocument!.close();
    installElementFromPointPolyfill(iframe.contentDocument!);
    const btn = iframe.contentDocument!.querySelector('button')!;
    const svg = iframe.contentDocument!.querySelector('svg')!;
    btn.getBoundingClientRect = () => new DOMRect(100, 50, 80, 30);
    svg.getBoundingClientRect = () => new DOMRect(100, 50, 80, 30);
    const info = getElementAt(iframe, 110, 60);
    expect(info).not.toBeNull();
    expect(info!.componentAssetId).toBe('asset-1');
  });

  it('getElementAt returns null componentAssetId/componentRevisionHash outside any wrapper (non-page-mode content)', () => {
    const btn = iframe.contentDocument!.querySelector('button')!;
    btn.getBoundingClientRect = () => new DOMRect(100, 50, 80, 30);
    const rect = btn.getBoundingClientRect();
    const info = getElementAt(iframe, rect.left + 1, rect.top + 1);
    expect(info).not.toBeNull();
    expect(info!.componentAssetId).toBeNull();
    expect(info!.componentRevisionHash).toBeNull();
  });

  it('getRevisionHash reads the gf-rev meta tag', () => {
    expect(getRevisionHash(iframe)).toBe('abc123def');
  });

  it('getRevisionHash returns null if the meta tag is absent', () => {
    iframe.contentDocument!.open();
    iframe.contentDocument!.write('<html><head></head><body></body></html>');
    iframe.contentDocument!.close();
    expect(getRevisionHash(iframe)).toBeNull();
  });

  it('getRevisionHash normalizes a literal empty content attribute to null, not ""', () => {
    iframe.contentDocument!.open();
    iframe.contentDocument!.write('<html><head><meta name="gf-rev" content=""></head><body></body></html>');
    iframe.contentDocument!.close();
    expect(getRevisionHash(iframe)).toBeNull();
  });

  it('preventFrameAnchorNavigation prevents default on anchor clicks', () => {
    iframe.contentDocument!.open();
    iframe.contentDocument!.write('<html><body><a href="https://example.com">link</a></body></html>');
    iframe.contentDocument!.close();
    const cleanup = preventFrameAnchorNavigation(iframe);
    const a = iframe.contentDocument!.querySelector('a')!;
    // contentWindow is typed as the DOM-lib `Window` interface, which (per
    // lib.dom.d.ts) declares global constructors like MouseEvent as ambient
    // `var`s, not as Window members — so TS doesn't see `.MouseEvent` on it
    // even though it's really there at runtime. This narrows just enough to
    // reach it without widening to `any`, while still using the iframe's own
    // window's constructor (not the outer test window's) for realm
    // correctness.
    const ContentMouseEvent = (iframe.contentWindow as unknown as { MouseEvent: typeof MouseEvent })
      .MouseEvent;
    const event = new ContentMouseEvent('click', { bubbles: true, cancelable: true });
    const wasDefaultPrevented = !a.dispatchEvent(event);
    expect(wasDefaultPrevented).toBe(true);
    cleanup();
  });

  it('preventFrameAnchorNavigation does not throw when the click target is not an Element', () => {
    // A click dispatched directly on the Document (rather than on an element inside it) sets
    // e.target to the Document itself — a real EventTarget that is not an Element and has no
    // .closest() method. This pins that the instanceof check actually guards the .closest() call,
    // rather than an unchecked cast that would throw and kill the whole capturing listener.
    iframe.contentDocument!.open();
    iframe.contentDocument!.write('<html><body></body></html>');
    iframe.contentDocument!.close();
    const cleanup = preventFrameAnchorNavigation(iframe);
    const ContentEvent = (iframe.contentWindow as unknown as { Event: typeof Event }).Event;
    const event = new ContentEvent('click', { bubbles: true, cancelable: true });
    expect(() => iframe.contentDocument!.dispatchEvent(event)).not.toThrow();
    cleanup();
  });

  it('injectHighlight adds a non-interactive, reset-styled element into the frame', () => {
    injectHighlight(iframe, new DOMRect(10, 20, 30, 40));
    const highlight = iframe.contentDocument!.querySelector('[data-gf-highlight]');
    expect(highlight).not.toBeNull();
    const style = (highlight as HTMLElement).style;
    expect(style.pointerEvents).toBe('none');
    // absolute, not fixed: a fixed highlight would stay frozen on screen while the user scrolls
    // *within* the frame's own content instead of following the element it's outlining.
    expect(style.position).toBe('absolute');
  });

  it('injectHighlight accounts for the frame document\'s own scroll offset', () => {
    iframe.contentDocument!.documentElement.scrollTop = 50;
    iframe.contentDocument!.documentElement.scrollLeft = 20;
    injectHighlight(iframe, new DOMRect(10, 20, 30, 40));
    const highlight = iframe.contentDocument!.querySelector('[data-gf-highlight]') as HTMLElement;
    // rect.top/left (viewport-relative) + the frame's own scroll offset = document-relative,
    // which is what an absolutely positioned element needs to scroll with the content.
    expect(highlight.style.top).toBe('70px');
    expect(highlight.style.left).toBe('30px');
  });

  it('injectHighlight does not throw when body is transiently unavailable', () => {
    // body can genuinely be null in the same reload window noted above, if the new document
    // hasn't finished parsing yet — force that real state onto the real document and confirm the
    // guard actually prevents a throw from appendChild on null.
    Object.defineProperty(iframe.contentDocument, 'body', { value: null, configurable: true });
    expect(() => injectHighlight(iframe, new DOMRect(0, 0, 10, 10))).not.toThrow();
  });

  it('removeHighlight removes it', () => {
    injectHighlight(iframe, new DOMRect(0, 0, 10, 10));
    removeHighlight(iframe);
    expect(iframe.contentDocument!.querySelector('[data-gf-highlight]')).toBeNull();
  });
});
