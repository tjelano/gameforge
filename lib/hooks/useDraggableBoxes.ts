'use client';

import { useCallback, useRef, useState } from 'react';

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_SIZE = 8;
const KEYBOARD_STEP = 4;

// Pure and exported so both real consumer pages (split/page.tsx,
// ui-sheets/page.tsx) call this exact function from their onKeyDown
// handlers instead of each hand-copying the same logic, and so a test can
// exercise the real behavior directly rather than a reimplementation of it.
// Returns the FINAL absolute patch (not a relative delta) so the call site
// is always just `const patch = boxKeyboardDelta(...); if (patch)
// updateBox(box.id, patch);` -- no per-page branching left to get wrong.
export function boxKeyboardDelta(
  key: string,
  shiftKey: boolean,
  box: { x: number; y: number; w: number; h: number },
): { x: number } | { y: number } | { w: number } | { h: number } | null {
  if (key === 'ArrowRight') return shiftKey ? { w: Math.max(MIN_SIZE, box.w + KEYBOARD_STEP) } : { x: box.x + KEYBOARD_STEP };
  if (key === 'ArrowLeft') return shiftKey ? { w: Math.max(MIN_SIZE, box.w - KEYBOARD_STEP) } : { x: box.x - KEYBOARD_STEP };
  if (key === 'ArrowDown') return shiftKey ? { h: Math.max(MIN_SIZE, box.h + KEYBOARD_STEP) } : { y: box.y + KEYBOARD_STEP };
  if (key === 'ArrowUp') return shiftKey ? { h: Math.max(MIN_SIZE, box.h - KEYBOARD_STEP) } : { y: box.y - KEYBOARD_STEP };
  return null;
}

export function useDraggableBoxes<T extends Box>(initial: T[]) {
  const [boxes, setBoxes] = useState<T[]>(initial);
  const dragState = useRef<{ id: string; mode: 'move' | 'resize'; startX: number; startY: number; startBox: Box } | null>(null);

  const updateBox = useCallback((id: string, patch: Partial<T>) => {
    setBoxes(prev => prev.map(b => (b.id === id ? { ...b, ...patch } : b)));
  }, []);

  const addBox = useCallback((box: T) => {
    setBoxes(prev => [...prev, box]);
  }, []);

  const removeBox = useCallback((id: string) => {
    setBoxes(prev => prev.filter(b => b.id !== id));
  }, []);

  const startDrag = useCallback((id: string, mode: 'move' | 'resize', clientX: number, clientY: number) => {
    const box = boxes.find(b => b.id === id);
    if (!box) return;
    dragState.current = { id, mode, startX: clientX, startY: clientY, startBox: { ...box } };

    function onMove(e: MouseEvent) {
      const state = dragState.current;
      if (!state) return;
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;

      if (state.mode === 'move') {
        updateBox(state.id, { x: state.startBox.x + dx, y: state.startBox.y + dy } as Partial<T>);
      } else {
        updateBox(state.id, {
          w: Math.max(MIN_SIZE, state.startBox.w + dx),
          h: Math.max(MIN_SIZE, state.startBox.h + dy),
        } as Partial<T>);
      }
    }

    function onUp() {
      dragState.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [boxes, updateBox]);

  return { boxes, addBox, updateBox, removeBox, startDrag };
}
