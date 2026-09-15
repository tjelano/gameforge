'use client';

import { useEffect, useRef, useState } from 'react';
import type { FrameElementInfo } from '@/lib/preview/inspectFrame';

type Selection = FrameElementInfo & { documentHash: string | null };

interface ElementPatchPanelProps {
  patchEndpoint: string; // e.g. `/api/jobs/${jobId}/component/patch-element` or the asset-scoped equivalent
  selection: Selection | null;
  onPatched: () => void; // caller reloads the preview iframe (cache-busting its src)
}

// Keyed on PatchError['code'] (lib/services/componentPatchService.ts). Note: the patch-element
// routes (app/api/jobs/[id]/component/patch-element, app/api/assets/[id]/component/patch-element)
// only send the bare code string for the code-only variants below (COMPONENT_NOT_FOUND,
// ELEMENT_NOT_FOUND, ELEMENT_CHANGED, CONFLICT) — for SANITIZE_REJECTED and WRITE_FAILED they send
// `error.message` (free text) instead, so those two rows only match if a caller ever sends the
// bare code directly; otherwise the free-text message itself is shown, via messageForBodyError's
// fallback below.
const ERROR_MESSAGES: Record<string, string> = {
  COMPONENT_NOT_FOUND: 'This component no longer exists.',
  ELEMENT_NOT_FOUND: 'This element could not be found — it may have changed. Try re-selecting it.',
  ELEMENT_CHANGED: 'The component changed since you selected this element. Please re-select it.',
  SANITIZE_REJECTED: 'The AI\'s response could not be applied safely. Try rephrasing your instruction.',
  CONFLICT: 'Another edit is in progress. Please try again in a moment.',
  WRITE_FAILED: 'Could not save the change. Please try again.',
};

// A plain-object lookup keyed on a server-controlled string is vulnerable to Object.prototype
// collisions: `ERROR_MESSAGES['toString']` resolves to the inherited Object.prototype.toString
// function, not undefined. Passed straight to `setError`, this doesn't even reach render — React's
// setState treats a function argument as a functional updater and CALLS it with the previous
// state, i.e. `Object.prototype.toString(prevError)`; invoked that way (no receiver, strict mode)
// its `this` is undefined, so it returns the string "[object Undefined]" — confirmed empirically
// against the pre-fix code, not assumed — which then renders as a real but nonsensical error
// message, silently, no crash. Object.hasOwn guards it: only a code that was actually put in the
// table above wins the lookup; anything else (including "toString"/"constructor"/"valueOf", or
// ordinary free text from SANITIZE_REJECTED/WRITE_FAILED) falls through to being shown verbatim.
function messageForBodyError(code: string): string {
  if (Object.hasOwn(ERROR_MESSAGES, code)) return ERROR_MESSAGES[code];
  return code || 'Something went wrong applying this patch.';
}

export function ElementPatchPanel({ patchEndpoint, selection, onPatched }: ElementPatchPanelProps) {
  if (!selection) return null;
  // Keyed on the selected element's own id, not on `selection` itself (selection.rect changes on
  // every pointer move even over the same element — keying on the whole object would remount on
  // every hover) — so React fully remounts (rather than re-renders) ElementPatchPanelInner
  // whenever the user selects a different element. Remounting is what resets
  // instruction/error/submitting to their initial values for the new selection: React's own
  // recommended pattern for "reset all state when an identity changes"
  // (react.dev/learn/you-might-not-need-an-effect#resetting-all-state-when-a-prop-changes) — an
  // effect that calls setState synchronously to do the same reset was tried first and rejected: it
  // trips `react-hooks/set-state-in-effect`, and remounting is simpler besides. Remounting also
  // means Inner's own ordinary (dependency-free) unmount cleanup fires exactly when the user
  // selects something else, not just on the panel's final real unmount — so it aborts whatever
  // request belonged to the element being switched away from, with no selection-keyed effect
  // needed for that either.
  return (
    <ElementPatchPanelInner
      key={selection.dataGfId ?? 'unselectable'}
      patchEndpoint={patchEndpoint}
      selection={selection}
      onPatched={onPatched}
    />
  );
}

function ElementPatchPanelInner({
  patchEndpoint,
  selection,
  onPatched,
}: {
  patchEndpoint: string;
  selection: Selection;
  onPatched: () => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const unselectable = selection.dataGfId === null;

  async function handleApply() {
    if (unselectable || !instruction.trim()) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(patchEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataGfId: selection.dataGfId,
          documentHash: selection.documentHash,
          instruction: instruction.trim(),
        }),
        signal: controller.signal,
      });
      // This instance is scoped to one selection (see the key on ElementPatchPanelInner above) —
      // an abort here only ever means "the user clicked Cancel," not "the user selected something
      // else" (that unmounts this whole instance instead). Still worth checking: a stale response
      // must not fire onPatched (a plain prop call, unlike setState, still runs on an unmounted
      // instance and would wrongly tell the caller to reload the preview) after Cancel.
      if (controller.signal.aborted) return;

      let body: { success: boolean; error?: string };
      try {
        body = await res.json();
      } catch {
        // The server responded — this codebase's own routes always send a JSON body, success or
        // error — but not with parseable JSON. A proxy/auth-redirect/infra 500 returning an HTML
        // page is the real case this guards, not "the network is down," so it gets its own
        // message instead of falling into the catch block's network-failure one below.
        setError('The server returned an unexpected response. Please try again.');
        return;
      }
      if (controller.signal.aborted) return;

      if (!body.success) {
        setError(messageForBodyError(body.error ?? ''));
        return;
      }
      setInstruction('');
      onPatched();
    } catch (e) {
      if (controller.signal.aborted || (e instanceof Error && e.name === 'AbortError')) return;
      setError('Could not reach the server.');
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
