// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import AssetsPage from '@/app/dashboard/assets/page';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Assets page loading state', () => {
  it('shows a loading indicator, not an empty grid, while the initial fetch is in flight', () => {
    // A fetch that never resolves during this test's lifetime.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    render(<AssetsPage />);

    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByText(/nothing promoted yet/i)).toBeNull();
  });
});
