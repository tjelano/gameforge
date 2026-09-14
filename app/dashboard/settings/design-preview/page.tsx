'use client';

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  COLOR_TOKENS,
  FONT_TOKENS,
  FONT_OPTIONS,
  DEFAULT_RADIUS,
  isValidHex,
  parseRadiusPx,
  formatRadiusPx,
  serializeTokensToCss,
  type ColorTokenKey,
  type FontTokenKey,
  type DesignPreviewTokenState,
} from '@/lib/utils/designPreviewTokens';

function buildDefaultState(): DesignPreviewTokenState {
  const state = {} as DesignPreviewTokenState;
  for (const t of COLOR_TOKENS) state[t.key] = '';
  state.radius = String(DEFAULT_RADIUS);
  for (const t of FONT_TOKENS) state[t.key] = t.defaultValue;
  return state;
}

// Always reads document.documentElement's REAL, un-edited computed style -- never the preview
// wrapper div's. The preview's own edits only ever touch React state and that one wrapper div's
// inline style; they never write back to document.documentElement, so this function is immune to
// however many edits the operator has made in the form. That's what makes "Reset to current" below
// restore the real globals.css values, not whatever was last edited in the form.
function readLiveTokens(prev: DesignPreviewTokenState): DesignPreviewTokenState {
  const cs = getComputedStyle(document.documentElement);
  const next = { ...prev };
  for (const t of COLOR_TOKENS) {
    const value = cs.getPropertyValue(t.cssVar).trim();
    if (value) next[t.key] = value;
  }
  next.radius = String(parseRadiusPx(cs.getPropertyValue('--radius')));
  return next;
}

export default function DesignPreviewPage() {
  const [tokens, setTokens] = useState<DesignPreviewTokenState>(buildDefaultState);
  const [copied, setCopied] = useState(false);
  const [clipboardUnavailable, setClipboardUnavailable] = useState(false);
  const fallbackTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // One-time read of the DOM's real computed style on mount to seed form state from
    // globals.css's live values -- an external-system sync, not an ongoing subscription, so
    // there's no render-time or event-handler alternative.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTokens(prev => readLiveTokens(prev));
  }, []);

  useEffect(() => {
    if (clipboardUnavailable) fallbackTextareaRef.current?.focus();
  }, [clipboardUnavailable]);

  function handleReset() {
    setTokens(() => readLiveTokens(buildDefaultState()));
  }

  function setColor(key: ColorTokenKey, value: string) {
    setTokens(prev => ({ ...prev, [key]: value }));
  }

  function setFont(key: FontTokenKey, value: string) {
    setTokens(prev => ({ ...prev, [key]: value }));
  }

  async function handleCopy() {
    const css = serializeTokensToCss(tokens);
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(css);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        return;
      } catch {
        // Clipboard exists but the write itself failed (permissions, etc.) -- fall through.
      }
    }
    setClipboardUnavailable(true);
  }

  const cssText = serializeTokensToCss(tokens);
  const mockupStyle = {
    '--bg': tokens.bg,
    '--surface': tokens.surface,
    '--surface-raised': tokens.surfaceRaised,
    '--border': tokens.border,
    '--ink': tokens.ink,
    '--ink-dim': tokens.inkDim,
    '--ink-faint': tokens.inkFaint,
    '--accent': tokens.accent,
    '--accent-bright': tokens.accentBright,
    '--accent-dim': tokens.accentDim,
    '--accent-2': tokens.accent2,
    '--accent-ink': tokens.accentInk,
    '--keeper': tokens.keeper,
    '--keeper-dim': tokens.keeperDim,
    '--reject': tokens.reject,
    '--reject-dim': tokens.rejectDim,
    '--radius': formatRadiusPx(tokens.radius),
    '--font-display': tokens.fontDisplay,
    '--font-body': tokens.fontBody,
    '--font-mono': tokens.fontMono,
  } as CSSProperties;

  return (
    <>
      <h1 className="page-title">Design Preview</h1>
      <p className="page-subtitle">
        Live-edit GameForge&apos;s own color and font tokens and see them rendered against real
        dashboard components. Nothing here is saved — copy the CSS below and paste it into
        app/globals.css yourself when you land on something you like.
      </p>

      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 320px', minWidth: 280 }}>
          <h2 className="frame-label" style={{ marginBottom: 12 }}>Colors</h2>
          {COLOR_TOKENS.map(t => (
            <div key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <input
                type="color"
                aria-label={t.label}
                value={isValidHex(tokens[t.key]) ? tokens[t.key] : '#000000'}
                onChange={e => setColor(t.key, e.target.value)}
              />
              <input
                key={tokens[t.key]}
                type="text"
                aria-label={`${t.label} (hex)`}
                defaultValue={tokens[t.key]}
                onBlur={e => { if (isValidHex(e.target.value)) setColor(t.key, e.target.value); }}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                style={{ width: 90 }}
              />
              <span style={{ fontSize: 12, color: 'var(--ink-dim)' }}>{t.label}</span>
            </div>
          ))}

          <h2 className="frame-label" style={{ marginTop: 24, marginBottom: 12 }}>Shape</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <input
              type="number"
              aria-label="Radius (px)"
              value={tokens.radius}
              onChange={e => setTokens(prev => ({ ...prev, radius: e.target.value }))}
              onBlur={() => setTokens(prev => ({ ...prev, radius: String(parseRadiusPx(prev.radius)) }))}
              style={{ width: 90 }}
            />
            <span style={{ fontSize: 12, color: 'var(--ink-dim)' }}>Radius (px)</span>
          </div>

          <h2 className="frame-label" style={{ marginTop: 24, marginBottom: 12 }}>Typography</h2>
          {FONT_TOKENS.map(t => (
            <div key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <select aria-label={t.label} value={tokens[t.key]} onChange={e => setFont(t.key, e.target.value)}>
                {FONT_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <span style={{ fontSize: 12, color: 'var(--ink-dim)' }}>{t.label}</span>
            </div>
          ))}

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={handleCopy}>
              {copied ? 'Copied!' : 'Copy CSS'}
            </button>
            <button className="btn" onClick={handleReset}>
              Reset to current
            </button>
          </div>

          {clipboardUnavailable && (
            <div style={{ marginTop: 12 }}>
              <p className="page-subtitle" style={{ margin: '0 0 6px 0' }}>
                Clipboard access isn&apos;t available over this connection — select the text below and
                copy it manually:
              </p>
              <textarea
                ref={fallbackTextareaRef}
                readOnly
                value={cssText}
                onFocus={e => e.target.select()}
                style={{ width: '100%', height: 160, fontFamily: 'var(--font-mono)', fontSize: 12 }}
              />
            </div>
          )}
        </div>

        <div
          className="card"
          style={{ flex: '1 1 360px', minWidth: 300, ...mockupStyle } as CSSProperties}
        >
          <div style={{ background: 'var(--bg)', padding: 20, borderRadius: 'var(--radius)' }}>
            <div
              style={{
                display: 'flex',
                gap: 16,
                alignItems: 'center',
                marginBottom: 16,
                paddingBottom: 12,
                borderBottom: '1px solid var(--border)',
              }}
            >
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--ink)' }}>
                Game<span style={{ color: 'var(--accent)' }}>Forge</span>
              </div>
              <a className="rail-link" data-active="true" href="#" onClick={e => e.preventDefault()} style={{ padding: '4px 10px' }}>
                Overview
              </a>
              <a className="rail-link" href="#" onClick={e => e.preventDefault()} style={{ padding: '4px 10px' }}>
                Generate
              </a>
            </div>

            <h1 className="page-title" style={{ fontSize: 22 }}>Preview heading</h1>
            <p className="page-subtitle">A sample paragraph, styled by the tokens on the left.</p>

            <div className="card" style={{ marginBottom: 16 }}>
              <div className="stat-card-label">Active styles</div>
              <div className="stat-card-value">12</div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
              <button className="btn btn-primary">Primary</button>
              <button className="btn btn-keeper">Keeper</button>
              <button className="btn btn-reject">Reject</button>
              <button className="btn">Default</button>
            </div>

            <a className="settings-item" href="#" onClick={e => e.preventDefault()} style={{ marginBottom: 16 }}>
              <div>
                <div>Example setting</div>
                <div className="settings-item-desc">A description line, for contrast.</div>
              </div>
              <span style={{ color: 'var(--ink-faint)' }}>&rarr;</span>
            </a>

            <div className="activity-row">
              <div>Promoted &quot;a sample asset&quot;</div>
              <div className="activity-row-meta">just now</div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
