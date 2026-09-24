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
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
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
    componentAssetId: null,
    componentRevisionHash: null,
    rect: new DOMRect(),
    documentHash: 'h',
    ...overrides,
  };
}

function typeInstruction(value: string) {
  fireEvent.change(screen.getByPlaceholderText(/describe the change/i), { target: { value } });
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

  it('calls the patch endpoint with an AbortSignal, trims the instruction, and calls onPatched on success', async () => {
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

    // Leading/trailing whitespace: the Apply-enabled check uses instruction.trim(), and the sent
    // value must match — a raw, untrimmed send would let stray whitespace reach the backend even
    // though the UI treated the trimmed value as what the user "typed".
    typeInstruction('  Make it blue  ');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

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

  it('aborts the in-flight request when Cancel is clicked, and Apply reverts to enabled (not stuck on "Applying…")', async () => {
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

    typeInstruction('Make it blue');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(capturedSignal?.aborted).toBe(true));

    // The bug this guards: the button's accessible name while submitting is literally
    // "Applying…", which /apply/i also matches as a substring — a regex-based query here would
    // pass identically whether or not Cancel actually reverted the button. `{ name: 'Apply' }`
    // (an exact string match) only matches the reverted, enabled state, and the explicit
    // `.disabled` check below is the real assertion.
    const applyButton = await waitFor(() => screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement);
    expect(applyButton.disabled).toBe(false);
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

    typeInstruction('Make it blue');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(capturedSignal).toBeDefined());
    expect(capturedSignal?.aborted).toBe(false);

    unmount();

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('resets instruction and error when the selection changes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: false, error: 'ELEMENT_CHANGED' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(
      <ElementPatchPanel
        patchEndpoint="/x"
        selection={selectionOf({ tagName: 'button', dataGfId: '1' })}
        onPatched={() => {}}
      />,
    );

    typeInstruction('Make A blue');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(screen.getByText(/component changed since you selected/i)).toBeTruthy());
    expect((screen.getByPlaceholderText(/describe the change/i) as HTMLTextAreaElement).value).toBe('Make A blue');

    // Select a different element (a new dataGfId) without ever clicking Apply for it.
    rerender(
      <ElementPatchPanel
        patchEndpoint="/x"
        selection={selectionOf({ tagName: 'span', dataGfId: '2' })}
        onPatched={() => {}}
      />,
    );

    // Both A's leftover instruction text and A's leftover error must be gone under B — otherwise
    // the error looks like it's about B, and a stray click on Apply would send A's text against
    // B's dataGfId.
    expect((screen.getByPlaceholderText(/describe the change/i) as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByText(/component changed since you selected/i)).toBeNull();
  });

  it('resets instruction when a different composed component reuses the same local dataGfId (page mode)', () => {
    // Page mode (composeEditablePageHtml): each composed component's dataGfId sequence
    // independently restarts at 1, so two different components can both have an element with
    // dataGfId === '1' -- componentAssetId is what actually distinguishes them (see
    // test/inspectFrame.test.ts's "resolves componentAssetId..." test). The remount key must
    // incorporate componentAssetId too, or switching from component A's "1" to component B's "1"
    // looks like the same selection and A's stale instruction survives into B.
    const { rerender } = render(
      <ElementPatchPanel
        patchEndpoint="/x"
        selection={selectionOf({ tagName: 'button', dataGfId: '1', componentAssetId: 'asset-A' })}
        onPatched={() => {}}
      />,
    );

    typeInstruction('Make A blue');
    expect((screen.getByPlaceholderText(/describe the change/i) as HTMLTextAreaElement).value).toBe('Make A blue');

    rerender(
      <ElementPatchPanel
        patchEndpoint="/x"
        selection={selectionOf({ tagName: 'span', dataGfId: '1', componentAssetId: 'asset-B' })}
        onPatched={() => {}}
      />,
    );

    expect((screen.getByPlaceholderText(/describe the change/i) as HTMLTextAreaElement).value).toBe('');
  });

  it('ignores a response that arrives after the selection has already changed mid-request', async () => {
    let resolveFetch: ((value: unknown) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const onPatched = vi.fn();

    const { rerender } = render(
      <ElementPatchPanel
        patchEndpoint="/x"
        selection={selectionOf({ tagName: 'button', dataGfId: '1' })}
        onPatched={onPatched}
      />,
    );

    typeInstruction('Make A blue');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Move on to a different element before A's request ever resolves — ElementPatchPanelInner
    // remounts under the new dataGfId key, which both resets instruction/error/submitting for B
    // and (via the OLD instance's own unmount cleanup) aborts A's controller.
    rerender(
      <ElementPatchPanel
        patchEndpoint="/x"
        selection={selectionOf({ tagName: 'span', dataGfId: '2' })}
        onPatched={onPatched}
      />,
    );
    typeInstruction('Make B green');

    // A's request finally settles successfully — too late; the response is for a selection
    // nobody's looking at anymore. This must not fire onPatched, wipe B's just-typed instruction,
    // or leave B's own Apply button disabled.
    await act(async () => {
      resolveFetch?.({ json: () => Promise.resolve({ success: true, data: {} }) });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onPatched).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText(/describe the change/i) as HTMLTextAreaElement).value).toBe('Make B green');
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the server\'s free-text error message verbatim when it is not a recognized PatchError code', async () => {
    // This is exactly what SANITIZE_REJECTED/WRITE_FAILED actually send per Tasks 9-10's routes
    // (componentPatchService.ts / the patch-element routes' messageForError) — free text, not one
    // of the codes in ERROR_MESSAGES.
    const freeText = 'The AI produced invalid markup near <div>';
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: false, error: freeText }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ElementPatchPanel
        patchEndpoint="/x"
        selection={selectionOf({ tagName: 'button', dataGfId: '1' })}
        onPatched={() => {}}
      />,
    );
    typeInstruction('Make it blue');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(screen.getByText(freeText)).toBeTruthy());
  });

  it('shows a distinct message when the response body is not valid JSON', async () => {
    // The server responded (fetch resolved) but res.json() itself rejects — e.g. a
    // proxy/auth-redirect/infra 500 returning an HTML error page. This is a separate branch from
    // both the success path and the fetch-rejects network-failure path, so it must not fire
    // onPatched and must not show the generic "Could not reach the server." message.
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.reject(new Error('Unexpected token <')),
    });
    vi.stubGlobal('fetch', fetchMock);
    const onPatched = vi.fn();

    render(
      <ElementPatchPanel
        patchEndpoint="/x"
        selection={selectionOf({ tagName: 'button', dataGfId: '1' })}
        onPatched={onPatched}
      />,
    );
    typeInstruction('Make it blue');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(screen.getByText('The server returned an unexpected response. Please try again.')).toBeTruthy(),
    );
    expect(onPatched).not.toHaveBeenCalled();
    expect(screen.queryByText(/could not reach the server/i)).toBeNull();
  });

  it('shows an unrecognized error string verbatim instead of a garbled message on an Object.prototype key collision', async () => {
    // If ERROR_MESSAGES were a plain lookup without an own-property guard, `error: 'toString'`
    // would resolve to the inherited Object.prototype.toString function rather than undefined —
    // and passing a function straight to setError doesn't even reach render: React treats it as a
    // functional state updater and calls it with the previous state, so the "error message" that
    // ends up on screen is literally `Object.prototype.toString(prevError)`'s own return value,
    // "[object Undefined]" (confirmed against the pre-fix code — this is what actually happens,
    // not a crash).
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: false, error: 'toString' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ElementPatchPanel
        patchEndpoint="/x"
        selection={selectionOf({ tagName: 'button', dataGfId: '1' })}
        onPatched={() => {}}
      />,
    );
    typeInstruction('Make it blue');
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Apply' }))).not.toThrow();

    await waitFor(() => expect(screen.getByText('toString')).toBeTruthy());
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
    typeInstruction('Make it blue');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

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
    typeInstruction('Make it blue');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    const sanitizeRejectedMessage = await waitFor(() => {
      const node = screen.getByText((_content, el) => el?.className === 'element-patch-panel-error');
      expect(node).toBeTruthy();
      return node.textContent;
    });

    expect(elementChangedMessage).not.toBe(sanitizeRejectedMessage);
  });
});
