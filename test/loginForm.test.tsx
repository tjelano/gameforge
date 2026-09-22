// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
});
