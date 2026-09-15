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
// getElementAt()'s REAL logic (the null-doc guard, the HTMLElement
// instanceof check, and the narrow-shape copying) rather than mocking
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
    expect(Object.keys(info!).sort()).toEqual(['classes', 'dataGfId', 'id', 'rect', 'tagName']);
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

  it('injectHighlight adds a non-interactive, reset-styled element into the frame', () => {
    injectHighlight(iframe, new DOMRect(10, 20, 30, 40));
    const highlight = iframe.contentDocument!.querySelector('[data-gf-highlight]');
    expect(highlight).not.toBeNull();
    const style = (highlight as HTMLElement).style;
    expect(style.pointerEvents).toBe('none');
    expect(style.position).toBe('fixed');
  });

  it('removeHighlight removes it', () => {
    injectHighlight(iframe, new DOMRect(0, 0, 10, 10));
    removeHighlight(iframe);
    expect(iframe.contentDocument!.querySelector('[data-gf-highlight]')).toBeNull();
  });
});
