'use client';

import { useState } from 'react';
import { useStyles } from '@/lib/hooks/useStyles';
import { usePolling } from '@/lib/hooks/usePolling';
import { useJobStore } from '@/lib/store/useJobStore';
import { JobCard } from '@/app/components/JobCard';
import { useDraggableBoxes, boxKeyboardDelta } from '@/lib/hooks/useDraggableBoxes';
import { StyleBiblePicker } from '@/app/components/StyleBiblePicker';
import {
  PIECE_PRESETS,
  OUTPUT_SIZE_PRESETS,
  MAX_PIECES_PER_SHEET,
  boxesSignificantlyOverlap,
  type PlacedPiece,
} from '@/lib/utils/pieceShapes';

const CANVAS_LONG_SIDE = 512;

export default function UiSheetsPage() {
  const { styles, loading: stylesLoading, error: stylesError } = useStyles();
  const jobs = useJobStore(s => s.jobs).filter(j => j.asset_type === 'ui_sheet');
  const refreshActive = useJobStore(s => s.refreshActive);
  const jobsError = useJobStore(s => s.error);
  usePolling(refreshActive, 2000);

  const [styleId, setStyleId] = useState('');
  const [description, setDescription] = useState('');
  const [colorPalette, setColorPalette] = useState('');
  const [outputSizeIndex, setOutputSizeIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { boxes, addBox, updateBox, removeBox, startDrag } = useDraggableBoxes<PlacedPiece>([]);

  const activeStyleId = styleId || styles[0]?.id || '';
  const outputSize = OUTPUT_SIZE_PRESETS[outputSizeIndex];
  const canvasWidth = outputSize.width >= outputSize.height ? CANVAS_LONG_SIDE : (outputSize.width / outputSize.height) * CANVAS_LONG_SIDE;
  const canvasHeight = outputSize.height >= outputSize.width ? CANVAS_LONG_SIDE : (outputSize.height / outputSize.width) * CANVAS_LONG_SIDE;

  function handleAddPreset(preset: typeof PIECE_PRESETS[number]) {
    if (boxes.length >= MAX_PIECES_PER_SHEET) return;
    addBox({
      id: crypto.randomUUID(),
      kind: preset.kind,
      label: '',
      x: 20,
      y: 20,
      w: preset.defaultW,
      h: preset.defaultH,
      sides: preset.sides,
    });
  }

  const hasOverlap = boxes.some((a, i) => boxes.some((b, j) => i < j && boxesSignificantlyOverlap(a, b)));

  async function handleSubmit() {
    if (!activeStyleId || !description.trim() || boxes.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          styleId: activeStyleId,
          assetType: 'ui_sheet',
          prompt: description.trim(),
          options: {
            pieces: boxes,
            imageSize: { width: outputSize.width, height: outputSize.height },
            colorPalette: colorPalette.trim() || undefined,
          },
        }),
      });
      const body = await res.json();
      if (!body.success) {
        setError(body.error ?? 'Generation failed to queue.');
      } else {
        setDescription('');
        refreshActive();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <h1 className="page-title">UI Sheets</h1>
      <p className="page-subtitle">
        Place named pieces on the canvas, then generate one composite sheet from the whole layout.
      </p>

      {stylesError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{stylesError}</p>}

      {!stylesLoading && !stylesError && styles.length === 0 ? (
        <div className="empty-state">
          No Style Bibles yet. Create one on the <strong>Style Bibles</strong> page first.
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 20, maxWidth: 480 }}>
            <StyleBiblePicker styles={styles} value={activeStyleId} onChange={setStyleId} />

            <div className="field">
              <label htmlFor="description">Description</label>
              <textarea
                id="description"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="medieval fantasy RPG UI kit, aged parchment and iron"
              />
            </div>

            <div className="field">
              <label htmlFor="colorPalette">Color palette (optional)</label>
              <input id="colorPalette" value={colorPalette} onChange={e => setColorPalette(e.target.value)} placeholder="brown and gold" />
            </div>

            <div className="field">
              <label htmlFor="outputSize">Output size</label>
              <select id="outputSize" value={outputSizeIndex} onChange={e => setOutputSizeIndex(Number(e.target.value))}>
                {OUTPUT_SIZE_PRESETS.map((preset, i) => (
                  <option key={preset.label} value={i}>{preset.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {PIECE_PRESETS.map(preset => (
              <button key={preset.name} className="btn" onClick={() => handleAddPreset(preset)} disabled={boxes.length >= MAX_PIECES_PER_SHEET}>
                + {preset.name}
              </button>
            ))}
          </div>

          {boxes.length >= MAX_PIECES_PER_SHEET && (
            <p style={{ fontSize: 13, color: 'var(--ink-dim)', marginBottom: 8 }}>
              Sheet is full ({MAX_PIECES_PER_SHEET} pieces max).
            </p>
          )}
          {hasOverlap && (
            <p style={{ fontSize: 13, color: 'var(--accent)', marginBottom: 8 }}>
              Two or more pieces overlap heavily — worth spreading them out.
            </p>
          )}

          <div
            style={{
              position: 'relative',
              width: canvasWidth,
              height: canvasHeight,
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              marginBottom: 20,
            }}
          >
            {boxes.map(box => (
              <div
                key={box.id}
                className="crop-box"
                tabIndex={0}
                role="group"
                aria-label={`Piece: ${box.label || 'unlabeled'}`}
                aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight"
                style={{
                  position: 'absolute',
                  left: box.x,
                  top: box.y,
                  width: box.w,
                  height: box.h,
                  border: '1px solid var(--accent)',
                  borderRadius: box.kind === 'circle' ? '50%' : 4,
                  cursor: 'move',
                }}
                onMouseDown={e => startDrag(box.id, 'move', e.clientX, e.clientY)}
                onKeyDown={e => {
                  const patch = boxKeyboardDelta(e.key, e.shiftKey, box);
                  if (!patch) return;
                  updateBox(box.id, patch);
                  e.preventDefault();
                }}
              >
                <input
                  value={box.label}
                  onChange={e => updateBox(box.id, { label: e.target.value })}
                  onMouseDown={e => e.stopPropagation()}
                  onKeyDown={e => e.stopPropagation()}
                  placeholder="label"
                  style={{ width: '90%', fontSize: 11, background: 'transparent', border: 'none', color: 'var(--ink)' }}
                />
                <div
                  onMouseDown={e => { e.stopPropagation(); startDrag(box.id, 'resize', e.clientX, e.clientY); }}
                  style={{ position: 'absolute', right: -4, bottom: -4, width: 10, height: 10, background: 'var(--accent)', cursor: 'nwse-resize' }}
                />
                <button
                  onClick={() => removeBox(box.id)}
                  onKeyDown={e => e.stopPropagation()}
                  aria-label="Remove piece"
                  style={{ position: 'absolute', top: -8, right: -8, width: 16, height: 16, fontSize: 10, lineHeight: 1 }}
                >
                  x
                </button>
              </div>
            ))}
          </div>

          {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{error}</p>}

          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={submitting || !description.trim() || boxes.length === 0}
          >
            {submitting ? 'Queuing…' : 'Generate sheet'}
          </button>
        </>
      )}

      <h2 className="frame-label" style={{ marginBottom: 12, fontSize: 12 }}>
        Live queue
      </h2>
      {jobsError && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 12 }}>{jobsError}</p>}
      {!jobsError && jobs.length === 0 ? (
        <div className="empty-state">Nothing in flight. Queue a generation above.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {jobs.map(job => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </>
  );
}
