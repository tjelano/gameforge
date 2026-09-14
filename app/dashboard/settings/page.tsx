import Link from 'next/link';

const SETTINGS_PAGES = [
  { href: '/dashboard/settings/storage', name: 'Storage', description: 'Clean up orphaned generated files.' },
  { href: '/dashboard/settings/aseprite', name: 'Aseprite', description: 'Path to your local Aseprite executable.' },
  { href: '/dashboard/settings/seed-themes', name: 'Seed Themes', description: 'Import ready-made DaisyUI/Bootswatch themes.' },
  { href: '/dashboard/settings/google-drive', name: 'Google Drive', description: 'Shared Drive connection.' },
  { href: '/dashboard/settings/ollama', name: 'Ollama', description: 'Local model connection and model management.' },
] as const;

export default function SettingsHubPage() {
  return (
    <>
      <h1 className="page-title">Settings</h1>
      <p className="page-subtitle">Machine and connection settings for this GameForge install.</p>
      <div>
        {SETTINGS_PAGES.map(page => (
          <Link key={page.href} href={page.href} className="settings-item">
            <div>
              <div>{page.name}</div>
              <div className="settings-item-desc">{page.description}</div>
            </div>
            <span style={{ color: 'var(--ink-faint)' }}>&rarr;</span>
          </Link>
        ))}
      </div>
    </>
  );
}
