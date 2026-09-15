'use client';

import { useEffect, useRef, useState } from 'react';
import type { FrameElementInfo } from '@/lib/preview/inspectFrame';

interface ElementPatchPanelProps {
  patchEndpoint: string; // e.g. `/api/jobs/${jobId}/component/patch-element` or the asset-scoped equivalent
  selection: (FrameElementInfo & { documentHash: string | null }) | null;
  onPatched: () => void; // caller reloads the preview iframe (cache-busting its src)
}

// Keyed on PatchError['code'] (lib/services/componentPatchService.ts). Note: the patch-element
// routes (app/api/jobs/[id]/component/patch-element, app/api/assets/[id]/component/patch-element)
// only send the bare code string for the code-only variants below (COMPONENT_NOT_FOUND,
// ELEMENT_NOT_FOUND, ELEMENT_CHANGED, CONFLICT) — for SANITIZE_REJECTED and WRITE_FAILED they send
// `error.message` (free text) instead, so those two rows only match if a caller ever sends the
// bare code directly; otherwise the free-text message itself is shown via the fallback below.
const ERROR_MESSAGES: Record<string, string> = {
  COMPONENT_NOT_FOUND: 'This component no longer exists.',
  ELEMENT_NOT_FOUND: 'This element could not be found — it may have changed. Try re-selecting it.',
  ELEMENT_CHANGED: 'The component changed since you selected this element. Please re-select it.',
  SANITIZE_REJECTED: 'The AI\'s response could not be applied safely. Try rephrasing your instruction.',
  CONFLICT: 'Another edit is in progress. Please try again in a moment.',
  WRITE_FAILED: 'Could not save the change. Please try again.',
};

export function ElementPatchPanel({ patchEndpoint, selection, onPatched }: ElementPatchPanelProps) {
  const [instruction, setInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Hooks must run unconditionally every render (the early return below is conditional on
  // `selection`, which can flip between null/non-null while this component stays mounted across
  // re-renders) — so this effect is declared above that return, not inside a branch. Aborts any
  // in-flight patch request if the panel unmounts (or the selection changes away) mid-request,
  // rather than leaving a dangling fetch whose eventual response tries to update state nobody
  // will read.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  if (!selection) return null;

  const unselectable = selection.dataGfId === null;

  async function handleApply() {
    if (!selection || unselectable || !instruction.trim()) return;
    setSubmitting(true);
    setError(null);
    abortRef.current = new AbortController();
    try {
      const res = await fetch(patchEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataGfId: selection.dataGfId,
          documentHash: selection.documentHash,
          instruction,
        }),
        signal: abortRef.current.signal,
      });
      const body = await res.json();
      if (!body.success) {
        setError(ERROR_MESSAGES[body.error] ?? body.error ?? 'Something went wrong applying this patch.');
        return;
      }
      setInstruction('');
      onPatched();
    } catch (e) {
      if (!(e instanceof Error) || e.name !== 'AbortError') setError('Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  return (
    <div className="element-patch-panel">
      <div className="element-patch-panel-target">
        Selected: <code>{selection.tagName}</code>
        {selection.classes.length ? <code>.{selection.classes.join('.')}</code> : null}
      </div>
      {unselectable ? (
        <div className="element-patch-panel-disabled">
          Hand-edited content — use full regeneration to change this.
        </div>
      ) : null}
      {/* The brief's prose says "Disables Apply... when dataGfId is null" — Apply stays mounted
          and disabled rather than unmounting along with the rest of the form, so it's always
          discoverable (and so the `unselectable` case doesn't need a second, button-less layout). */}
      <textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="Describe the change..."
        disabled={submitting || unselectable}
      />
      {error ? <div className="element-patch-panel-error">{error}</div> : null}
      <div className="element-patch-panel-actions">
        <button type="button" onClick={handleApply} disabled={unselectable || submitting || !instruction.trim()}>
          {submitting ? 'Applying…' : 'Apply'}
        </button>
        {submitting ? (
          <button type="button" onClick={handleCancel}>Cancel</button>
        ) : null}
      </div>
    </div>
  );
}
