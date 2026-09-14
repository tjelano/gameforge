'use client';

import { useEffect, useRef, useState } from 'react';

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
}

const BREAKPOINTS = ['mobile', 'tablet', 'desktop'] as const;
type Breakpoint = (typeof BREAKPOINTS)[number];

// Fullscreens the WRAPPER div, not the iframe. The iframe keeps sandbox="" (no scripts,
// no same-origin) — requestFullscreen is called by this top-level page's own script on an
// element it owns, so it needs no sandbox relaxation. See globals.css for the
// .preview-frame-wrapper:fullscreen rules that reset the scale-down transform and apply
// per-breakpoint iframe widths.
export function PreviewFrame({ title, width, height, scale, srcDoc, src, border }: PreviewFrameProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [breakpoint, setBreakpoint] = useState<Breakpoint>('desktop');

  // `fullscreenchange` fires on `document`, not scoped to one element — many PreviewFrame
  // instances can be mounted at once (e.g. one per page on the style hub), so every
  // instance's listener fires on every fullscreen change anywhere. Check that THIS
  // instance's wrapper is the one that's actually fullscreen before reacting.
  useEffect(() => {
    function handleFullscreenChange() {
      const active = document.fullscreenElement === wrapperRef.current;
      setIsFullscreen(active);
      if (!active) setBreakpoint('desktop');
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  function handleFullscreenClick(e: React.MouseEvent) {
    // Defensive on every call site, not just the ones currently wrapped in a <Link> —
    // stops the click from also triggering a wrapping link's navigation.
    e.preventDefault();
    e.stopPropagation();
    wrapperRef.current?.requestFullscreen();
  }

  function handleBreakpointClick(e: React.MouseEvent, bp: Breakpoint) {
    // Same reason as handleFullscreenClick above — AssetCard wraps its whole card (including
    // this toolbar, once fullscreen) in a <Link>. Without this, clicking a breakpoint button
    // bubbles up and navigates away instead of just switching breakpoints.
    e.preventDefault();
    e.stopPropagation();
    setBreakpoint(bp);
  }

  // CSS `transform: scale()` on the iframe doesn't shrink its contribution to the WRAPPER's
  // layout size — without an explicit size here, the wrapper lays out at the iframe's full
  // unscaled width/height even though only the scaled-down portion is painted. JobCard's and
  // AssetCard's thumbnail boxes center their content (`align-items: center`) and clip it
  // (`overflow: hidden`), so an oversized wrapper gets vertically centered right out of the
  // visible, clipped area — taking the fullscreen button (positioned near the wrapper's top)
  // with it, making it unreachable by a real click even though it looks fine visually scaled
  // down in a screenshot. Sizing the wrapper to the actually-painted box fixes that.
  const wrapperSizeStyle =
    scale && typeof width === 'number' ? { width: width * scale, height: height * scale } : undefined;

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
        srcDoc={srcDoc}
        src={src}
        title={title}
        sandbox=""
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
    </div>
  );
}
