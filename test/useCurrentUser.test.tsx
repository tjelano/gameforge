// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { useCurrentUser } from '@/lib/hooks/useCurrentUser';

const pushMock = vi.fn();
let currentPathname = '/dashboard';

vi.mock('next/navigation', () => ({
  usePathname: () => currentPathname,
  useRouter: () => ({ push: pushMock }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  pushMock.mockClear();
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
    expect(pushMock).toHaveBeenCalledWith('/login?reason=expired');
  });

  it('does not redirect when unauthenticated on /login itself', async () => {
    currentPathname = '/login';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, data: null }) }));

    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('anon'));
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('does not redirect when a real user is returned', async () => {
    currentPathname = '/dashboard';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, data: { id: 'u1', name: 'Alice', isAdmin: false } }),
    }));

    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('Alice'));
    expect(pushMock).not.toHaveBeenCalled();
  });
});
