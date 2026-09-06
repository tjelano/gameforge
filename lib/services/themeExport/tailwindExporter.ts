import type { ThemeTokens } from '@/lib/services/ThemeGenerator';

// Variable names verified directly against Tailwind v4's current documentation
// (tailwindcss.com/docs/theme): --color-* generates bg-*/text-*/border-*
// utilities, --spacing is a single base multiplier for the whole numeric
// spacing scale, --radius-* generates rounded-*, --font-* generates font-*.
export function tokensToTailwindTheme(tokens: ThemeTokens): string {
  return `/* Requires: @import "tailwindcss"; above this file (or in your main CSS entry point). */
/* Note: --spacing below replaces Tailwind's default base spacing unit project-wide. */
@theme {
  --color-background: ${tokens.colorBackground};
  --color-foreground: ${tokens.colorForeground};
  --color-accent: ${tokens.colorAccent};
  --color-border: ${tokens.colorBorder};
  --font-heading: ${tokens.fontHeading};
  --font-body: ${tokens.fontBody};
  --spacing: ${tokens.spaceUnit};
  --radius-base: ${tokens.radiusBase};
}
`;
}
