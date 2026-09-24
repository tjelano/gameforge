// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ExportPage from '@/app/dashboard/export/page';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Export page empty state', () => {
  it('shows an empty-state message instead of the form when there are no Style Bibles', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: () => Promise.resolve({ success: true, data: [] }) }));

    render(<ExportPage />);

    expect(await screen.findByText(/no style bibles yet/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Export to Godot' })).toBeNull();
  });
});
