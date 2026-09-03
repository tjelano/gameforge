'use client';

import { useCallback, useRef, useState } from 'react';

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_SIZE = 8;

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
