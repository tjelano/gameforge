'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const LINKS = [
  { href: '/dashboard/generate', label: 'Generate' },
  { href: '/dashboard/ui-sheets', label: 'UI Sheets' },
  { href: '/dashboard/themes', label: 'Themes' },
  { href: '/dashboard/components', label: 'Components' },
  { href: '/dashboard/jobs', label: 'Jobs' },
  { href: '/dashboard/assets', label: 'Assets' },
  { href: '/dashboard/styles', label: 'Style Bibles' },
  { href: '/dashboard/export', label: 'Export' },
  { href: '/dashboard/settings/storage', label: 'Storage' },
  { href: '/dashboard/settings/aseprite', label: 'Aseprite' },
  { href: '/dashboard/settings/seed-themes', label: 'Seed Themes' },
];

export function NavRail() {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<{ name: string; isAdmin: boolean } | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/me');
        const body = await res.json();
        if (!ignore && body.success) setMe(body.data);
      } catch {
        // Purely informational — a failed fetch just means no identity shows.
      }
    })();
    return () => { ignore = true; };
  }, [pathname]);

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
      {LINKS.map(link => (
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
