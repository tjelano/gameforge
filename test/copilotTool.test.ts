import { describe, it, expect } from 'vitest';
import { DASHBOARD_ROUTES } from '@/lib/dashboardRoutes';
import { buildNavigateTool, NavigateToPageInputSchema, NAVIGATE_TOOL_NAME } from '@/lib/services/copilotTool';

describe('copilot navigate_to_page tool', () => {
  it('builds a tool schema whose path enum matches DASHBOARD_ROUTES exactly', () => {
    const tool = buildNavigateTool();
    expect(tool.name).toBe(NAVIGATE_TOOL_NAME);
    expect((tool.inputSchema.properties as any).path.enum).toEqual(DASHBOARD_ROUTES.map(r => r.href));
  });

  it('accepts any real dashboard route', () => {
    const result = NavigateToPageInputSchema.safeParse({ path: '/dashboard/settings/ollama' });
    expect(result.success).toBe(true);
  });

  it('rejects a path outside the static route list', () => {
    const result = NavigateToPageInputSchema.safeParse({ path: '/dashboard/jobs/123/edit' });
    expect(result.success).toBe(false);
  });
});
