// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { LoginForm } from '@/app/login/LoginForm';

let currentSearch = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  currentSearch = '';
});

describe('LoginForm expired-session banner', () => {
  it('shows the expired banner when ?reason=expired is present and accounts exist', () => {
    currentSearch = 'reason=expired';
    render(<LoginForm users={[{ id: 'u1', name: 'Alice' }]} />);
    expect(screen.getByText(/your session expired/i)).toBeTruthy();
  });

  it('does not show the expired banner when reason=expired is absent', () => {
    currentSearch = '';
    render(<LoginForm users={[{ id: 'u1', name: 'Alice' }]} />);
    expect(screen.queryByText(/your session expired/i)).toBeNull();
  });
});

describe('LoginForm add-account flow', () => {
  it('reveals an add-account form when "+ Add another account" is clicked, and force:true is sent', async () => {
    currentSearch = ''; // explicit, not relying on afterEach's reset -- this test needs
    // expired === false so the button it clicks actually renders (see this file's mock above).
    const fetchMock = vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, data: { id: 'u2', name: 'Bob', isAdmin: false } }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<LoginForm users={[{ id: 'u1', name: 'Alice' }]} />);

    fireEvent.click(screen.getByRole('button', { name: '+ Add another account' }));
    const input = screen.getByPlaceholderText('Your name');
    fireEvent.change(input, { target: { value: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      body: JSON.stringify({ name: 'Bob', force: true }),
    })));
  });
});
