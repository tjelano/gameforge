'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/dashboard/generate', label: 'Generate' },
  { href: '/dashboard/jobs', label: 'Jobs' },
  { href: '/dashboard/assets', label: 'Assets' },
  { href: '/dashboard/styles', label: 'Style Bibles' },
  { href: '/dashboard/export', label: 'Export' },
  { href: '/dashboard/settings/storage', label: 'Storage' },
];

export function NavRail() {
  const pathname = usePathname();

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
    </nav>
  );
}
