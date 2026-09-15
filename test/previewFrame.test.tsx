// @vitest-environment jsdom
//
// Overrides this project's default vitest `environment: 'node'` (see vitest.config.ts) — PreviewFrame
// is a React component that needs a real DOM. Follows the same setup as test/elementPatchPanel.test.tsx
// (this repo's only other .tsx test file): explicit describe/it/expect imports (no `test.globals`),
// and an explicit `afterEach(cleanup)` since @testing-library/react's own auto-cleanup relies on a
// global `afterEach` this repo's vitest config doesn't register.
//
// lib/preview/inspectFrame.ts is mocked wholesale rather than exercised for real: its own real
// DOM-hit-testing behavior (elementFromPoint, coordinate math) is already covered by
// test/inspectFrame.test.ts, and jsdom has no layout engine to make a real click-to-element
// resolution meaningful here anyway. This file's job is PreviewFrame's own wiring — does it call
// these functions at the right times, with the right args, and render the right thing from their
// return values — not inspectFrame's internals.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import { PreviewFrame } from '@/app/components/PreviewFrame';
import type { FrameElementInfo } from '@/lib/preview/inspectFrame';

vi.mock('@/lib/preview/inspectFrame', () => ({
  getElementAt: vi.fn(),
  getRevisionHash: vi.fn(),
  preventFrameAnchorNavigation: vi.fn(() => () => {}),
  injectHighlight: vi.fn(),
  removeHighlight: vi.fn(),
}));

import { getElementAt, getRevisionHash } from '@/lib/preview/inspectFrame';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // document.fullscreenElement is a real (configurable) accessor on jsdom's Document prototype —
  // reset it after every test so one test forcing it to a since-unmounted wrapper never bleeds
  // into the next test's own fullscreen checks.
  Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
});

function elementInfoOf(overrides: Partial<FrameElementInfo> = {}): FrameElementInfo {
  return {
    tagName: 'button',
    classes: ['btn'],
    id: null,
    dataGfId: '1',
    rect: new DOMRect(0, 0, 10, 10),
    ...overrides,
  };
}

// Forces the wrapper this PreviewFrame instance renders into `document.fullscreenElement`, then
// fires the same `fullscreenchange` event PreviewFrame's own listener reacts to — the standard
// jsdom workaround for a real browser Fullscreen API this environment doesn't implement.
function enterFullscreen(container: HTMLElement): HTMLElement {
  const wrapper = container.querySelector('.preview-frame-wrapper') as HTMLElement;
  Object.defineProperty(document, 'fullscreenElement', { value: wrapper, configurable: true });
  fireEvent(document, new Event('fullscreenchange'));
  return wrapper;
}

function clickSelectToggle() {
  fireEvent.click(screen.getByRole('button', { name: 'Select' }));
}

describe('PreviewFrame', () => {
  it('renders sandbox="" for non-component previews', () => {
    render(<PreviewFrame title="t" width={100} height={100} src="/api/themes/x" />);
    const iframe = screen.getByTitle('t') as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe('');
  });

  it('renders sandbox="allow-same-origin" for component previews', () => {
    render(<PreviewFrame title="t" width={100} height={100} src="/api/components/x" kind="component" />);
    const iframe = screen.getByTitle('t') as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin');
  });

  it('never renders a sandbox value containing allow-scripts', () => {
    render(<PreviewFrame title="t" width={100} height={100} src="/api/components/x" kind="component" />);
    const iframe = screen.getByTitle('t') as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-scripts');
  });

  it('shows the select-mode toggle only when fullscreen and kind is component', () => {
    const { container } = render(
      <PreviewFrame title="t" width={100} height={100} src="/api/components/x" kind="component" />,
    );
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull();

    enterFullscreen(container);
    expect(screen.getByRole('button', { name: 'Select' })).toBeTruthy();
  });

  it('does not show the select-mode toggle in fullscreen for non-component kinds', () => {
    const { container } = render(<PreviewFrame title="t" width={100} height={100} src="/api/themes/x" />);
    enterFullscreen(container);
    // Confirms the breakpoint toolbar itself did render (fullscreen took effect) so the absent
    // Select button reflects the kind check, not a fullscreen mock that silently failed.
    expect(screen.getByRole('button', { name: 'Desktop' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull();
  });

  it('renders ElementPatchPanel once an element is selected, with the given patchEndpoint', () => {
    vi.mocked(getElementAt).mockReturnValue(elementInfoOf());
    vi.mocked(getRevisionHash).mockReturnValue('rev-1');

    const { container } = render(
      <PreviewFrame
        title="t"
        width={100}
        height={100}
        src="/api/components/x"
        kind="component"
        patchEndpoint="/api/jobs/1/component/patch-element"
      />,
    );
    enterFullscreen(container);
    clickSelectToggle();

    const iframe = screen.getByTitle('t') as HTMLIFrameElement;
    fireEvent(iframe.contentWindow!, new MouseEvent('click', { clientX: 1, clientY: 1 }));

    expect(getElementAt).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /apply/i })).toBeTruthy();
  });

  it('does not render a panel when patchEndpoint is omitted, even with a selection', () => {
    vi.mocked(getElementAt).mockReturnValue(elementInfoOf());
    vi.mocked(getRevisionHash).mockReturnValue('rev-1');

    const { container } = render(
      <PreviewFrame title="t" width={100} height={100} src="/api/components/x" kind="component" />,
    );
    enterFullscreen(container);
    clickSelectToggle();

    const iframe = screen.getByTitle('t') as HTMLIFrameElement;
    fireEvent(iframe.contentWindow!, new MouseEvent('click', { clientX: 1, clientY: 1 }));

    expect(getElementAt).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
  });

  it('is the only component in the app rendering an iframe sandbox attribute', () => {
    // A real filesystem grep, not a hardcoded file list — a future new iframe usage in the app
    // directory can't silently bypass PreviewFrame's closed-union sandbox handling without this
    // test catching it.
    function collectTsxFiles(dir: string): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      let files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files = files.concat(collectTsxFiles(full));
        else if (entry.name.endsWith('.tsx')) files.push(full);
      }
      return files;
    }

    const appDir = path.join(process.cwd(), 'app');
    const offenders = collectTsxFiles(appDir)
      .filter((f) => path.basename(f) !== 'PreviewFrame.tsx')
      .filter((f) => fs.readFileSync(f, 'utf8').includes('sandbox='));

    expect(offenders).toEqual([]);
  });
});
