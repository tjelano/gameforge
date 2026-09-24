import { describe, it, expect } from 'vitest';
import { DASHBOARD_ROUTES, NAV_OVERVIEW_ROUTE, NAV_SETTINGS_HUB_ROUTE, NAV_PRIMARY_ROUTES, NAV_ASSET_ROUTES, NAV_WEBSITE_ROUTES } from '@/lib/dashboardRoutes';

describe('NavRail route grouping', () => {
  it('finds the Overview and Settings hub routes', () => {
    expect(NAV_OVERVIEW_ROUTE.label).toBe('Overview');
    expect(NAV_SETTINGS_HUB_ROUTE.label).toBe('Settings');
  });

  it('every DASHBOARD_ROUTES entry is either visible in one group or a known-hidden settings sub-route', () => {
    const visible = [NAV_OVERVIEW_ROUTE, ...NAV_PRIMARY_ROUTES, NAV_SETTINGS_HUB_ROUTE];
    const hiddenSettingsSubRoutes = DASHBOARD_ROUTES.filter(r => r.href.startsWith('/dashboard/settings/'));
    const accountedFor = [...visible, ...hiddenSettingsSubRoutes];
    expect(accountedFor.map(r => r.href).sort()).toEqual(DASHBOARD_ROUTES.map(r => r.href).sort());
  });

  it('exactly 13 routes are visible and exactly the 6 settings sub-routes are hidden', () => {
    const visible = [NAV_OVERVIEW_ROUTE, ...NAV_PRIMARY_ROUTES, NAV_SETTINGS_HUB_ROUTE];
    expect(visible).toHaveLength(13);
    const hidden = DASHBOARD_ROUTES.filter(r => !visible.includes(r));
    expect(hidden).toHaveLength(6);
    expect(hidden.every(r => r.href.startsWith('/dashboard/settings/'))).toBe(true);
  });

  it('NAV_PRIMARY_ROUTES excludes every settings route, including the hub itself', () => {
    expect(NAV_PRIMARY_ROUTES.some(r => r.href.startsWith('/dashboard/settings'))).toBe(false);
    expect(NAV_PRIMARY_ROUTES.some(r => r.href === '/dashboard')).toBe(false);
  });

  it('NAV_PRIMARY_ROUTES is exactly NAV_ASSET_ROUTES followed by NAV_WEBSITE_ROUTES', () => {
    expect(NAV_PRIMARY_ROUTES).toEqual([...NAV_ASSET_ROUTES, ...NAV_WEBSITE_ROUTES]);
  });

  it('NAV_WEBSITE_ROUTES includes the new workbench route', () => {
    expect(NAV_WEBSITE_ROUTES.some(r => r.href === '/dashboard/website')).toBe(true);
  });

  it('no route appears in both NAV_ASSET_ROUTES and NAV_WEBSITE_ROUTES', () => {
    const assetHrefs = new Set(NAV_ASSET_ROUTES.map(r => r.href));
    expect(NAV_WEBSITE_ROUTES.every(r => !assetHrefs.has(r.href))).toBe(true);
  });
});
