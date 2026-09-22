// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import PresetsPage from '@/app/dashboard/presets/page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Apply-preset modal accessibility', () => {
  it('has dialog semantics and closes on Escape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        success: true,
        data: [{ id: 'p1', name: 'My Preset', tech_stack_tags: '[]', theme_prompt: null, components: '[]' }],
      }),
    }));

    render(<PresetsPage />);

    const applyButton = await screen.findByRole('button', { name: 'Apply' });
    fireEvent.click(applyButton);

    const dialog = screen.getByRole('dialog', { name: 'Apply preset' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
