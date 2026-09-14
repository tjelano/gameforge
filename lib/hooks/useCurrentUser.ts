'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

export interface CurrentUser {
  id: string;
  name: string;
  isAdmin: boolean;
}

export function useCurrentUser() {
  const pathname = usePathname();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Same ignore-flag shape as useStyles.ts — avoids a StrictMode
    // double-invoke race setting state after unmount.
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/me');
        const body = await res.json();
        if (!ignore && body.success) setUser(body.data);
      } catch {
        // Purely informational — a failed fetch just means no identity shows.
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [pathname]);

  return { user, loading };
}
