# Dashboard Visual Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace GameForge's amber/charcoal look with a Persimmon-on-Obsidian palette and a
Sentient/Satoshi typeface pairing, restructure the sidebar (Overview + 9 tools + a collapsed Settings
hub, down from 15 flat links), and add a new Overview landing page with stat cards, quick actions, and
a data-derived recent-activity feed.

**Architecture:** Almost entirely a token-and-shared-class change — every existing page already
composes from `app/globals.css`'s CSS custom properties and shared classes (`.card`, `.btn`,
`.frame-label`, etc.), so redefining those propagates the new look everywhere with zero per-page TSX
changes. On top of that: one new `JobService` method + one new merge service for the activity feed,
two new pages (Overview, Settings hub), and a restructured `NavRail`.

**Tech Stack:** Plain CSS custom properties (no Tailwind/CSS-in-JS), `next/font/local` for self-hosted
fonts, direct SQL via better-sqlite3, Next.js App Router server/client components matching this
codebase's existing conventions.

**Spec:** `docs/superpowers/specs/2026-09-14-dashboard-visual-refresh-design.md` (DeepSeek-reviewed,
see the paired `-review-log.md` — including a correction: two findings originally logged as
"fabricated" were real, existing code, caught by an incomplete verification grep on the controller's
side, not by DeepSeek inventing anything).

## Global Constraints

- No ORM, no wrapper classes, no new dependencies (no Tailwind, no CSS-in-JS library) — direct SQL,
  plain CSS.
- `--keeper`/`--keeper-dim`/`--reject`/`--reject-dim` (promote/discard semantic colors) and
  `--font-mono` are explicitly unchanged by this refresh — do not touch their values.
- Every existing page already renders through `app/globals.css`'s shared classes — do not add
  per-page inline style overrides to achieve the new look; if a shared class needs a new variant,
  add the variant to `globals.css`, not to an individual page.
- No React component rendering tests exist anywhere in this codebase (confirmed project-wide: zero
  `@testing-library` usage) — this is deliberate project convention. New UI (Overview page, Settings
  hub page, restructured NavRail) is verified manually in a running dev server, per `AGENTS.md`'s own
  instruction for UI changes. Plain data/logic (the new `JobService` method, the activity-feed merge,
  the route-grouping constants) gets real unit tests as usual.
- Run `npx vitest run`, `npx tsc --noEmit`, and `npx eslint app lib worker.ts` before considering any
  task done — all three are required CI gates.
- The two font bundle folders at the project root (`Satoshi_Complete/`, `Sentient_Complete/`) are the
  user's raw Fontshare downloads — only the two `*-Variable.woff2` files inside them are needed; the
  user has explicitly said to delete both folders once those files are copied out (Task 1).

---

### Task 1: Visual tokens, fonts, and shared button restyle

**Files:**
- Create: `public/fonts/Sentient-Variable.woff2` (copied from `Sentient_Complete/Fonts/WEB/fonts/`)
- Create: `public/fonts/Satoshi-Variable.woff2` (copied from `Satoshi_Complete/Fonts/WEB/fonts/`)
- Delete: `Satoshi_Complete/`, `Sentient_Complete/` (project root)
- Modify: `app/layout.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Produces: `--font-sentient`/`--font-satoshi` CSS variables (set on `<html>` via `next/font/local`),
  and the redefined `:root` tokens (`--bg`, `--surface`, `--surface-raised`, `--border`, `--ink`,
  `--ink-dim`, `--ink-faint`, `--accent`, `--accent-bright`, `--accent-dim`, `--accent-2`,
  `--accent-ink`, `--radius`) every later task's new CSS relies on.

- [ ] **Step 1: Copy the two variable font files, delete the bundle folders**

```bash
mkdir -p public/fonts
cp "Satoshi_Complete/Fonts/WEB/fonts/Satoshi-Variable.woff2" "public/fonts/Satoshi-Variable.woff2"
cp "Sentient_Complete/Fonts/WEB/fonts/Sentient-Variable.woff2" "public/fonts/Sentient-Variable.woff2"
rm -rf Satoshi_Complete Sentient_Complete
```

- [ ] **Step 2: Wire the fonts into the root layout**

Replace `app/layout.tsx`'s font imports and setup:

```tsx
import type { Metadata } from 'next';
import { IBM_Plex_Mono } from 'next/font/google';
import localFont from 'next/font/local';
import './globals.css';
import { NavRail } from '@/app/components/NavRail';
import { CopilotPanel } from '@/app/components/CopilotPanel';

const sentient = localFont({
  src: '../public/fonts/Sentient-Variable.woff2',
  variable: '--font-sentient',
  display: 'swap',
});

const satoshi = localFont({
  src: '../public/fonts/Satoshi-Variable.woff2',
  variable: '--font-satoshi',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  variable: '--font-plex-mono',
  weight: ['400', '500'],
});

export const metadata: Metadata = {
  title: 'GameForge',
  description: 'Local-first game asset pipeline',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sentient.variable} ${satoshi.variable} ${plexMono.variable}`}>
      <body>
        <div className="shell">
          <NavRail />
          <main className="main">{children}</main>
          <CopilotPanel />
        </div>
      </body>
    </html>
  );
}
```

(`Space_Grotesk` and `Inter` imports from `next/font/google` are removed entirely — nothing else in
the app references `--font-space-grotesk`/`--font-inter` directly, only through `--font-display`/
`--font-body`, which Step 3 repoints.)

- [ ] **Step 3: Replace the `:root` token block in `app/globals.css`**

```css
:root {
  --bg: #0A0A0A;
  --surface: #121212;
  --surface-raised: #1A1A1A;
  --border: #262626;
  --ink: #EDEDED;
  --ink-dim: #9A9A9A;
  --ink-faint: #6A6A6A;
  --accent: #FF4F00;
  --accent-bright: #FF6A2B;
  --accent-dim: #C23A00;
  --accent-2: #4FA8D8;
  --accent-ink: #0A0A0A;
  --keeper: #8ea885;
  --keeper-dim: #4a5c46;
  --reject: #c46a4f;
  --reject-dim: #5c3a2c;
  --radius: 7px;
  --font-display: var(--font-sentient), Georgia, serif;
  --font-body: var(--font-satoshi), -apple-system, 'Segoe UI', sans-serif;
  --font-mono: var(--font-plex-mono), 'IBM Plex Mono', monospace;
}
```

(Every rule elsewhere in `globals.css` that reads `var(--surface)`, `var(--ink)`, `var(--font-display)`,
etc. — `.card`, `.page-title`, `.page-subtitle`, `.frame-label`, `.field`, `.badge`, `.empty-state`,
`.rail-brand` — needs no changes at all; the new look propagates through the variable reference alone.
`--keeper*`/`--reject*` values are copied verbatim, unchanged, per the Global Constraints.)

- [ ] **Step 4: Restyle `.btn`/`.btn-primary` — transparent outline instead of filled**

Replace:

```css
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface-raised);
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.08s ease, opacity 0.12s ease;
}

.btn:hover:not(:disabled) {
  transform: translateY(-1px);
}
```

with:

```css
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.08s ease, opacity 0.12s ease, background 0.12s ease;
}

.btn:hover:not(:disabled) {
  background: var(--surface-raised);
  transform: translateY(-1px);
}
```

Replace:

```css
.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
}
```

with:

```css
.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-bright);
  border-color: var(--accent-bright);
}
```

(`.btn-keeper`/`.btn-reject` and their `:hover` rules are unchanged — they already only set a border
color and a hover background on top of whatever `.btn`'s own base is, so they keep working correctly
against the new transparent base with no edits needed.)

- [ ] **Step 5: Run the full test suite, tsc, and eslint**

Run: `npx vitest run && npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: all clean. No test assertions reference specific color hex values or font names anywhere in
this codebase (confirmed: this is a pure visual change with no behavioral surface), so nothing should
break — this step is a safety net, not expected to surface anything.

- [ ] **Step 6: Manually verify in a running dev server**

Run: `npm run dev`, open any dashboard page (e.g. `/dashboard/generate`) in a browser.
Expected: Obsidian background, Persimmon buttons/accents, Sentient-styled page title (serif, visibly
different from the body text), Satoshi body text, outlined (not filled) secondary buttons.

- [ ] **Step 7: Commit**

```bash
git add public/fonts app/layout.tsx app/globals.css
git commit -m "feat: switch to Persimmon/Obsidian palette and Sentient/Satoshi fonts"
```

(`Satoshi_Complete`/`Sentient_Complete` were never tracked by git — nothing to stage for their removal.)

---

### Task 2: Sidebar restructure — route grouping + NavRail

**Files:**
- Modify: `lib/dashboardRoutes.ts`
- Modify: `app/components/NavRail.tsx`
- Modify: `app/globals.css` (append `.rail-link` variants + `.rail-divider`)
- Test: `test/dashboardRoutesGrouping.test.ts`

**Interfaces:**
- Consumes: the token changes from Task 1 (`--accent`, `--border`, etc.) — depends on Task 1 being
  complete first, since this task's new CSS rules reference those tokens.
- Produces: `NAV_OVERVIEW_ROUTE`, `NAV_SETTINGS_HUB_ROUTE`, `NAV_PRIMARY_ROUTES` exported from
  `lib/dashboardRoutes.ts` — `NavRail.tsx` is this task's only consumer, but they're exported (not
  computed inline in the component) specifically so this task's test can verify the grouping without
  needing to render any React.

- [ ] **Step 1: Add the two new routes and the grouping exports to `lib/dashboardRoutes.ts`**

Replace the file's contents:

```ts
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
];

// NavRail's own grouping -- Overview and the Settings hub render as their
// own single links; every other route renders as one flat "tools" group in
// between, and the 5 individual settings sub-routes are hidden from the
// visible rail (still valid DASHBOARD_ROUTES entries, so the AI copilot can
// still navigate straight to one directly). Exported from here rather than
// computed inline in NavRail.tsx so this exact grouping can be tested
// without rendering any React.
export const NAV_OVERVIEW_ROUTE = DASHBOARD_ROUTES.find(r => r.href === '/dashboard')!;
export const NAV_SETTINGS_HUB_ROUTE = DASHBOARD_ROUTES.find(r => r.href === '/dashboard/settings')!;
export const NAV_PRIMARY_ROUTES = DASHBOARD_ROUTES.filter(
  r => r.href !== '/dashboard' && r.href !== '/dashboard/settings' && !r.href.startsWith('/dashboard/settings/')
);
```

- [ ] **Step 2: Write the failing grouping test**

Create `test/dashboardRoutesGrouping.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DASHBOARD_ROUTES, NAV_OVERVIEW_ROUTE, NAV_SETTINGS_HUB_ROUTE, NAV_PRIMARY_ROUTES } from '@/lib/dashboardRoutes';

describe('NavRail route grouping', () => {
  it('finds the Overview and Settings hub routes', () => {
    expect(NAV_OVERVIEW_ROUTE.label).toBe('Overview');
    expect(NAV_SETTINGS_HUB_ROUTE.label).toBe('Settings');
  });

  it('every DASHBOARD_ROUTES entry appears in exactly one visible group, no duplicates', () => {
    const grouped = [NAV_OVERVIEW_ROUTE, ...NAV_PRIMARY_ROUTES, NAV_SETTINGS_HUB_ROUTE];
    expect(grouped.map(r => r.href).sort()).toEqual(DASHBOARD_ROUTES.map(r => r.href).sort());
  });

  it('NAV_PRIMARY_ROUTES excludes every settings route, including the hub itself', () => {
    expect(NAV_PRIMARY_ROUTES.some(r => r.href.startsWith('/dashboard/settings'))).toBe(false);
    expect(NAV_PRIMARY_ROUTES.some(r => r.href === '/dashboard')).toBe(false);
  });
});
```

This test passes immediately once Step 1 is in place (there's no separate "red" state to force here —
the exports either group correctly or they don't; there's no intermediate implementation to write
after the fact). Run it to confirm it's green, not to see it fail first.

Run: `npx vitest run test/dashboardRoutesGrouping.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 3: Restructure `NavRail.tsx`**

Replace the file's contents:

```tsx
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
```

- [ ] **Step 4: Append the new nav styles to `app/globals.css`**

Replace the existing `.rail-link` rules:

```css
.rail-link {
  display: block;
  padding: 9px 12px;
  border-radius: var(--radius);
  color: var(--ink-dim);
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  transition: background 0.12s ease, color 0.12s ease;
}

.rail-link:hover {
  background: var(--surface-raised);
  color: var(--ink);
}

.rail-link[data-active='true'] {
  background: var(--surface-raised);
  color: var(--accent);
}
```

with:

```css
.rail-link {
  display: block;
  padding: 9px 12px;
  border-left: 2px solid transparent;
  color: var(--ink-dim);
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}

.rail-link:hover {
  background: var(--surface);
  color: var(--ink);
}

.rail-link[data-active='true'] {
  background: rgba(255, 79, 0, 0.08);
  color: var(--accent-bright);
  border-left-color: var(--accent);
}

.rail-divider {
  height: 1px;
  background: var(--border);
  margin: 8px 4px;
}
```

- [ ] **Step 5: Run the full test suite, tsc, and eslint**

Run: `npx vitest run && npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: all clean, including the new grouping test.

- [ ] **Step 6: Manually verify in a running dev server**

Run: `npm run dev`. Confirm: the rail shows Overview, then 9 tool links, then a visible divider, then
one "Settings" link (not the 5 individual settings pages) — 11 visible links total. Click Overview,
confirm only it highlights (not every page). The Settings hub page itself doesn't exist until Task 6,
so for this task's check, navigate directly by URL to `/dashboard/settings/ollama` and confirm the
"Settings" rail link shows active there too (not just on the hub's own exact URL).

- [ ] **Step 7: Commit**

```bash
git add lib/dashboardRoutes.ts app/components/NavRail.tsx app/globals.css test/dashboardRoutesGrouping.test.ts
git commit -m "feat: restructure the sidebar -- Overview, primary tools, collapsed Settings"
```

---

### Task 3: `JobService.getRecentlyResolved()`

**Files:**
- Modify: `lib/services/JobService.ts`
- Test: `test/jobServiceRecentlyResolved.test.ts`

**Interfaces:**
- Produces: `jobService.getRecentlyResolved(limit: number): Promise<Job[]>` — Task 4's activity-feed
  merge calls this.

- [ ] **Step 1: Write the failing test**

Create `test/jobServiceRecentlyResolved.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-jobrecentlyresolved-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

async function makeJobWithStatus(styleId: string, status: string, updatedAt: number) {
  const job = await jobService.create({ styleId, createdBy: 'user-1', assetType: 'sprite', prompt: `a ${status} job` });
  const db = DatabaseConnection.getInstance();
  db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, updatedAt, job.id);
  return job.id;
}

describe('JobService.getRecentlyResolved', () => {
  it('returns only promoted/discarded/failed jobs, not pending/processing', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const promotedId = await makeJobWithStatus(style.id, 'promoted', 3000);
    await makeJobWithStatus(style.id, 'pending', 4000);
    await makeJobWithStatus(style.id, 'processing', 5000);

    const result = await jobService.getRecentlyResolved(10);
    expect(result.map(j => j.id)).toEqual([promotedId]);
  });

  it('orders newest updated_at first', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const older = await makeJobWithStatus(style.id, 'failed', 1000);
    const newer = await makeJobWithStatus(style.id, 'discarded', 2000);

    const result = await jobService.getRecentlyResolved(10);
    expect(result.map(j => j.id)).toEqual([newer, older]);
  });

  it('respects the limit', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    await makeJobWithStatus(style.id, 'promoted', 1000);
    await makeJobWithStatus(style.id, 'promoted', 2000);
    await makeJobWithStatus(style.id, 'promoted', 3000);

    const result = await jobService.getRecentlyResolved(2);
    expect(result).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx vitest run test/jobServiceRecentlyResolved.test.ts`
Expected: FAIL with "jobService.getRecentlyResolved is not a function"

- [ ] **Step 3: Implement it**

Append to `lib/services/JobServiceImpl` in `lib/services/JobService.ts` (add as a new method inside
the class, alongside `getById`/`getActive`/`getByBatchId` — placement within the class doesn't matter,
but keep it near the other `get*` read methods for readability):

```ts
  /**
   * The most recently resolved jobs (promoted, discarded, or failed) --
   * unlike getActive()'s ACTIVE_WINDOW_MS, this has no time window at all,
   * just a row-count cap. Powers the dashboard Overview page's recent-
   * activity feed, a different consumer with a different need (a short
   * "what happened lately" list, not "what's still worth showing as active
   * in a live-polling queue").
   */
  async getRecentlyResolved(limit: number): Promise<Job[]> {
    const db = DatabaseConnection.getInstance();
    const rows = db.prepare(`
      SELECT * FROM jobs WHERE status IN ('promoted', 'discarded', 'failed')
      ORDER BY updated_at DESC LIMIT ?
    `).all(limit);
    return rows.map(row => JobSchema.parse(row));
  }
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npx vitest run test/jobServiceRecentlyResolved.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Run the full test suite, tsc, and eslint**

Run: `npx vitest run && npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add lib/services/JobService.ts test/jobServiceRecentlyResolved.test.ts
git commit -m "feat: add JobService.getRecentlyResolved() for the activity feed"
```

---

### Task 4: Recent-activity merge + route

**Files:**
- Create: `lib/services/recentActivity.ts`
- Create: `app/api/dashboard/activity/route.ts`
- Test: `test/recentActivity.test.ts`

**Interfaces:**
- Consumes: `jobService.getRecentlyResolved()` (Task 3), `styleService.getActiveStyles()` (existing).
- Produces: `getRecentActivity(): Promise<ActivityItem[]>`, and `GET /api/dashboard/activity` →
  `{success, data: ActivityItem[]}`. Task 6's Overview page calls the route.

- [ ] **Step 1: Write the failing test**

Create `test/recentActivity.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { getRecentActivity } from '@/lib/services/recentActivity';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-recentactivity-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('getRecentActivity', () => {
  it('returns an empty array when there is nothing to show', async () => {
    expect(await getRecentActivity()).toEqual([]);
  });

  it('merges resolved jobs and created styles, newest first', async () => {
    const style = await styleService.create({ name: 'Forest', createdBy: 'user-1', parameters: '{}' });
    const db = DatabaseConnection.getInstance();
    db.prepare('UPDATE styles SET created_at = ? WHERE id = ?').run(2000, style.id);

    const job = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: 'a goblin' });
    db.prepare(`UPDATE jobs SET status = 'promoted', updated_at = ? WHERE id = ?`).run(3000, job.id);

    const result = await getRecentActivity();
    expect(result.map(item => item.kind)).toEqual(['job', 'style']);
    expect(result[0].label).toContain('a goblin');
    expect(result[1].label).toContain('Forest');
  });

  it('caps the merged result at 8 items', async () => {
    const style = await styleService.create({ name: 'x', createdBy: 'user-1', parameters: '{}' });
    const db = DatabaseConnection.getInstance();
    for (let i = 0; i < 10; i++) {
      const job = await jobService.create({ styleId: style.id, createdBy: 'user-1', assetType: 'sprite', prompt: `job ${i}` });
      db.prepare(`UPDATE jobs SET status = 'promoted', updated_at = ? WHERE id = ?`).run(1000 + i, job.id);
    }
    const result = await getRecentActivity();
    expect(result).toHaveLength(8);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx vitest run test/recentActivity.test.ts`
Expected: FAIL with "Cannot find module '@/lib/services/recentActivity'"

- [ ] **Step 3: Implement the merge**

Create `lib/services/recentActivity.ts`:

```ts
import { jobService } from '@/lib/services/JobService';
import { styleService } from '@/lib/services/StyleService';

const ACTIVITY_FEED_LIMIT = 8;

export interface ActivityItem {
  id: string;
  kind: 'job' | 'style';
  label: string;
  timestamp: number;
}

function jobLabel(status: string, prompt: string): string {
  if (status === 'promoted') return `Promoted "${prompt}"`;
  if (status === 'discarded') return `Discarded "${prompt}"`;
  return `Generation failed: "${prompt}"`;
}

/**
 * Derived, not logged -- GameForge has no activity-log table and this
 * doesn't add one (see the design spec for why). Merges the most recently
 * resolved jobs with the most recently created styles by timestamp, capped
 * at ACTIVITY_FEED_LIMIT total.
 */
export async function getRecentActivity(): Promise<ActivityItem[]> {
  const [jobs, styles] = await Promise.all([
    jobService.getRecentlyResolved(ACTIVITY_FEED_LIMIT),
    styleService.getActiveStyles(),
  ]);

  const jobItems: ActivityItem[] = jobs.map(job => ({
    id: job.id,
    kind: 'job',
    label: jobLabel(job.status, job.prompt),
    timestamp: job.updated_at,
  }));

  const styleItems: ActivityItem[] = styles.slice(0, ACTIVITY_FEED_LIMIT).map(style => ({
    id: style.id,
    kind: 'style',
    label: `Created Style Bible "${style.name}"`,
    timestamp: style.created_at,
  }));

  return [...jobItems, ...styleItems]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, ACTIVITY_FEED_LIMIT);
}
```

- [ ] **Step 4: Implement the route**

Create `app/api/dashboard/activity/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { getRecentActivity } from '@/lib/services/recentActivity';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const data = await getRecentActivity();
    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
```

- [ ] **Step 5: Run the test, confirm it passes**

Run: `npx vitest run test/recentActivity.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 6: Run the full test suite, tsc, and eslint**

Run: `npx vitest run && npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add lib/services/recentActivity.ts app/api/dashboard/activity/route.ts test/recentActivity.test.ts
git commit -m "feat: add the recent-activity feed (derived, not logged) + its route"
```

---

### Task 5: Overview page + root redirect

**Files:**
- Modify: `app/dashboard/page.tsx` (currently a redirect to `/dashboard/generate`)
- Modify: `app/page.tsx` (currently a redirect to `/dashboard/generate`)
- Modify: `app/globals.css` (append stat-card and activity-row styles)

**Interfaces:**
- Consumes: `GET /api/context` (existing), `GET /api/dashboard/activity` (Task 4).

No automated test for this task's page component — matches this codebase's established, deliberate
convention (see Global Constraints); verified manually in a running dev server.

- [ ] **Step 1: Append the new component styles to `app/globals.css`**

```css
.stat-cards {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
  flex-wrap: wrap;
}

.stat-card-label {
  font-size: 12px;
  color: var(--accent-2);
  margin-bottom: 8px;
}

.stat-card-value {
  font-family: var(--font-display);
  font-size: 32px;
  font-weight: 700;
}

.activity-row {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 14px;
  font-size: 13px;
  margin-bottom: 8px;
}

.activity-row-meta {
  color: var(--ink-faint);
  font-size: 11px;
  margin-top: 2px;
}
```

- [ ] **Step 2: Replace `app/dashboard/page.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface ContextData {
  styles: { id: string; name: string; assetCount: number }[];
  totalActiveAssets: number;
  inFlightJobs: number;
}

interface ActivityItem {
  id: string;
  kind: 'job' | 'style';
  label: string;
  timestamp: number;
}

export default function OverviewPage() {
  const [context, setContext] = useState<ContextData | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const [contextRes, activityRes] = await Promise.all([
          fetch('/api/context'),
          fetch('/api/dashboard/activity'),
        ]);
        const contextBody = await contextRes.json();
        const activityBody = await activityRes.json();
        if (!ignore) {
          if (contextBody.success) setContext(contextBody.data);
          if (activityBody.success) setActivity(activityBody.data);
        }
      } catch {
        // Non-fatal -- the page just shows zeros/an empty activity list.
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => { ignore = true; };
  }, []);

  return (
    <>
      <h1 className="page-title">Overview</h1>
      <p className="page-subtitle">Studio operations at a glance.</p>

      <div className="stat-cards">
        <div className="card" style={{ flex: 1, minWidth: 140 }}>
          <div className="stat-card-label">Active styles</div>
          <div className="stat-card-value">{loading ? '—' : context?.styles.length ?? 0}</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 140 }}>
          <div className="stat-card-label">Total assets</div>
          <div className="stat-card-value">{loading ? '—' : context?.totalActiveAssets ?? 0}</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 140 }}>
          <div className="stat-card-label">Jobs in flight</div>
          <div className="stat-card-value">{loading ? '—' : context?.inFlightJobs ?? 0}</div>
        </div>
      </div>

      <h2 className="frame-label" style={{ marginBottom: 12 }}>Quick actions</h2>
      <div style={{ display: 'flex', gap: 10, marginBottom: 32, flexWrap: 'wrap' }}>
        <Link href="/dashboard/generate" className="btn btn-primary">Generate a sprite</Link>
        <Link href="/dashboard/styles" className="btn">New Style Bible</Link>
        <Link href="/dashboard/settings/ollama" className="btn">Ollama settings</Link>
      </div>

      <h2 className="frame-label" style={{ marginBottom: 12 }}>Recent activity</h2>
      {!loading && activity.length === 0 ? (
        <div className="empty-state">No recent activity yet. Generate something to see it here.</div>
      ) : (
        <div>
          {activity.map(item => (
            <div key={item.id} className="activity-row">
              <div>{item.label}</div>
              <div className="activity-row-meta">{new Date(item.timestamp).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 3: Update `app/page.tsx`'s redirect**

```tsx
import { redirect } from 'next/navigation';

export default function RootPage() {
  redirect('/dashboard');
}
```

- [ ] **Step 4: Run the full test suite, tsc, and eslint**

Run: `npx vitest run && npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: all clean.

- [ ] **Step 5: Manually verify in a running dev server**

Run: `npm run dev`. Visit `/` — confirm it redirects to `/dashboard` (not `/dashboard/generate`).
Confirm `/dashboard` shows real stat-card numbers matching your actual project data, the three quick-
action links work, and the activity feed shows real recent jobs/styles (or the empty state, if you
have none yet) with correctly formatted timestamps.

- [ ] **Step 6: Commit**

```bash
git add app/dashboard/page.tsx app/page.tsx app/globals.css
git commit -m "feat: add the Overview landing page, redirect root to it"
```

---

### Task 6: Settings hub page

**Files:**
- Create: `app/dashboard/settings/page.tsx`
- Modify: `app/globals.css` (append `.settings-item` styles)

**Interfaces:**
- Consumes: nothing dynamic — pure static navigation, descriptions copied from each linked page's own
  real `page-subtitle` text (same "reuse the app's own copy" approach as the AI copilot's knowledge
  doc).

No automated test — pure static markup, verified manually.

- [ ] **Step 1: Append the settings-list styles to `app/globals.css`**

```css
.settings-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 16px;
  margin-bottom: 8px;
  text-decoration: none;
  color: var(--ink);
}

.settings-item:hover {
  border-color: var(--accent-dim);
}

.settings-item-desc {
  color: var(--ink-dim);
  font-size: 12px;
  margin-top: 2px;
}
```

- [ ] **Step 2: Create the hub page**

Create `app/dashboard/settings/page.tsx`:

```tsx
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
```

- [ ] **Step 3: Run the full test suite, tsc, and eslint**

Run: `npx vitest run && npx tsc --noEmit && npx eslint app lib worker.ts`
Expected: all clean.

- [ ] **Step 4: Manually verify in a running dev server**

Run: `npm run dev`, click "Settings" in the sidebar, confirm all 5 rows are present and each link
navigates to the correct real page.

- [ ] **Step 5: Commit**

```bash
git add app/dashboard/settings/page.tsx app/globals.css
git commit -m "feat: add the Settings hub page"
```

---

### Task 7: Update the AI copilot's knowledge doc

**Files:**
- Modify: `docs/copilot-knowledge.md`

**Interfaces:**
- No code interface — this is content the AI copilot's system prompt includes verbatim (see
  `lib/services/copilotSystemPrompt.ts`, unchanged by this task).

No automated test — matches how the original knowledge doc content was added (Task 7 of the AI-copilot
plan) with no dedicated test of its prose, only of the prompt-assembly mechanism around it, which this
task doesn't touch.

- [ ] **Step 1: Add two new entries**

In `docs/copilot-knowledge.md`, add this entry immediately after the file's opening paragraph and
before the existing `## Generate` section:

```markdown
## Overview (`/dashboard`)
Your studio at a glance: how many active Style Bibles, how many total assets, how many jobs are still
in flight, quick links to start a generation or open Ollama settings, and a feed of what happened
recently (promotions, discards, failures, new Style Bibles). This is the dashboard's landing page.
```

And add this entry immediately before the existing `## Settings → Storage` section:

```markdown
## Settings (`/dashboard/settings`)
A hub linking to the 5 settings pages below (Storage, Aseprite, Seed Themes, Google Drive, Ollama) —
not a settings page itself, just a directory to them. If asked to "open settings" without a specific
one named, this is the right page; a specific settings page name should go straight to that page
instead.
```

- [ ] **Step 2: Manually verify**

No automated check applies to prose content. If Claude or an Ollama model is configured
(`ANTHROPIC_API_KEY`/`CHEAPERINFERENCE_API_KEY`, or a running Ollama daemon), open the copilot panel
and ask "what's the overview page for?" — confirm the reply reflects the new entry rather than saying
it doesn't know. Also ask it to "take me to Ollama settings" — confirm it navigates straight to
`/dashboard/settings/ollama`, not to the `/dashboard/settings` hub (per the spec's testing section:
the hub is for an ambiguous "open settings" request, a specific named page should go straight there).

- [ ] **Step 3: Commit**

```bash
git add docs/copilot-knowledge.md
git commit -m "docs: add Overview and Settings hub entries to the copilot knowledge doc"
```

---

## After all tasks: final verification

- [ ] Run `npx vitest run && npx tsc --noEmit && npx eslint app lib worker.ts` one more time on the
  full branch.
- [ ] Manual pass through the whole app in a browser: every dashboard page still renders correctly
  under the new palette (spot-check a few beyond what earlier tasks already checked — Jobs, Assets,
  Style Bibles), the AI copilot panel still looks correct against the new colors, and login/logout
  still work (the `useCurrentUser` pathname-refetch fix from the earlier AI-copilot plan is unrelated
  to this refresh but worth a quick re-confirmation given how much of the shared layout changed).
- [ ] Per `AGENTS.md` item 4: run a DeepSeek diff review (Mode 2) on the whole branch's diff before
  opening a PR, in addition to the per-task reviews during execution — and this time, actually run it
  during task execution too (per this session's own logged process gap), not only retroactively.
