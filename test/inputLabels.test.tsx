// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import StylesPage from '@/app/dashboard/styles/page';
import { LoginForm } from '@/app/login/LoginForm';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/styles',
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Input labeling', () => {
  // getByLabelText, not getByRole('textbox', {name}) -- Testing Library's
  // accessible-name computation falls back to the placeholder attribute for
  // an unlabeled text input, so a getByRole name-match could pass BEFORE
  // the fix (a false-green RED step). getByLabelText specifically requires
  // a real <label> association (htmlFor, aria-labelledby, or wrapping) and
  // does not fall back to placeholder, so it only passes once the label
  // actually exists.
  it('New Style Bible name input has a real label', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, data: [] }) }));
    render(<StylesPage />);
    expect(await screen.findByLabelText('New Style Bible name')).toBeTruthy();
  });

  it('Inspo search input has a real label', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, data: [] }) }));
    render(<StylesPage />);
    expect(await screen.findByLabelText('Inspo search')).toBeTruthy();
  });

  it('LoginForm "Your name" input has a real label', () => {
    render(<LoginForm users={[]} />);
    expect(screen.getByLabelText('Your name')).toBeTruthy();
  });
});
