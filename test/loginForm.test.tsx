// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { LoginForm } from '@/app/login/LoginForm';

let currentSearch = '';

// Next's real useRouter() returns a referentially stable object across
// renders -- a mock that returns a new object on every call would be less
// faithful than the real thing (see the same fix in useCurrentUser.test.tsx).
const pushMock = vi.fn();
const refreshMock = vi.fn();
const routerMock = { push: pushMock, refresh: refreshMock };

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  currentSearch = '';
  pushMock.mockClear();
  refreshMock.mockClear();
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

  it('closes the add-account panel after a successful pull, instead of leaving the create form open', async () => {
    currentSearch = '';
    const fetchMock = vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<LoginForm users={[{ id: 'u1', name: 'Alice' }]} />);

    fireEvent.click(screen.getByRole('button', { name: '+ Add another account' }));
    expect(screen.getByPlaceholderText('Your name')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /pull from git first/i }));

    await waitFor(() => expect(screen.queryByPlaceholderText('Your name')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
  });
});
