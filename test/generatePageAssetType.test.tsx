// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import GeneratePage from '@/app/dashboard/generate/page';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Generate page Asset type field', () => {
  it('renders Asset type as a select, not a free-text input', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, data: [{ id: 's1', name: 'My Style' }] }),
    }));

    render(<GeneratePage />);

    const field = await screen.findByLabelText('Asset type');
    expect(field.tagName).toBe('SELECT');
    expect((field as HTMLSelectElement).value).toBe('sprite');
  });
});
