export interface DashboardRoute {
  href: string;
  label: string;
}

// Single source of truth for both NavRail's link list and the copilot's
// navigate_to_page tool enum -- see lib/services/copilotTool.ts. Keep this
// to GameForge's static routes only; a dynamic route (a specific job's
// edit page, a specific asset) has no id the model could validly supply.
export const DASHBOARD_ROUTES: DashboardRoute[] = [
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
  { href: '/dashboard/settings/storage', label: 'Storage' },
  { href: '/dashboard/settings/aseprite', label: 'Aseprite' },
  { href: '/dashboard/settings/seed-themes', label: 'Seed Themes' },
  { href: '/dashboard/settings/google-drive', label: 'Google Drive' },
  { href: '/dashboard/settings/ollama', label: 'Ollama' },
];
