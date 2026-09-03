import { describe, it, expect } from 'vitest';
import { toUiPiece, PIECE_PRESETS } from '@/lib/utils/pieceShapes';
import type { PlacedPiece } from '@/lib/utils/pieceShapes';

describe('toUiPiece', () => {
  it('converts a rounded_rect placed piece to a UiPieceRect with a proportional radius', () => {
    const piece: PlacedPiece = { id: 'a', kind: 'rounded_rect', label: 'Inventory', x: 10, y: 20, w: 100, h: 40 };
    const result = toUiPiece(piece);
    expect(result).toEqual({ id: 'a', kind: 'rounded_rect', label: 'Inventory', x: 10, y: 20, w: 100, h: 40, radius: 6 });
  });

  it('converts a circle placed piece to a UiPieceCircle using bounding-box center + half the shorter side', () => {
    const piece: PlacedPiece = { id: 'b', kind: 'circle', label: 'Avatar', x: 0, y: 0, w: 64, h: 64 };
    const result = toUiPiece(piece);
    expect(result).toEqual({ id: 'b', kind: 'circle', label: 'Avatar', x: 32, y: 32, r: 32 });
  });

  it('converts a polygon placed piece to a UiPiecePolygon carrying its sides and phase 0', () => {
    const piece: PlacedPiece = { id: 'c', kind: 'polygon', label: 'Warning', x: 0, y: 0, w: 60, h: 60, sides: 3 };
    const result = toUiPiece(piece);
    expect(result).toEqual({ id: 'c', kind: 'polygon', label: 'Warning', x: 30, y: 30, r: 30, sides: 3, phase: 0 });
  });

  it('throws for a polygon piece missing sides — a real bug, not a case to silently default around', () => {
    const piece = { id: 'd', kind: 'polygon', label: 'x', x: 0, y: 0, w: 10, h: 10 } as unknown as PlacedPiece;
    expect(() => toUiPiece(piece)).toThrow(/sides/);
  });
});

describe('PIECE_PRESETS', () => {
  it('has exactly the 12 presets Pixellab itself offers', () => {
    const names = PIECE_PRESETS.map(p => p.name);
    expect(names).toEqual([
      'Button', 'Icon button', 'Toolbar', 'Tab', 'Panel', 'Window', 'Health bar',
      'Avatar', 'Triangle', 'Pentagon', 'Hexagon', 'Octagon',
    ]);
  });
});
