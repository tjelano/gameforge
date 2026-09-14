export interface DashboardRoute {
  href: string;
  label: string;
}

// Single source of truth for both NavRail's link list and the copilot's
// navigate_to_page tool enum -- see lib/services/copilotTool.ts. Keep this
// to GameForge's static routes only; a dynamic route (a specific job's
// edit page, a specific asset) has no id the model could validly supply.
export const DASHBOARD_ROUTES: DashboardRoute[] = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/generate', label: 'Generate' },
  { href: '/dashboard/ui-sheets', label: 'UI Sheets' },
  { href: '/dashboard/themes', label: 'Themes' },
  { href: '/dashboard/components', label: 'Components' },
  { href: '/dashboard/jobs', label: 'Jobs' },
  { href: '/dashboard/assets', label: 'Assets' },
  { href: '/dashboard/styles', label: 'Style Bibles' },
  { href: '/dashboard/presets', label: 'Presets' },
  { href: '/dashboard/export', label: 'Export' },
  { href: '/dashboard/drive', label: 'Drive' },
  { href: '/dashboard/settings', label: 'Settings' },
  { href: '/dashboard/settings/storage', label: 'Storage' },
  { href: '/dashboard/settings/aseprite', label: 'Aseprite' },
  { href: '/dashboard/settings/seed-themes', label: 'Seed Themes' },
  { href: '/dashboard/settings/google-drive', label: 'Google Drive' },
  { href: '/dashboard/settings/ollama', label: 'Ollama' },
  { href: '/dashboard/settings/design-preview', label: 'Design Preview' },
];

// NavRail's own grouping -- Overview and the Settings hub render as their
// own single links; every other route renders as one flat "tools" group in
// between, and the 6 individual settings sub-routes are hidden from the
// visible rail (still valid DASHBOARD_ROUTES entries, so the AI copilot can
// still navigate straight to one directly). Exported from here rather than
// computed inline in NavRail.tsx so this exact grouping can be tested
// without rendering any React.
export const NAV_OVERVIEW_ROUTE = DASHBOARD_ROUTES.find(r => r.href === '/dashboard')!;
export const NAV_SETTINGS_HUB_ROUTE = DASHBOARD_ROUTES.find(r => r.href === '/dashboard/settings')!;
export const NAV_PRIMARY_ROUTES = DASHBOARD_ROUTES.filter(
  r => r.href !== '/dashboard' && r.href !== '/dashboard/settings' && !r.href.startsWith('/dashboard/settings/')
);
