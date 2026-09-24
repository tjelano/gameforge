// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { useCurrentUser } from '@/lib/hooks/useCurrentUser';

// The hook calls router.replace() (not .push()) so Back doesn't re-enter the
// redirect loop — see useCurrentUser.ts. Mocking only the method actually used.
const replaceMock = vi.fn();
// Next's real useRouter() returns a referentially stable object across renders;
// router is in the effect's own dependency array, so a mock that returns a new
// object each call would be less faithful than the real thing.
const routerMock = { replace: replaceMock };
let currentPathname = '/dashboard';

vi.mock('next/navigation', () => ({
  usePathname: () => currentPathname,
  useRouter: () => routerMock,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  replaceMock.mockClear();
});

function Probe() {
  const { user, loading } = useCurrentUser();
  return <div data-testid="probe">{loading ? 'loading' : user ? user.name : 'anon'}</div>;
}

describe('useCurrentUser stale-session redirect', () => {
  it('redirects to /login?reason=expired when unauthenticated on a /dashboard route', async () => {
    currentPathname = '/dashboard/generate';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, data: null }) }));

    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('anon'));
    expect(replaceMock).toHaveBeenCalledWith('/login?reason=expired');
  });

  it('does not redirect when unauthenticated on /login itself', async () => {
    currentPathname = '/login';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, data: null }) }));

    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('anon'));
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('does not redirect when a real user is returned', async () => {
    currentPathname = '/dashboard';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, data: { id: 'u1', name: 'Alice', isAdmin: false } }),
    }));

    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('Alice'));
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('does not redirect on a body.success:false transient-error response (not the same as a stale session)', async () => {
    currentPathname = '/dashboard/generate';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: false, error: 'boom' }),
    }));

    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('anon'));
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
