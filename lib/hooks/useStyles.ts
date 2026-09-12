'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Style } from '@/lib/database/schema';

export function useStyles() {
  const [styles, setStyles] = useState<Style[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/styles');
      const body = await res.json();
      if (body.success) {
        setStyles(body.data);
        setError(null);
      } else {
        setError(body.error ?? 'Request failed.');
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Inlined rather than calling refresh() directly: the mount fetch
    // needs to skip its state update if the component unmounts first
    // (route change, fast navigation) — refresh() itself is still
    // exposed below for manual re-fetches after a user action, where
    // that race isn't a concern.
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/styles');
        const body = await res.json();
        if (ignore) return;
        if (body.success) {
          setStyles(body.data);
          setError(null);
        } else {
          setError(body.error ?? 'Request failed.');
        }
      } catch {
        if (!ignore) setError('Could not reach the server.');
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  return { styles, loading, error, refresh };
}
