// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import OverviewPage from '@/app/dashboard/page';

// OverviewPage renders next/link's <Link> (Quick Actions, and now the
// activity rows this task adds) -- under jsdom that needs a router context
// or it throws "invariant expected app router to be mounted," same as
// Tasks 2 and 9's mocks for pages containing <Link>.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Overview activity row links', () => {
  it('links a job-kind activity row to /dashboard/jobs and a style-kind row to its style detail page', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/dashboard/activity') {
        return Promise.resolve({ json: () => Promise.resolve({
          success: true,
          data: [
            { id: 'job1', kind: 'job', label: 'Generation failed: "Button"', timestamp: 1 },
            { id: 'style1', kind: 'style', label: 'Created Style Bible "ecologi-com"', timestamp: 2 },
          ],
        }) });
      }
      // Covers both /api/context and /api/dashboard/worker-status with one
      // shape that satisfies both consumers -- context?.styles.length (etc.)
      // in the real component would throw on {} here, since {}.styles is
      // undefined; this must be a realistic ProjectContextSummary-shaped
      // object, not an empty one.
      return Promise.resolve({ json: () => Promise.resolve({
        success: true,
        data: { styles: [], totalActiveAssets: 0, inFlightJobs: 0, alive: false },
      }) });
    }));

    render(<OverviewPage />);

    const jobLink = await screen.findByRole('link', { name: /generation failed/i });
    expect(jobLink.getAttribute('href')).toBe('/dashboard/jobs');

    const styleLink = screen.getByRole('link', { name: /created style bible/i });
    expect(styleLink.getAttribute('href')).toBe('/dashboard/styles/style1');
  });
});
