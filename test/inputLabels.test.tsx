// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { Suspense } from 'react';
import StylesPage from '@/app/dashboard/styles/page';
import { LoginForm } from '@/app/login/LoginForm';
import AssetDetailPage from '@/app/dashboard/assets/[id]/page';
import type { Asset } from '@/lib/database/schema';

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
    // Pins the specific element, not just "some element matched the text" -- a
    // bare truthy check would silently start passing against the WRONG input
    // again if another real label with this same text ever reappears on the
    // page (exactly the collision that had to be fixed for this test to be
    // meaningful in the first place; see the "Imported Style Bible name" rename
    // in app/dashboard/styles/page.tsx).
    // getAttribute + toBe, not the jest-dom toHaveAttribute matcher -- this
    // codebase doesn't have @testing-library/jest-dom installed/registered
    // (confirmed: toHaveAttribute throws "Invalid Chai property" here), so
    // this matches the plain-Chai style already used elsewhere (e.g.
    // stylesPageCreateError.test.tsx's link.getAttribute('href')).
    const input = await screen.findByLabelText('New Style Bible name');
    expect(input.getAttribute('id')).toBe('newStyleName');
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

  it('New state name input has a real label', async () => {
    const id = 'asset1';
    // output_kind: 'image' keeps this to the one unconditional mount fetch
    // (GET /api/assets/:id) -- the contrast and used-by effects are gated on
    // output_kind === 'theme' / 'component' respectively, so they never fire
    // for this fixture. The catch-all default below is still here in case
    // that ever changes, rather than enumerating every possible endpoint.
    const assetFixture: Asset = {
      id,
      style_id: 'style1',
      created_by: 'user1',
      asset_type: 'sprite',
      prompt: 'A test asset',
      image_path: 'asset1.png',
      created_at: 0,
      is_deleted: 0,
      source_job_id: null,
      nine_slice_margins: null,
      states: '[]',
      output_kind: 'image',
      edited_externally: 0,
    };
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === `/api/assets/${id}`) {
        return Promise.resolve({ json: () => Promise.resolve({ success: true, data: assetFixture }) });
      }
      return Promise.resolve({ json: () => Promise.resolve({ success: true, data: null }) });
    }));

    // `use(params)` suspends on mount -- same shape as the edit pages' own
    // tests (see editThemePage.test.tsx): a Suspense boundary is provided
    // here (production gets one for free from Next's router), and the
    // initial render is awaited inside `act` so the retry once the params
    // promise settles is flushed before the findByLabelText below runs.
    await act(async () => {
      render(
        <Suspense fallback={null}>
          <AssetDetailPage params={Promise.resolve({ id })} />
        </Suspense>
      );
    });

    const input = await screen.findByLabelText('New state name');
    expect(input.getAttribute('id')).toBe('newStateName');
  });
});
