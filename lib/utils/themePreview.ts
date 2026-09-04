// lib/utils/themePreview.ts

/**
 * A complete, standalone HTML document for the theme-review iframe — see
 * the design spec's "Review and promotion" section for why this MUST be
 * an iframe (a separate document) rather than injected into the
 * dashboard's own DOM: the generated CSS sets :root variables that would
 * otherwise override GameForge's own theme variables.
 *
 * Every element here references only var(--...) — none of these variable
 * NAMES are invented by this file; they match exactly what
 * ThemeGenerator.tokensToCss() writes (--color-bg, --color-fg,
 * --color-accent, --color-border, --font-heading, --font-body,
 * --space-unit, --radius-base). Contains no <script> tags by design —
 * every caller renders this inside a sandbox="" iframe, which disables
 * script execution entirely.
 */
export function buildThemePreviewHtml(cssUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="${cssUrl}">
<style>
  body {
    margin: 0;
    padding: calc(var(--space-unit) * 3);
    background: var(--color-bg);
    color: var(--color-fg);
    font-family: var(--font-body);
  }
  h1 {
    font-family: var(--font-heading);
    margin: 0 0 var(--space-unit) 0;
  }
  p {
    margin: 0 0 calc(var(--space-unit) * 2) 0;
  }
  nav {
    display: flex;
    gap: var(--space-unit);
    padding-bottom: calc(var(--space-unit) * 2);
    margin-bottom: calc(var(--space-unit) * 2);
    border-bottom: 1px solid var(--color-border);
  }
  nav a {
    color: var(--color-fg);
    text-decoration: none;
  }
  .card {
    padding: calc(var(--space-unit) * 2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-base);
    margin-bottom: calc(var(--space-unit) * 2);
  }
  button {
    font-family: var(--font-body);
    padding: calc(var(--space-unit) * 0.75) calc(var(--space-unit) * 1.5);
    border-radius: var(--radius-base);
    border: 1px solid var(--color-border);
    cursor: pointer;
  }
  .btn-primary {
    background: var(--color-accent);
    color: var(--color-bg);
    border: none;
  }
  .btn-secondary {
    background: transparent;
    color: var(--color-fg);
  }
</style>
</head>
<body>
  <nav>
    <a href="#">Home</a>
    <a href="#">About</a>
    <a href="#">Contact</a>
  </nav>
  <h1>Sample heading</h1>
  <p>A sample paragraph of body text, styled by the generated theme.</p>
  <div class="card">
    <p style="margin: 0;">A sample card, for spacing and border-radius.</p>
  </div>
  <button class="btn-primary">Primary action</button>
  <button class="btn-secondary">Secondary action</button>
</body>
</html>`;
}
