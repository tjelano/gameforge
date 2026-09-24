const FOCUSABLE_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab/Shift+Tab cycling within `container` instead of escaping to
 * background page controls -- required for an `aria-modal="true"` dialog to
 * actually behave as modal to keyboard users. Call from a Tab keydown
 * handler; queries focusables live so it stays correct as dialog content
 * changes (e.g. a nested folder browser re-rendering its own controls).
 *
 * Only wraps at the first/last focusable element -- relies on the caller
 * seeding initial focus inside `container` when the dialog opens (both
 * current call sites do). If a future caller doesn't, focus starting
 * outside `container` won't get pulled in.
 */
export function trapTabFocus(e: KeyboardEvent, container: HTMLElement): void {
  if (e.key !== 'Tab') return;
  const focusables = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
