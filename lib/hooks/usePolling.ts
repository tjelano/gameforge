'use client';

import { useEffect, useRef } from 'react';

/**
 * Calls `callback` immediately, then again every `intervalMs`, for as
 * long as the calling component is mounted. Single shared shape for
 * every dashboard page that needs live job status — see AGENTS.md's
 * "single usePolling -> /api/jobs/active" pattern.
 */
export function usePolling(callback: () => void | Promise<void>, intervalMs: number): void {
  const callbackRef = useRef(callback);

  // Keep the ref in sync via an effect, not a render-body write —
  // React 19's stricter rules treat mutating a ref during render as
  // impure even when (as here) nothing reads it until after mount.
  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    callbackRef.current();
    const id = setInterval(() => {
      callbackRef.current();
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
