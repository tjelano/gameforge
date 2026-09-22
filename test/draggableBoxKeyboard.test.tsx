// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { boxKeyboardDelta, MIN_SIZE } from '@/lib/hooks/useDraggableBoxes';

describe('boxKeyboardDelta', () => {
  const box = { x: 10, y: 10, w: 20, h: 20 };

  it('moves right by 4px on ArrowRight (absolute new x)', () => {
    expect(boxKeyboardDelta('ArrowRight', false, box)).toEqual({ x: 14 });
  });

  it('moves left by 4px on ArrowLeft (absolute new x)', () => {
    expect(boxKeyboardDelta('ArrowLeft', false, box)).toEqual({ x: 6 });
  });

  it('moves down/up by 4px on ArrowDown/ArrowUp (absolute new y)', () => {
    expect(boxKeyboardDelta('ArrowDown', false, box)).toEqual({ y: 14 });
    expect(boxKeyboardDelta('ArrowUp', false, box)).toEqual({ y: 6 });
  });

  it('grows width by 4px on Shift+ArrowRight (absolute new w)', () => {
    expect(boxKeyboardDelta('ArrowRight', true, box)).toEqual({ w: 24 });
  });

  it('shrinks width on Shift+ArrowLeft, floored at MIN_SIZE', () => {
    expect(boxKeyboardDelta('ArrowLeft', true, { x: 0, y: 0, w: 10, h: 20 })).toEqual({ w: MIN_SIZE });
  });

  it('grows height by 4px on Shift+ArrowDown (absolute new h)', () => {
    expect(boxKeyboardDelta('ArrowDown', true, box)).toEqual({ h: 24 });
  });

  it('shrinks height on Shift+ArrowUp, floored at MIN_SIZE', () => {
    expect(boxKeyboardDelta('ArrowUp', true, { x: 0, y: 0, w: 20, h: 10 })).toEqual({ h: MIN_SIZE });
  });

  it('returns null for an unhandled key', () => {
    expect(boxKeyboardDelta('Enter', false, box)).toBeNull();
  });
});
