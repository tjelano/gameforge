// @vitest-environment jsdom
//
// Second file (after test/inspectFrame.test.ts) to override this project's default vitest
// `environment: 'node'` (see vitest.config.ts) — a React component needs a real DOM to render
// into. This is also this codebase's first .tsx test and first use of @testing-library/react,
// added as a devDependency for this task (checked: no existing .test.tsx convention, no
// @testing-library/react devDependency before this task — see package.json and the absence of
// any prior test/*.test.tsx file).
//
// vitest.config.ts does not set `test.globals: true` (every other test file in this repo imports
// describe/it/expect/beforeEach explicitly from 'vitest', matching that), so
// @testing-library/react's own afterEach-based auto-cleanup — which relies on detecting a global
// `afterEach` — never registers here. `afterEach(cleanup)` below does that unmounting explicitly;
// without it, a selection from one test's render() would still be mounted (and its effects/timers
// live) when the next test's render() runs.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ElementPatchPanel } from '@/app/components/ElementPatchPanel';
import type { FrameElementInfo } from '@/lib/preview/inspectFrame';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function selectionOf(overrides: Partial<FrameElementInfo & { documentHash: string | null }>) {
  return {
    tagName: 'div',
    classes: [] as string[],
    id: null,
    dataGfId: null,
    rect: new DOMRect(),
    documentHash: 'h',
    ...overrides,
  };
}

describe('ElementPatchPanel', () => {
  it('renders nothing when selection is null', () => {
    const { container } = render(
      <ElementPatchPanel patchEndpoint="/x" selection={null} onPatched={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows the selected element tag/class', () => {
    render(
      <ElementPatchPanel
        patchEndpoint="/x"
        selection={selectionOf({ tagName: 'button', classes: ['btn'], dataGfId: '1' })}
        onPatched={() => {}}
      />,
    );
    expect(screen.getByText(/button/)).toBeTruthy();
  });

  it('disables Apply and shows a message when dataGfId is null', () => {
    render(
      <ElementPatchPanel
        patchEndpoint="/x"
        selection={selectionOf({ tagName: 'div', dataGfId: null })}
        onPatched={() => {}}
      />,
    );
    const applyButton = screen.getByRole('button', { name: /apply/i }) as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
    expect(screen.getByText(/hand-edited/i)).toBeTruthy();
  });

  it('calls the patch endpoint with an AbortSignal and calls onPatched on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, data: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const onPatched = vi.fn();

    render(
      <ElementPatchPanel
        patchEndpoint="/api/jobs/job1/component/patch-element"
        selection={selectionOf({ tagName: 'button', classes: ['btn'], dataGfId: '1', documentHash: 'hash-1' })}
        onPatched={onPatched}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/describe the change/i), {
      target: { value: 'Make it blue' },
    });
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => expect(onPatched).toHaveBeenCalledTimes(1));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/jobs/job1/component/patch-element');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      dataGfId: '1',
      documentHash: 'hash-1',
      instruction: 'Make it blue',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts the in-flight request when Cancel is clicked', async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ElementPatchPanel
        patchEndpoint="/x"
        selection={selectionOf({ tagName: 'button', dataGfId: '1' })}
        onPatched={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/describe the change/i), {
      target: { value: 'Make it blue' },
    });
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(capturedSignal?.aborted).toBe(true));
    // An aborted request must not surface the generic network-error message, and Apply must come
    // back enabled rather than staying stuck in "Applying…".
    await waitFor(() => expect(screen.getByRole('button', { name: /apply/i })).toBeTruthy());
    expect(screen.queryByText(/could not reach the server/i)).toBeNull();
  });

  it('aborts the in-flight request on unmount', async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return new Promise(() => {}); // never resolves — only the abort signal should fire
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = render(
      <ElementPatchPanel
        patchEndpoint="/x"
        selection={selectionOf({ tagName: 'button', dataGfId: '1' })}
        onPatched={() => {}}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/describe the change/i), {
      target: { value: 'Make it blue' },
    });
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    await waitFor(() => expect(capturedSignal).toBeDefined());
    expect(capturedSignal?.aborted).toBe(false);

    unmount();

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('shows a distinct message per structured error code', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: false, error: 'ELEMENT_CHANGED' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ElementPatchPanel
        patchEndpoint="/x"
        selection={selectionOf({ tagName: 'button', dataGfId: '1' })}
        onPatched={() => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/describe the change/i), {
      target: { value: 'Make it blue' },
    });
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    const elementChangedMessage = await waitFor(() => {
      const node = screen.getByText((_content, el) => el?.className === 'element-patch-panel-error');
      expect(node).toBeTruthy();
      return node.textContent;
    });

    cleanup();
    vi.restoreAllMocks();

    const fetchMock2 = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: false, error: 'SANITIZE_REJECTED' }),
    });
    vi.stubGlobal('fetch', fetchMock2);

    render(
      <ElementPatchPanel
        patchEndpoint="/x"
        selection={selectionOf({ tagName: 'button', dataGfId: '1' })}
        onPatched={() => {}}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/describe the change/i), {
      target: { value: 'Make it blue' },
    });
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    const sanitizeRejectedMessage = await waitFor(() => {
      const node = screen.getByText((_content, el) => el?.className === 'element-patch-panel-error');
      expect(node).toBeTruthy();
      return node.textContent;
    });

    expect(elementChangedMessage).not.toBe(sanitizeRejectedMessage);
  });
});
