// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NavRail } from '@/app/components/NavRail';
import { CopilotPanel } from '@/app/components/CopilotPanel';

let currentPathname = '/login';
// Mocked directly (rather than via a fetch stub + waitFor) so `user` is
// synchronously truthy from the first render -- useCurrentUser's own fetch
// resolves asynchronously inside a useEffect, which would leave `user` at
// its initial `null` at assertion time and make any `pathname === '/login'`
// regression invisible (the pre-existing `!user` guard would mask it).
let mockUser: { id: string; name: string; isAdmin: boolean } | null = null;

vi.mock('next/navigation', () => ({
  usePathname: () => currentPathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: mockUser, loading: false }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mockUser = null;
});

describe('NavRail/CopilotPanel on /login', () => {
  it('NavRail renders only the brand mark on /login, no nav links', () => {
    currentPathname = '/login';

    render(<NavRail />);

    expect(screen.getByText('Forge')).toBeTruthy();
    expect(screen.queryByText('Generate')).toBeNull();
    expect(screen.queryByText('Overview')).toBeNull();
  });

  it('NavRail renders full nav on /dashboard', () => {
    currentPathname = '/dashboard';

    render(<NavRail />);

    expect(screen.getByText('Generate')).toBeTruthy();
  });

  it('CopilotPanel renders nothing on /login even with a logged-in user', () => {
    currentPathname = '/login';
    mockUser = { id: 'u1', name: 'Alice', isAdmin: false };
    // useOllamaModels fetches once `user` is truthy, regardless of pathname --
    // stub it so that fetch resolves cleanly rather than hitting a real network call.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, data: { models: [], host: '' } }),
    }));

    const { container } = render(<CopilotPanel />);

    expect(container.firstChild).toBeNull();
  });

  it('CopilotPanel renders its toggle button for the same logged-in user off /login', () => {
    currentPathname = '/dashboard';
    mockUser = { id: 'u1', name: 'Alice', isAdmin: false };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, data: { models: [], host: '' } }),
    }));

    render(<CopilotPanel />);

    expect(screen.getByLabelText('Toggle GameForge copilot')).toBeTruthy();
  });
});
