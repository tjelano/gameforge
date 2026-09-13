'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { DASHBOARD_ROUTES } from '@/lib/dashboardRoutes';
import { useCurrentUser } from '@/lib/hooks/useCurrentUser';

export function NavRail() {
  const pathname = usePathname();
  const router = useRouter();
  const { user: me } = useCurrentUser();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/login');
      router.refresh();
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <nav className="rail">
      <div className="rail-brand">
        Game<span>Forge</span>
      </div>
      {DASHBOARD_ROUTES.map(link => (
        <Link
          key={link.href}
          href={link.href}
          className="rail-link"
          data-active={pathname.startsWith(link.href) ? 'true' : 'false'}
        >
          {link.label}
        </Link>
      ))}
      {me && (
        <div style={{ marginTop: 'auto', paddingTop: 16, fontSize: 13 }}>
          <div>Logged in as {me.name}{me.isAdmin ? ' (admin)' : ''}</div>
          <button className="btn" style={{ marginTop: 8, width: '100%' }} onClick={handleLogout} disabled={loggingOut}>
            {loggingOut ? 'Logging out…' : 'Log out'}
          </button>
        </div>
      )}
    </nav>
  );
}
