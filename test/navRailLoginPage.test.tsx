// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NavRail } from '@/app/components/NavRail';
import { CopilotPanel } from '@/app/components/CopilotPanel';

let currentPathname = '/login';

vi.mock('next/navigation', () => ({
  usePathname: () => currentPathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('NavRail/CopilotPanel on /login', () => {
  it('NavRail renders only the brand mark on /login, no nav links', () => {
    currentPathname = '/login';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, data: null }) }));

    render(<NavRail />);

    expect(screen.getByText('Forge')).toBeTruthy();
    expect(screen.queryByText('Generate')).toBeNull();
    expect(screen.queryByText('Overview')).toBeNull();
  });

  it('NavRail renders full nav on /dashboard', () => {
    currentPathname = '/dashboard';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, data: null }) }));

    render(<NavRail />);

    expect(screen.getByText('Generate')).toBeTruthy();
  });

  it('CopilotPanel renders nothing on /login even with a logged-in user', () => {
    currentPathname = '/login';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, data: { id: 'u1', name: 'Alice', isAdmin: false } }),
    }));

    const { container } = render(<CopilotPanel />);

    expect(container.firstChild).toBeNull();
  });
});
