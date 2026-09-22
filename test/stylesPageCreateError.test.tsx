// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import StylesPage from '@/app/dashboard/styles/page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/styles',
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Style Bibles create-error link', () => {
  it('shows a Log in again link when creation fails with a Not logged in error', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url === '/api/styles') {
        return Promise.resolve({ json: () => Promise.resolve({ success: false, error: 'Not logged in' }) });
      }
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: [] }) });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<StylesPage />);

    const input = await screen.findByPlaceholderText('New Style Bible name');
    fireEvent.change(input, { target: { value: 'My Style' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(screen.getByText('Not logged in')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Log in again' })).toBeTruthy();
  });
});
