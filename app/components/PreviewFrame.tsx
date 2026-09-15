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
  /** Component previews only: enables the sandbox relaxation and select-mode toggle. */
  kind?: 'component';
  /** Enables the Apply UI once an element is selected. Omit for highlight-only select mode. */
  patchEndpoint?: string;
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
  return kind === 'component' ? 'allow-same-origin' : '';
}

// Fullscreens the WRAPPER div, not the iframe. For non-component previews the iframe keeps
// sandbox="" (no scripts, no same-origin) — requestFullscreen is called by this top-level page's
// own script on an element it owns, so it needs no sandbox relaxation. Component previews relax
// to sandbox="allow-same-origin" (via resolveSandbox above) so this component's own select-mode
// code can read iframe.contentDocument through inspectFrame.ts. See globals.css for the
// .preview-frame-wrapper:fullscreen rules that reset the scale-down transform and apply
// per-breakpoint iframe widths.
export function PreviewFrame({ title, width, height, scale, srcDoc, src, border, kind, patchEndpoint }: PreviewFrameProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [breakpoint, setBreakpoint] = useState<Breakpoint>('desktop');
  const [selectMode, setSelectMode] = useState(false);
  const [selection, setSelection] = useState<(FrameElementInfo & { documentHash: string | null }) | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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

  // Re-attached on every frame `load` (not just once) — a component preview's iframe navigates
  // (or reloads, e.g. after a successful patch) while select mode may still be active, and a fresh
  // document needs its own listener.
  const attachFrameGuards = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame || kind !== 'component') return;
    return preventFrameAnchorNavigation(frame);
  }, [kind]);

  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame || !selectMode) return;
    let cleanupAnchor = attachFrameGuards();
    function handleLoad() {
      cleanupAnchor?.();
      cleanupAnchor = attachFrameGuards();
    }
    frame.addEventListener('load', handleLoad);
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
      const documentHash = getRevisionHash(frame!);
      setSelection(info ? { ...info, documentHash } : null);
    }
    frame.contentWindow?.addEventListener('mousemove', handleMouseMove);
    frame.contentWindow?.addEventListener('click', handleClick);
    return () => {
      cleanupAnchor?.();
      frame.removeEventListener('load', handleLoad);
      frame.contentWindow?.removeEventListener('mousemove', handleMouseMove);
      frame.contentWindow?.removeEventListener('click', handleClick);
      removeHighlight(frame);
    };
  }, [selectMode, attachFrameGuards]);

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
  const effectiveSrc = kind === 'component' && src ? `${src}&patchV=${reloadKey}` : src;

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
          {kind === 'component' ? (
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
      {kind === 'component' && patchEndpoint && selection ? (
        <ElementPatchPanel patchEndpoint={patchEndpoint} selection={selection} onPatched={handlePatched} />
      ) : null}
    </div>
  );
}
