'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { NAV_OVERVIEW_ROUTE, NAV_SETTINGS_HUB_ROUTE, NAV_PRIMARY_ROUTES, type DashboardRoute } from '@/lib/dashboardRoutes';
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

  // Overview must match exactly (every dashboard route starts with
  // "/dashboard", so a plain startsWith would light it up everywhere).
  // Every other route -- including the Settings hub, deliberately -- keeps
  // the existing startsWith behavior, so the hub shows active for any of
  // its own sub-pages too, not just its own exact URL.
  function isActive(href: string): boolean {
    if (href === '/dashboard') return pathname === '/dashboard';
    return pathname.startsWith(href);
  }

  function renderLink(link: DashboardRoute) {
    return (
      <Link
        key={link.href}
        href={link.href}
        className="rail-link"
        data-active={isActive(link.href) ? 'true' : 'false'}
      >
        {link.label}
      </Link>
    );
  }

  if (pathname === '/login') {
    return (
      <nav className="rail">
        <div className="rail-brand">
          Game<span>Forge</span>
        </div>
      </nav>
    );
  }

  return (
    <nav className="rail">
      <div className="rail-brand">
        Game<span>Forge</span>
      </div>
      {renderLink(NAV_OVERVIEW_ROUTE)}
      {NAV_PRIMARY_ROUTES.map(renderLink)}
      <div className="rail-divider" />
      {renderLink(NAV_SETTINGS_HUB_ROUTE)}
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
