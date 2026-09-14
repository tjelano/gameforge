'use client';

import { useRef } from 'react';

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

// Fullscreens the WRAPPER div, not the iframe. The iframe keeps sandbox="" (no scripts,
// no same-origin) — requestFullscreen is called by this top-level page's own script on an
// element it owns, so it needs no sandbox relaxation. See globals.css for the
// .preview-frame-wrapper:fullscreen rules that reset the scale-down transform.
export function PreviewFrame({ title, width, height, scale, srcDoc, src, border }: PreviewFrameProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  function handleFullscreenClick(e: React.MouseEvent) {
    // Defensive on every call site, not just the ones currently wrapped in a <Link> —
    // stops the click from also triggering a wrapping link's navigation.
    e.preventDefault();
    e.stopPropagation();
    wrapperRef.current?.requestFullscreen();
  }

  return (
    <div
      ref={wrapperRef}
      className="preview-frame-wrapper"
      style={border ? { border: '1px solid var(--border)', borderRadius: 'var(--radius)' } : undefined}
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
      <button
        type="button"
        className="preview-frame-fullscreen-btn"
        title="View fullscreen"
        aria-label="View fullscreen"
        onClick={handleFullscreenClick}
      >
        ⛶
      </button>
    </div>
  );
}
