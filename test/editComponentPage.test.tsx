// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { Suspense } from 'react';
import EditComponentPage from '@/app/dashboard/jobs/[id]/edit-component/page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('EditComponentPage load failure', () => {
  it('shows an error instead of hanging on Loading… when the initial fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    // `use(params)` suspends on mount; production gets a Suspense boundary for
    // free from Next's router, a bare RTL render does not, so one is provided
    // here. The initial render is awaited inside `act` so the retry once the
    // params promise settles is flushed before the assertion below runs —
    // without both, this hangs on the Suspense fallback forever, even against
    // a correctly-fixed page (verified against react 19.2.8 / RTL 16.3.3).
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <EditComponentPage params={Promise.resolve({ id: 'job1' })} />
        </Suspense>
      );
    });

    await waitFor(() => expect(screen.getByText('Could not reach the server.')).toBeTruthy());
  });
});
