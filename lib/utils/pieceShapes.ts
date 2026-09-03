import { z } from 'zod';

export type PieceKind = 'rounded_rect' | 'circle' | 'polygon';

/** Canvas-space form used for all drag/resize interaction — a uniform
 * bounding box regardless of the piece's real shape. Converted to the
 * kind-specific Pixellab shape only at submit time (toUiPiece). */
export interface PlacedPiece {
  id: string;
  kind: PieceKind;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  sides?: number; // polygon only
}

export interface UiPieceRect {
  id: string;
  kind: 'rounded_rect';
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
}

export interface UiPieceCircle {
  id: string;
  kind: 'circle';
  label: string;
  x: number;
  y: number;
  r: number;
}

export interface UiPiecePolygon {
  id: string;
  kind: 'polygon';
  label: string;
  x: number;
  y: number;
  r: number;
  sides: number;
  phase: number;
}

export type UiPiece = UiPieceRect | UiPieceCircle | UiPiecePolygon;

const RECT_RADIUS_RATIO = 0.15;

export function toUiPiece(piece: PlacedPiece): UiPiece {
  const { id, kind, label, x, y, w, h } = piece;

  if (kind === 'rounded_rect') {
    return { id, kind, label, x, y, w, h, radius: Math.round(Math.min(w, h) * RECT_RADIUS_RATIO) };
  }

  const centerX = x + w / 2;
  const centerY = y + h / 2;
  const r = Math.min(w, h) / 2;

  if (kind === 'circle') {
    return { id, kind, label, x: centerX, y: centerY, r };
  }

  if (kind === 'polygon') {
    if (!piece.sides) {
      throw new Error(`Polygon piece ${id} is missing sides`);
    }
    return { id, kind, label, x: centerX, y: centerY, r, sides: piece.sides, phase: 0 };
  }

  throw new Error(`Unknown piece kind: ${kind}`);
}

export interface PiecePreset {
  name: string;
  kind: PieceKind;
  defaultW: number;
  defaultH: number;
  sides?: number;
}

export const PIECE_PRESETS: PiecePreset[] = [
  { name: 'Button', kind: 'rounded_rect', defaultW: 96, defaultH: 32 },
  { name: 'Icon button', kind: 'rounded_rect', defaultW: 48, defaultH: 48 },
  { name: 'Toolbar', kind: 'rounded_rect', defaultW: 200, defaultH: 32 },
  { name: 'Tab', kind: 'rounded_rect', defaultW: 80, defaultH: 28 },
  { name: 'Panel', kind: 'rounded_rect', defaultW: 160, defaultH: 120 },
  { name: 'Window', kind: 'rounded_rect', defaultW: 220, defaultH: 160 },
  { name: 'Health bar', kind: 'rounded_rect', defaultW: 140, defaultH: 20 },
  { name: 'Avatar', kind: 'circle', defaultW: 64, defaultH: 64 },
  { name: 'Triangle', kind: 'polygon', defaultW: 64, defaultH: 64, sides: 3 },
  { name: 'Pentagon', kind: 'polygon', defaultW: 64, defaultH: 64, sides: 5 },
  { name: 'Hexagon', kind: 'polygon', defaultW: 64, defaultH: 64, sides: 6 },
  { name: 'Octagon', kind: 'polygon', defaultW: 64, defaultH: 64, sides: 8 },
];

export const MAX_PIECES_PER_SHEET = 20;
export const PIECE_OVERLAP_WARNING_RATIO = 0.5;

export const OUTPUT_SIZE_PRESETS = [
  { width: 256, height: 256, label: '256x256 (square)' },
  { width: 296, height: 224, label: '296x224 (4:3 landscape)' },
  { width: 224, height: 296, label: '224x296 (3:4 portrait)' },
  { width: 344, height: 192, label: '344x192 (16:9 landscape)' },
  { width: 192, height: 344, label: '192x344 (9:16 portrait)' },
  { width: 512, height: 512, label: '512x512 (square)' },
  { width: 592, height: 448, label: '592x448 (4:3 landscape)' },
  { width: 448, height: 592, label: '448x592 (3:4 portrait)' },
  { width: 688, height: 384, label: '688x384 (16:9 landscape)' },
  { width: 384, height: 688, label: '384x688 (9:16 portrait)' },
] as const;

/** Mirrors PlacedPiece — the shape toUiPiece() expects as input. `sides`
 * is required when kind is 'polygon' (toUiPiece throws otherwise), and
 * left optional for the other two kinds. */
const PlacedPieceSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['rounded_rect', 'circle', 'polygon']),
    label: z.string().min(1),
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
    sides: z.number().int().positive().optional(),
  })
  .refine((piece) => piece.kind !== 'polygon' || piece.sides !== undefined, {
    message: 'polygon pieces require sides',
  });

/** Structural, hardening validation for a UI-sheet generation job's
 * options blob, parsed server-side in worker.ts right before a metered
 * Pixellab call — the browser UI's MAX_PIECES_PER_SHEET cap and
 * /api/generate's options validation (z.record(...).unknown()) don't
 * enforce this shape on their own. */
export const UiSheetOptionsSchema = z.object({
  pieces: z.array(PlacedPieceSchema).min(1).max(MAX_PIECES_PER_SHEET),
  imageSize: z
    .object({ width: z.number(), height: z.number() })
    .refine(
      (size) => OUTPUT_SIZE_PRESETS.some((preset) => preset.width === size.width && preset.height === size.height),
      { message: 'imageSize must match one of the output size presets' }
    ),
  colorPalette: z.string().optional(),
});

/** True when one box covers more than `PIECE_OVERLAP_WARNING_RATIO` of
 * the other's area — a cheap warning signal, not a submit blocker. */
export function boxesSignificantlyOverlap(a: PlacedPiece, b: PlacedPiece): boolean {
  const overlapW = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const overlapH = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const overlapArea = overlapW * overlapH;
  const smallerArea = Math.min(a.w * a.h, b.w * b.h);
  if (smallerArea === 0) return false;
  return overlapArea / smallerArea > PIECE_OVERLAP_WARNING_RATIO;
}
