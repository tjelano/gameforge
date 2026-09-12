'use client';

import { useEffect, useState, use as usePromise } from 'react';
import { useRouter } from 'next/navigation';
import { useDraggableBoxes } from '@/lib/hooks/useDraggableBoxes';
import type { PlacedPiece } from '@/lib/utils/pieceShapes';
import type { Job } from '@/lib/database/schema';

const DISPLAY_LONG_SIDE = 512;

export default function SplitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = usePromise(params);
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [imageDims, setImageDims] = useState<{ width: number; height: number } | null>(null);
  const [splitting, setSplitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draggable = useDraggableBoxes<PlacedPiece & { included: boolean }>([]);

  useEffect(() => {
    // Same ignore-flag shape as useStyles.ts's mount effect: Strict Mode
    // (the only runtime this app has — see README, there's no production
    // deploy target) double-invokes this effect in dev, and without a
    // guard the second run's addBox calls would seed every piece twice
    // under identical ids (updateBox patches all matching ids at once, so
    // the duplicates stay in lockstep and are invisible to the user until
    // they're uploaded twice at split time).
    let ignore = false;
    (async () => {
      try {
        const res = await fetch(`/api/jobs/${id}`);
        const body = await res.json();
        if (ignore) return;
        if (!body.success) {
          setError(body.error ?? 'Could not load this job.');
          return;
        }
        setJob(body.data);

        const options = JSON.parse(body.data.options);
        const img = new Image();
        img.onload = () => {
          if (ignore) return;
          setImageDims({ width: img.naturalWidth, height: img.naturalHeight });
          // Piece coordinates are already in the same 0-512-long-side space
          // this editor renders its display canvas at (DISPLAY_LONG_SIDE
          // below) — no conversion needed, they're valid display-pixel
          // coordinates as-is. The real image can be a different actual
          // pixel size (e.g. 688px); that only matters later, at crop time.
          for (const piece of options.pieces as PlacedPiece[]) {
            draggable.addBox({ ...piece, included: true });
          }
        };
        img.src = `/api/images/${body.data.result_path}`;
      } catch {
        if (!ignore) setError('Could not reach the server.');
      }
    })();
    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function displayScale(naturalW: number, naturalH: number): number {
    return DISPLAY_LONG_SIDE / Math.max(naturalW, naturalH);
  }

  // Mirrors the placement page's (app/dashboard/ui-sheets/page.tsx)
  // canvasWidth/canvasHeight sizing: long side pinned to DISPLAY_LONG_SIDE,
  // short side scaled by aspect ratio. Must match displayScale() above so
  // the rendered image's actual on-screen scale is the same value the crop
  // math assumes — a fixed 512px-wide box for a portrait image would render
  // at a different effective scale than displayScale() computes, silently
  // corrupting crops for any box the user drags, resizes, or adds.
  const displayW = imageDims
    ? imageDims.width >= imageDims.height
      ? DISPLAY_LONG_SIDE
      : (imageDims.width / imageDims.height) * DISPLAY_LONG_SIDE
    : DISPLAY_LONG_SIDE;
  const displayH = imageDims
    ? imageDims.height >= imageDims.width
      ? DISPLAY_LONG_SIDE
      : (imageDims.height / imageDims.width) * DISPLAY_LONG_SIDE
    : DISPLAY_LONG_SIDE;

  const included = draggable.boxes.filter(b => b.included);
  const hasEmptyLabel = included.some(b => !b.label.trim());

  function handleAddBox() {
    draggable.addBox({
      id: crypto.randomUUID(),
      kind: 'rounded_rect',
      label: '',
      x: 20,
      y: 20,
      w: 80,
      h: 40,
      included: true,
    });
  }

  async function handleSplit() {
    if (!job || !imageDims || splitting || hasEmptyLabel) return;

    setSplitting(true);
    setError(null);
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to load composite image'));
        img.src = `/api/images/${job.result_path}`;
      });

      const scale = displayScale(imageDims.width, imageDims.height);
      const canvas = document.createElement('canvas');

      for (const box of included) {
        const sx = box.x / scale;
        const sy = box.y / scale;
        const sw = box.w / scale;
        const sh = box.h / scale;

        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext('2d')!;
        ctx.clearRect(0, 0, sw, sh);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        const dataUrl = canvas.toDataURL('image/png');

        const res = await fetch('/api/assets/from-crop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            styleId: job.style_id,
            jobId: job.id,
            label: box.label.trim(),
            imageDataUrl: dataUrl,
          }),
        });
        const body = await res.json();
        if (!body.success) throw new Error(body.error ?? 'Failed to save a split element.');
      }

      router.push('/dashboard/assets');
    } catch (e: any) {
      setError(e.message ?? 'Splitting failed.');
    } finally {
      setSplitting(false);
    }
  }

  if (error && !job) return <p style={{ color: 'var(--reject)', fontSize: 13 }}>{error}</p>;
  if (!job) return <p className="page-subtitle">Loading…</p>;

  return (
    <>
      <h1 className="page-title">Split into elements</h1>
      <p className="page-subtitle">
        Boxes are seeded from where you placed each piece. Drag, resize, or remove any of them, or add a new
        one for anything the generation added that wasn&apos;t in your original layout.
      </p>

      <button className="btn" onClick={handleAddBox} style={{ marginBottom: 12 }}>
        + Add box
      </button>

      <div style={{ position: 'relative', width: displayW, height: displayH, marginBottom: 20 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/images/${job.result_path}`} alt={job.prompt} style={{ width: '100%', height: '100%', display: 'block' }} />
        {draggable.boxes.map(box => (
          <div
            key={box.id}
            style={{
              position: 'absolute',
              left: box.x,
              top: box.y,
              width: box.w,
              height: box.h,
              border: `1px solid ${box.included ? 'var(--accent)' : 'var(--ink-faint)'}`,
              opacity: box.included ? 1 : 0.4,
              cursor: 'move',
            }}
            onMouseDown={e => draggable.startDrag(box.id, 'move', e.clientX, e.clientY)}
          >
            <input
              value={box.label}
              onChange={e => draggable.updateBox(box.id, { label: e.target.value })}
              onMouseDown={e => e.stopPropagation()}
              placeholder="label (required)"
              style={{ width: '90%', fontSize: 11, background: 'rgba(0,0,0,0.6)', border: 'none', color: 'var(--ink)' }}
            />
            <div
              onMouseDown={e => { e.stopPropagation(); draggable.startDrag(box.id, 'resize', e.clientX, e.clientY); }}
              style={{ position: 'absolute', right: -4, bottom: -4, width: 10, height: 10, background: 'var(--accent)', cursor: 'nwse-resize' }}
            />
            <button
              onClick={() => draggable.updateBox(box.id, { included: !box.included })}
              style={{ position: 'absolute', top: -8, right: -8, width: 16, height: 16, fontSize: 10, lineHeight: 1 }}
            >
              {box.included ? 'x' : '+'}
            </button>
          </div>
        ))}
      </div>

      {error && <p style={{ color: 'var(--reject)', fontSize: 13, marginBottom: 16 }}>{error}</p>}

      <button className="btn btn-primary" onClick={handleSplit} disabled={splitting || hasEmptyLabel}>
        {splitting ? 'Splitting…' : `Split into ${included.length} elements`}
      </button>
    </>
  );
}
