// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import WebsiteWorkbenchPage from '@/app/dashboard/website/page';

// Defensive, matching the convention in other page-level tests (e.g.
// overviewActivityLinks.test.tsx) -- this page's own <Link> only renders in
// the "no Style Bibles yet" empty state, which neither test below reaches,
// but a real app-router invariant crash from an unmocked <Link> is cheap to
// rule out up front.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/website',
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const STYLE_A = { id: 'style-a', name: 'Style A' };
const STYLE_B = { id: 'style-b', name: 'Style B' };
const PAGE_A = { id: 'page-a', style_id: 'style-a', name: 'Page A', component_asset_ids: '[]' };
const COMPONENT_ASSET = {
  id: 'comp-1',
  style_id: 'style-a',
  asset_type: 'Button',
  prompt: 'Primary CTA button',
  output_kind: 'component',
};

function jsonResponse(body: unknown) {
  return Promise.resolve({ json: () => Promise.resolve(body) });
}

describe('Website Workbench page - stale page list after switching Style Bibles', () => {
  it('clears the previous Style Bible\'s pages immediately on switch, before the new style\'s own pages have loaded', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url === '/api/styles') return jsonResponse({ success: true, data: [STYLE_A, STYLE_B] });
      if (url === '/api/jobs/active') return jsonResponse({ success: true, data: [] });
      if (url === '/api/settings/ollama/models') return jsonResponse({ success: true, data: { models: [], host: '' } });
      if (url === '/api/styles/style-a/pages') return jsonResponse({ success: true, data: [PAGE_A] });
      if (url === '/api/styles/style-a/assets') return jsonResponse({ success: true, data: [] });
      // Style B's own pages fetch deliberately never resolves during this test --
      // this is the window during which stale Style A data must not be shown.
      if (url === '/api/styles/style-b/pages') return new Promise(() => {});
      if (url === '/api/styles/style-b/assets') return jsonResponse({ success: true, data: [] });
      return jsonResponse({ success: false, error: `unexpected URL in test: ${method} ${url}` });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<WebsiteWorkbenchPage />);

    const pageAButton = await screen.findByRole('button', { name: 'Page A' });
    fireEvent.click(pageAButton);

    const styleSelect = screen.getByLabelText('Style Bible');
    fireEvent.change(styleSelect, { target: { value: 'style-b' } });

    // Style B's pages fetch is still pending (see mock above) -- Page A belongs
    // to Style A and must not still be visible/clickable under Style B.
    expect(screen.queryByRole('button', { name: 'Page A' })).toBeNull();
    expect(screen.getByText('No pages yet for this Style Bible.')).toBeTruthy();
  });
});

describe('Website Workbench page - component selection kept after a failed order save', () => {
  it('keeps the create-page form open (selections intact) when the page is created but saving its component order fails', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url === '/api/styles') return jsonResponse({ success: true, data: [STYLE_A] });
      if (url === '/api/jobs/active') return jsonResponse({ success: true, data: [] });
      if (url === '/api/settings/ollama/models') return jsonResponse({ success: true, data: { models: [], host: '' } });
      if (url === '/api/styles/style-a/assets') return jsonResponse({ success: true, data: [COMPONENT_ASSET] });
      if (url === '/api/styles/style-a/pages' && method === 'GET') return jsonResponse({ success: true, data: [] });
      if (url === '/api/styles/style-a/pages' && method === 'POST') {
        return jsonResponse({ success: true, data: { id: 'new-page-id', style_id: 'style-a', name: 'My New Page', component_asset_ids: '[]' } });
      }
      if (url === '/api/pages/new-page-id' && method === 'PUT') {
        return jsonResponse({ success: false, error: 'Order save failed' });
      }
      return jsonResponse({ success: false, error: `unexpected URL in test: ${method} ${url}` });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<WebsiteWorkbenchPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'New Page' }));

    // Waits for the assets fetch to resolve and flow into the already-mounted
    // PageEditor's availableComponents prop.
    const addButton = await screen.findByRole('button', { name: 'Add' });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My New Page' } });
    fireEvent.click(addButton);
    fireEvent.click(screen.getByRole('button', { name: 'Create Page' }));

    await waitFor(() => expect(screen.getByText('Order save failed')).toBeTruthy());

    // The page was technically created, but the order save failed -- the
    // create form must stay open with the user's entered data intact, not
    // silently switch away to the (empty) new page.
    expect(screen.getByRole('button', { name: 'Create Page' })).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('My New Page');
  });
});
