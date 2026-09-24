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
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancelButton);

    fireEvent.keyDown(cancelButton, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(applyButton);
  });

  it('traps Tab focus within the dialog instead of escaping to the page behind it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        success: true,
        data: [{ id: 'p1', name: 'My Preset', tech_stack_tags: '[]', theme_prompt: null, components: '[]' }],
      }),
    }));

    render(<PresetsPage />);

    const applyButton = await screen.findByRole('button', { name: 'Apply' });
    fireEvent.click(applyButton);

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    const nameInput = screen.getByPlaceholderText('New Style Bible name');
    expect(document.activeElement).toBe(cancelButton);

    // Shift+Tab from the first focusable element wraps to the last
    // (the Apply button is disabled while the name field is empty, so the
    // name input is the real last stop, matching native disabled-button
    // tab-order behavior).
    fireEvent.keyDown(cancelButton, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(nameInput);

    // Tab from the last focusable element wraps back to the first.
    fireEvent.keyDown(nameInput, { key: 'Tab' });
    expect(document.activeElement).toBe(cancelButton);
  });
});
