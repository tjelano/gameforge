import { z } from 'zod';
import { DASHBOARD_ROUTES } from '@/lib/dashboardRoutes';

export const NAVIGATE_TOOL_NAME = 'navigate_to_page';

const ROUTE_HREFS = DASHBOARD_ROUTES.map(r => r.href);

// z.enum's typed overload wants a non-empty tuple, not string[] -- DASHBOARD_ROUTES
// is a fixed, always-non-empty list, so this cast is safe.
export const NavigateToPageInputSchema = z.object({
  path: z.enum(ROUTE_HREFS as [string, ...string[]]),
});

/** The shared return shape for both callClaudeMessage() and callOllamaMessage() (Tasks 5-6). */
export interface ProviderMessageResult {
  text: string;
  toolCall?: { name: string; input: unknown };
}

export function buildNavigateTool() {
  return {
    name: NAVIGATE_TOOL_NAME,
    description: 'Navigate the user to a specific page in the GameForge dashboard.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', enum: ROUTE_HREFS, description: 'The dashboard route to navigate to.' },
      },
      required: ['path'],
    },
  };
}
