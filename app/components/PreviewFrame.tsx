'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  getElementAt,
  getRevisionHash,
  preventFrameAnchorNavigation,
  injectHighlight,
  removeHighlight,
  type FrameElementInfo,
} from '@/lib/preview/inspectFrame';
import { ElementPatchPanel } from '@/app/components/ElementPatchPanel';

interface PreviewFrameProps {
  title: string;
  width: number | string;
  height: number;
  /** Scales the iframe down (card thumbnails). Reset to full size in fullscreen via CSS. */
  scale?: number;
  /** Mutually exclusive with `src` — pass whichever the call site already uses. */
  srcDoc?: string;
  src?: string;
  /** Border/radius on the wrapper — omit for thumbnails whose own outer box already draws one. */
  border?: boolean;
  /** Component and page previews: enables the sandbox relaxation and select-mode toggle. */
  kind?: 'component' | 'page';
  /**
   * Enables the Apply UI once an element is selected. Omit for highlight-only select mode. A
   * function is called with the clicked element's info to resolve the endpoint per click — used by
   * kind="page", where each click can target a different composed component's own asset id.
   */
  patchEndpoint?: string | ((info: FrameElementInfo) => string);
  /**
   * Component previews only: fires on every click, independent of whether select mode is on.
   * Never fires while fullscreen — a consumer of this (e.g. "jump to source" in a sibling
   * textarea) is typically rendered outside this component's own fullscreened wrapper, so it
   * would be invisible there. In practice this means it never fires WHILE a selection is also
   * being made: select mode's own toggle only renders while fullscreen, so the two features are
   * only ever both configured on the same PreviewFrame, never both acting on the same click.
   */
  onElementClick?: (info: FrameElementInfo) => void;
}

const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;
type Breakpoint = (typeof BREAKPOINTS)[number];

// The sandbox attribute is a closed union resolved here, never a free-form string a call site
// assembles — allow-scripts must NEVER be added to either branch. See the design spec's security
// reasoning: sandbox="allow-same-origin" is safe ONLY without allow-scripts (it lets the PARENT
// page's own script read iframe.contentDocument for click-to-select; it does not let the frame's
// own content execute scripts, since that content has no <script> tags surviving the AI-output
// sanitizer in the first place), and the route's CSP (COMPONENT_PREVIEW_CSP) is a required
// invariant of this relaxation.
function resolveSandbox(kind: PreviewFrameProps['kind']): '' | 'allow-same-origin' {
  return kind === 'component' || kind === 'page' ? 'allow-same-origin' : '';
}

// Fullscreens the WRAPPER div, not the iframe. For non-component previews the iframe keeps
// sandbox="" (no scripts, no same-origin) — requestFullscreen is called by this top-level page's
// own script on an element it owns, so it needs no sandbox relaxation. Component previews relax
// to sandbox="allow-same-origin" (via resolveSandbox above) so this component's own select-mode
// code can read iframe.contentDocument through inspectFrame.ts. See globals.css for the
// .preview-frame-wrapper:fullscreen rules that reset the scale-down transform and apply
// per-breakpoint iframe widths.
export function PreviewFrame({ title, width, height, scale, srcDoc, src, border, kind, patchEndpoint, onElementClick }: PreviewFrameProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Read inside the listener rather than closed over at attach time — onElementClick is commonly
  // an unmemoized inline function from the call site, and putting it directly in the effect below
  // would re-run that effect (tearing down and re-attaching) on every render, stacking listeners
  // if a click ever landed between renders. The ref sidesteps that: the effect's own deps stay
  // stable across an identity-only change.
  const onElementClickRef = useRef(onElementClick);
  const isFullscreenRef = useRef(isFullscreen);
  useEffect(() => {
    onElementClickRef.current = onElementClick;
    isFullscreenRef.current = isFullscreen;
  });
  const [breakpoint, setBreakpoint] = useState<Breakpoint>('desktop');
  const [selectMode, setSelectMode] = useState(false);
  const [selection, setSelection] = useState<(FrameElementInfo & { documentHash: string | null }) | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Component and page previews share every piece of the select/highlight/patch machinery below —
  // they differ only in how a click's documentHash is resolved (see handleClick in attachAll) and
  // in what patchEndpoint (Task 6/7 of the workbench plan) resolves to per click.
  const isEditablePreview = kind === 'component' || kind === 'page';

  // `fullscreenchange` fires on `document`, not scoped to one element — many PreviewFrame
  // instances can be mounted at once (e.g. one per page on the style hub), so every instance's
  // listener fires on every fullscreen change anywhere. Check that THIS instance's wrapper is the
  // one that's actually fullscreen before reacting. Leaving fullscreen also resets select mode and
  // any in-progress selection — there's no highlight/patch UI to preserve once the iframe is back
  // to thumbnail size.
  useEffect(() => {
    function handleFullscreenChange() {
      const active = document.fullscreenElement === wrapperRef.current;
      setIsFullscreen(active);
      if (!active) {
        setBreakpoint('desktop');
        setSelectMode(false);
        setSelection(null);
      }
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Re-attached on every frame `load` (not just once) — a component preview's iframe navigates (or
  // reloads, e.g. after a successful patch) while select mode may still be active, and the browser
  // tears down the old contentWindow — and every listener on it, including mousemove/click — on
  // every navigation. The anchor-nav guard and the click/mousemove listeners are attached together
  // here so a reload can never re-arm one without the other.
  //
  // One shared `click` listener serves both select mode and onElementClick — computing
  // getElementAt() once and fanning out — rather than two independent listeners each doing their
  // own hit-test on every click. (The two consumers never actually BOTH act on one click in
  // practice — see onElementClick's own doc comment above — but a call site can still configure
  // both at once, e.g. the edit-component page always does, so the shared hit-test still matters.)
  // `mousemove` (hover highlight) stays select-mode-only: it's a select-mode affordance, not
  // something a plain onElementClick consumer should arm.
  const attachAll = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame) return;
    const cleanupAnchor = isEditablePreview ? preventFrameAnchorNavigation(frame) : undefined;
    // Listeners attach to the frame's own contentWindow, not the parent window — clientX/clientY
    // on an event from a listener on the frame's own window are already relative to the frame's
    // own viewport, which is exactly what getElementAt (lib/preview/inspectFrame.ts) requires.
    function handleMouseMove(e: MouseEvent) {
      const info = getElementAt(frame!, e.clientX, e.clientY);
      if (info) injectHighlight(frame!, info.rect);
      else removeHighlight(frame!);
    }
    function handleClick(e: MouseEvent) {
      const info = getElementAt(frame!, e.clientX, e.clientY);
      if (selectMode) {
        // Page mode composes multiple components into one document -- there is no single
        // page-wide gf-rev meta tag that could mean anything (each component has its own revision).
        // componentRevisionHash (Task 2) is the per-wrapper hash the patch-element endpoint expects
        // instead.
        const documentHash = kind === 'page' ? (info?.componentRevisionHash ?? null) : getRevisionHash(frame!);
        setSelection(info ? { ...info, documentHash } : null);
      }
      // Never while fullscreen: a typical onElementClick consumer (e.g. "jump to source" in a
      // sibling textarea) lives outside this component's own fullscreened wrapper and would be
      // invisible there.
      if (info && onElementClickRef.current && !isFullscreenRef.current) onElementClickRef.current(info);
    }
    if (selectMode) frame.contentWindow?.addEventListener('mousemove', handleMouseMove);
    frame.contentWindow?.addEventListener('click', handleClick);
    return () => {
      cleanupAnchor?.();
      if (selectMode) frame.contentWindow?.removeEventListener('mousemove', handleMouseMove);
      frame.contentWindow?.removeEventListener('click', handleClick);
    };
    // `isEditablePreview` is a pure derivation of `kind` (already listed below), never an
    // independent input — it cannot change without `kind` also changing, so listing it here is
    // purely to satisfy exhaustive-deps and never adds a real re-creation case beyond `kind` alone.
  }, [kind, selectMode, isEditablePreview]);

  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame || !isEditablePreview || !(selectMode || onElementClick)) return;
    let cleanupAll = attachAll();
    function handleLoad() {
      cleanupAll?.();
      cleanupAll = attachAll();
    }
    frame.addEventListener('load', handleLoad);
    return () => {
      cleanupAll?.();
      frame.removeEventListener('load', handleLoad);
      removeHighlight(frame);
    };
    // `onElementClick` intentionally omitted from deps beyond the `!!` check above — its identity
    // is read fresh from onElementClickRef inside the handler, not closed over here. Depending on
    // it directly would tear down and re-attach on every render a call site passes a fresh inline
    // function, stacking listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, selectMode, !!onElementClick, attachAll]);

  function handleFullscreenClick(e: React.MouseEvent) {
    // Defensive on every call site, not just the ones currently wrapped in a <Link> — stops the
    // click from also triggering a wrapping link's navigation.
    e.preventDefault();
    e.stopPropagation();
    wrapperRef.current?.requestFullscreen();
  }

  function handleBreakpointClick(e: React.MouseEvent, bp: Breakpoint) {
    // Same reason as handleFullscreenClick above — AssetCard wraps its whole card (including this
    // toolbar, once fullscreen) in a <Link>. Without this, clicking a breakpoint button bubbles up
    // and navigates away instead of just switching breakpoints.
    e.preventDefault();
    e.stopPropagation();
    setBreakpoint(bp);
  }

  function handleSelectModeToggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setSelectMode((v) => !v);
    setSelection(null);
  }

  function handlePatched() {
    setSelection(null);
    setReloadKey((k) => k + 1);
  }

  // CSS `transform: scale()` on the iframe doesn't shrink its contribution to the WRAPPER's
  // layout size — without an explicit size here, the wrapper lays out at the iframe's full
  // unscaled width/height even though only the scaled-down portion is painted. JobCard's and
  // AssetCard's thumbnail boxes center their content (`align-items: center`) and clip it
  // (`overflow: hidden`), so an oversized wrapper gets vertically centered right out of the
  // visible, clipped area — taking the fullscreen button (positioned near the wrapper's top) with
  // it, making it unreachable by a real click even though it looks fine visually scaled down in a
  // screenshot. Sizing the wrapper to the actually-painted box fixes that.
  const wrapperSizeStyle =
    scale && typeof width === 'number' ? { width: width * scale, height: height * scale } : undefined;

  // Cache-busts the iframe after a successful patch, same query-param pattern edit-component/page.tsx
  // and edit/page.tsx already use (their own `previewVersion` state) — this component's reload is
  // scoped to component-kind patches specifically, so it appends its own key rather than depending
  // on a parent-supplied version.
  const effectiveSrc = isEditablePreview && src ? `${src}&patchV=${reloadKey}` : src;

  return (
    <div
      ref={wrapperRef}
      className="preview-frame-wrapper"
      data-breakpoint={breakpoint}
      style={{
        ...wrapperSizeStyle,
        ...(border ? { border: '1px solid var(--border)', borderRadius: 'var(--radius)' } : undefined),
      }}
    >
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        src={effectiveSrc}
        title={title}
        sandbox={resolveSandbox(kind)}
        style={{
          width,
          height,
          border: 'none',
          display: 'block',
          transform: scale ? `scale(${scale})` : undefined,
          transformOrigin: scale ? 'top left' : undefined,
        }}
      />
      {isFullscreen ? (
        <div className="preview-frame-breakpoint-toolbar">
          {BREAKPOINTS.map((bp) => (
            <button
              key={bp}
              type="button"
              className="preview-frame-breakpoint-btn"
              data-active={breakpoint === bp ? 'true' : 'false'}
              onClick={(e) => handleBreakpointClick(e, bp)}
            >
              {bp[0].toUpperCase() + bp.slice(1)}
            </button>
          ))}
          {isEditablePreview ? (
            <button
              type="button"
              className="preview-frame-breakpoint-btn"
              data-active={selectMode ? 'true' : 'false'}
              onClick={handleSelectModeToggle}
            >
              Select
            </button>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          className="preview-frame-fullscreen-btn"
          title="View fullscreen"
          aria-label="View fullscreen"
          onClick={handleFullscreenClick}
        >
          ⛶
        </button>
      )}
      {isEditablePreview && patchEndpoint && selection ? (
        <ElementPatchPanel
          patchEndpoint={typeof patchEndpoint === 'function' ? patchEndpoint(selection) : patchEndpoint}
          selection={selection}
          onPatched={handlePatched}
        />
      ) : null}
    </div>
  );
}
