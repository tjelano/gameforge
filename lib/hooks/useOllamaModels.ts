'use client';

import { useEffect, useState } from 'react';

/**
 * The installed Ollama models plus the host they came from, for the
 * per-generation provider picker. Fetched once on mount -- the list only
 * matters at the moment you're about to generate, no polling needed.
 * `host` is returned alongside `models` (not hardcoded by the caller) so a
 * generation request always targets whatever host is actually configured
 * in Settings, even after the user changes it away from the default.
 */
export function useOllamaModels(): { models: string[]; host: string } {
  const [models, setModels] = useState<string[]>([]);
  const [host, setHost] = useState('');

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/settings/ollama/models');
        const body = await res.json();
        if (!ignore && body.success) {
          setModels(body.data.models);
          setHost(body.data.host);
        }
      } catch {
        // Non-fatal -- the picker just shows no local models.
      }
    })();
    return () => { ignore = true; };
  }, []);

  return { models, host };
}
