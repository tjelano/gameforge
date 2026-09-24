'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

export interface CurrentUser {
  id: string;
  name: string;
  isAdmin: boolean;
}

export function useCurrentUser() {
  const pathname = usePathname();
  const router = useRouter();
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
        if (ignore) return;
        if (body.success && body.data) {
          setUser(body.data);
        } else if (body.success && body.data === null && pathname.startsWith('/dashboard')) {
          // A session cookie can pass proxy.ts's presence-only check but still
          // fail to resolve to a real user (expired, or the user was deleted) —
          // proxy.ts deliberately never validates against the DB (see its own
          // header comment), so this is the one place that gap gets closed.
          // /login itself is excluded: a null user there is the normal,
          // expected state, not a session that went stale.
          //
          // Only `success: true, data: null` counts as that definitive "no user"
          // signal. `success: false` is the route's catch-block response for a
          // transient server error (see app/api/auth/me/route.ts) — not proof the
          // session is stale, so it must not bounce a possibly-still-valid user
          // to the login screen. Same non-redirect treatment as a thrown fetch
          // error below.
          setUser(null);
          router.replace('/login?reason=expired');
        }
      } catch {
        // Purely informational — a failed fetch just means no identity shows.
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [pathname, router]);

  return { user, loading };
}
