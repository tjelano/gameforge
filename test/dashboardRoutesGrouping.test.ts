import { describe, it, expect } from 'vitest';
import { DASHBOARD_ROUTES, NAV_OVERVIEW_ROUTE, NAV_SETTINGS_HUB_ROUTE, NAV_PRIMARY_ROUTES } from '@/lib/dashboardRoutes';

describe('NavRail route grouping', () => {
  it('finds the Overview and Settings hub routes', () => {
    expect(NAV_OVERVIEW_ROUTE.label).toBe('Overview');
    expect(NAV_SETTINGS_HUB_ROUTE.label).toBe('Settings');
  });

  it('every DASHBOARD_ROUTES entry is either visible in one group or a known-hidden settings sub-route', () => {
    // The 5 individual /dashboard/settings/* pages are deliberately NOT
    // rendered anywhere in the visible sidebar (see Section 3 of the
    // spec) -- they're only reachable via the Settings hub page's own
    // links, a direct URL, or the AI copilot. So "every route is
    // accounted for" does NOT mean "every route is visible" -- it means
    // every route is either visible, or is one of those 5 known,
    // intentionally-hidden sub-routes. Asserting plain coverage against
    // the full DASHBOARD_ROUTES list (visible === all 17) would be wrong
    // by construction, since 5 of those 17 are never meant to be visible.
    const visible = [NAV_OVERVIEW_ROUTE, ...NAV_PRIMARY_ROUTES, NAV_SETTINGS_HUB_ROUTE];
    const hiddenSettingsSubRoutes = DASHBOARD_ROUTES.filter(r => r.href.startsWith('/dashboard/settings/'));
    const accountedFor = [...visible, ...hiddenSettingsSubRoutes];
    expect(accountedFor.map(r => r.href).sort()).toEqual(DASHBOARD_ROUTES.map(r => r.href).sort());
  });

  it('exactly 12 routes are visible and exactly the 5 settings sub-routes are hidden', () => {
    const visible = [NAV_OVERVIEW_ROUTE, ...NAV_PRIMARY_ROUTES, NAV_SETTINGS_HUB_ROUTE];
    expect(visible).toHaveLength(12);
    const hidden = DASHBOARD_ROUTES.filter(r => !visible.includes(r));
    expect(hidden).toHaveLength(5);
    expect(hidden.every(r => r.href.startsWith('/dashboard/settings/'))).toBe(true);
  });

  it('NAV_PRIMARY_ROUTES excludes every settings route, including the hub itself', () => {
    expect(NAV_PRIMARY_ROUTES.some(r => r.href.startsWith('/dashboard/settings'))).toBe(false);
    expect(NAV_PRIMARY_ROUTES.some(r => r.href === '/dashboard')).toBe(false);
  });
});
