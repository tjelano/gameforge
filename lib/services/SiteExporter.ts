import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { pageService } from '@/lib/services/PageService';
import { assetService } from '@/lib/services/AssetService';
import { parseComponentHtml } from '@/lib/services/componentDocument';
import { sanitizeComponentHtml, sanitizeComponentCss } from '@/lib/services/componentSanitize';
import { parseThemeCss } from '@/lib/services/ThemeGenerator';
import { tokensToTailwindTheme } from '@/lib/services/themeExport/tailwindExporter';
import { htmlToJsx, escapeJsxText } from '@/lib/services/siteExportDocument';
import { scopeComponentCss } from '@/lib/services/pageDocument';
import type { Page, Asset } from '@/lib/database/schema';

// The literal CSS-Module class name every component's wrapper element
// carries - a fixed, predictable name is fine since it's scoped to that
// one component's own .module.css file (no cross-component collision
// risk; CSS Modules hashes it uniquely per file regardless).
const COMPONENT_SCOPE_CLASS = 'root';

export interface SiteExportResult {
  pagesExported: number;
  componentsExported: number;
  targetDir: string;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// asset_type is free text typed by the user (PresetForm.tsx's "component
// type" field is a plain <input>, not a dropdown) - it can contain
// anything, including characters that are NOT safe in a JS identifier or
// a Windows filename. Two real, verified failure modes if this only
// stripped separator characters (a "-"/"_"/whitespace-only replace,
// which was this plan's own earlier, buggy draft):
//   1. A name starting with a digit after stripping (e.g. "2-column
//      footer" -> "2ColumnFooter") produces an invalid JS identifier -
//      confirmed with a real tsc compile: TS1003/TS1005/TS1351.
//   2. A name containing a colon (e.g. "FAQ: how it works") is even
//      worse on Windows (this project's own dev platform): a colon in a
//      filename doesn't throw on write - NTFS silently treats it as an
//      Alternate-Data-Stream separator, so fs.writeFile "succeeds" but
//      creates a 0-byte file with the real content hidden in an
//      invisible stream. Confirmed with a real fs.writeFileSync test.
// The fix: strip EVERYTHING outside [A-Za-z0-9] (not just common
// separators), and guard against a leading digit explicitly.
function pascalCase(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const pascal = words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  if (!pascal) return 'Component';
  return /^[0-9]/.test(pascal) ? `C${pascal}` : pascal;
}

function componentName(asset: Asset): string {
  return `${pascalCase(asset.asset_type)}${asset.id.replace(/-/g, '').slice(0, 6)}`;
}

interface ConvertedComponent {
  asset: Asset;
  componentName: string;
  jsx: string;
  css: string;
}

// Mirrors the route's own Zod validation - re-checked here too so this
// public method is safe regardless of caller (the route is the only
// current caller, but a future direct caller - a script, a test, another
// route - must not be able to bypass this and path-traverse via subdir).
const SUBDIR_PATTERN = /^[a-z0-9-]+$/;

class SiteExporterImpl {
  async exportSite(styleId: string, subdir: string): Promise<SiteExportResult | { error: 'NOTHING_TO_EXPORT' | 'ALREADY_EXISTS' | 'INVALID_SUBDIR' }> {
    if (!SUBDIR_PATTERN.test(subdir)) {
      return { error: 'INVALID_SUBDIR' };
    }

    const pagesNewestFirst = await pageService.getActivePagesForStyle(styleId);
    if (pagesNewestFirst.length === 0) {
      return { error: 'NOTHING_TO_EXPORT' };
    }
    // getActivePagesForStyle returns newest-first (ORDER BY created_at
    // DESC) - reverse to oldest-first so pages[0] is the home page and
    // the nav lists pages in creation order.
    const pages: Page[] = [...pagesNewestFirst].reverse();

    const exportsRootDir = path.join(getProjectRoot(), 'storage', 'exports');
    try {
      // Defensive - don't depend on setup.sh/setup.bat having created this
      // parent dir already, matches GitService.ensureDirectoriesExist()'s
      // own defensive mkdir pattern for storage/images etc.
      await fsPromises.mkdir(exportsRootDir, { recursive: true });
    } catch (e) {
      console.error(`Failed to create the exports root directory ${exportsRootDir}:`, e);
      throw e;
    }

    const targetDir = path.join(getProjectRoot(), 'storage', 'exports', subdir);
    try {
      // A single atomic mkdir (non-recursive) IS the existence check - it
      // either creates targetDir and we own it, or fails with EEXIST because
      // someone else's request already created it. This closes a real race:
      // the previous check (fsPromises.access, then a *recursive* mkdir much
      // later) had a window where two concurrent exports of the same subdir
      // could both pass the access check - recursive:true never throws EEXIST
      // even if targetDir now exists - and interleave writes into one folder.
      await fsPromises.mkdir(targetDir);
    } catch (e: any) {
      if (e?.code === 'EEXIST') return { error: 'ALREADY_EXISTS' };
      // Anything else (e.g. EACCES) is a real problem this must not
      // silently proceed past, since that would lead to a much less clear
      // failure later (a raw mkdir/writeFile error) instead of surfacing
      // the real cause here.
      console.error(`Failed to create export target directory ${targetDir}:`, e);
      throw e;
    }

    const componentsByAssetId = new Map<string, ConvertedComponent>();
    const pageComponentNames: string[][] = [];

    for (const page of pages) {
      const assetIds = JSON.parse(page.component_asset_ids) as string[];
      const namesForThisPage: string[] = [];
      for (const assetId of assetIds) {
        if (!componentsByAssetId.has(assetId)) {
          const converted = await this.convertComponent(assetId, page.id);
          if (!converted) continue;
          componentsByAssetId.set(assetId, converted);
        }
        namesForThisPage.push(componentsByAssetId.get(assetId)!.componentName);
      }
      pageComponentNames.push(namesForThisPage);
    }

    const components = [...componentsByAssetId.values()];

    try {
      await fsPromises.mkdir(path.join(targetDir, 'app'), { recursive: true });
      await fsPromises.mkdir(path.join(targetDir, 'components'), { recursive: true });

      for (const component of components) {
        await fsPromises.writeFile(
          path.join(targetDir, 'components', `${component.componentName}.tsx`),
          this.buildComponentFile(component)
        );
        await fsPromises.writeFile(
          path.join(targetDir, 'components', `${component.componentName}.module.css`),
          component.css
        );
      }

      const themeCss = await assetService.loadThemeCssForStyle(styleId);
      let themeBlock = '';
      if (themeCss) {
        try {
          themeBlock = tokensToTailwindTheme(parseThemeCss(themeCss));
        } catch (e) {
          console.error(`Could not convert theme CSS to Tailwind theme for style ${styleId}, exporting without it:`, e);
        }
      }
      await fsPromises.writeFile(
        path.join(targetDir, 'app', 'globals.css'),
        `@import "tailwindcss";\n\n${themeBlock}${this.buildThemeAliasBlock(themeBlock)}`
      );

      const slugs = this.buildPageSlugs(pages);
      await fsPromises.writeFile(path.join(targetDir, 'app', 'layout.tsx'), this.buildLayoutFile(pages, slugs));
      await fsPromises.writeFile(path.join(targetDir, 'app', 'page.tsx'), this.buildPageFile(pages[0], pageComponentNames[0], components));

      for (let i = 1; i < pages.length; i++) {
        const pageDir = path.join(targetDir, 'app', slugs[i]);
        await fsPromises.mkdir(pageDir, { recursive: true });
        await fsPromises.writeFile(path.join(pageDir, 'page.tsx'), this.buildPageFile(pages[i], pageComponentNames[i], components));
      }

      await fsPromises.writeFile(path.join(targetDir, 'package.json'), this.buildPackageJson());
      await fsPromises.writeFile(path.join(targetDir, 'tsconfig.json'), this.buildTsConfig());
      await fsPromises.writeFile(path.join(targetDir, 'postcss.config.mjs'), this.buildPostcssConfig());
    } catch (e) {
      console.error(`Failed to write exported site files to ${targetDir}:`, e);
      throw e;
    }

    return { pagesExported: pages.length, componentsExported: components.length, targetDir };
  }

  private async convertComponent(assetId: string, pageId: string): Promise<ConvertedComponent | null> {
    try {
      const asset = await assetService.getById(assetId);
      if (!asset || asset.is_deleted || asset.output_kind !== 'component' || !asset.image_path) {
        console.error(`Page ${pageId} references a stale/invalid component asset ${assetId}, skipping`);
        return null;
      }
      const filename = asset.image_path;
      if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        console.error(`Page ${pageId} references a component asset ${assetId} with an unsafe filename, skipping`);
        return null;
      }
      const document = await fsPromises.readFile(path.join(getProjectRoot(), 'storage', 'components', filename), 'utf-8');
      const tokens = parseComponentHtml(document);
      const html = sanitizeComponentHtml(tokens.html);
      // scopeComponentCss runs AFTER sanitization (it needs real, trusted
      // CSS to parse) and BEFORE this CSS is ever written to a
      // .module.css file. Next's CSS Modules compiler runs in "pure"
      // mode, which REJECTS any selector with no local class (confirmed
      // by actually running Next's own vendored
      // postcss-modules-local-by-default plugin: `button{}`, `a:hover{}`,
      // `*{}`, `:root{}` all fail; `.btn`, `.nav a` pass) -
      // sanitizeComponentCss validates functions/at-rules but never
      // selectors, so an LLM-emitted bare-tag/universal/pseudo-class rule
      // reaches here unchanged and would otherwise break the exported
      // project's build. Prefixing every selector with a real local
      // class (this function, reused unchanged from Page Composer's
      // already-shipped, already-tested scoping logic) is the ONLY
      // verified-working fix - wrapping bare selectors in `:global(...)`
      // does NOT work (confirmed by actually running the same real
      // compiler against that approach: :global() explicitly marks its
      // contents non-local, so the rule still has zero local selectors
      // and still fails identically). buildComponentFile below wraps the
      // component's JSX in a real element carrying this same scope
      // class, matching what this CSS now expects to be nested under.
      const css = scopeComponentCss(sanitizeComponentCss(tokens.css), COMPONENT_SCOPE_CLASS);
      return { asset, componentName: componentName(asset), jsx: htmlToJsx(html), css };
    } catch (e) {
      console.error(`Failed to convert component asset ${assetId} for export, skipping:`, e);
      return null;
    }
  }

  private buildComponentFile(component: ConvertedComponent): string {
    // Wraps in a real element (not a bare Fragment) carrying the same
    // scope class scopeComponentCss prefixed every selector in this
    // component's CSS with - the wrapper is what makes ".root button"
    // (etc.) actually match something in the rendered DOM. A <div> is a
    // safe, neutral choice regardless of the component's own top-level
    // tag (nav/button/section/...): it adds no semantics of its own and
    // doesn't hide the wrapped element's own semantics from assistive
    // tech (e.g. a wrapped <nav> is still a real nav landmark).
    return `import styles from './${component.componentName}.module.css';

export function ${component.componentName}() {
  return (
    <div className={styles.${COMPONENT_SCOPE_CLASS}}>
${component.jsx}
    </div>
  );
}
`;
  }

  private buildPageSlugs(pages: Page[]): string[] {
    const used = new Set<string>();
    return pages.map((page, i) => {
      if (i === 0) return ''; // home page has no slug directory
      let slug = slugify(page.name) || 'page';
      if (used.has(slug)) {
        slug = `${slug}-${page.id.replace(/-/g, '').slice(0, 6)}`;
      }
      used.add(slug);
      return slug;
    });
  }

  private buildLayoutFile(pages: Page[], slugs: string[]): string {
    // page.name is free text (z.string().min(1), no character
    // restriction - app/api/styles/[id]/pages/route.ts) and must be
    // escaped the same way htmlToJsx escapes component text content: an
    // unescaped "<"/">"/"{"/"}" in a page name is a real tsc syntax
    // error (confirmed: TS17008 for an unclosed-looking "<Tag>" inside
    // raw JSX text), and this codebase's own domain (game asset naming,
    // e.g. "HP < 50%") makes such names plausible, not exotic.
    const links = pages.map((page, i) => {
      const href = i === 0 ? '/' : `/${slugs[i]}`;
      return `        <a href="${href}">${escapeJsxText(page.name)}</a>`;
    }).join('\n');
    return `import './globals.css';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav style={{ display: 'flex', gap: 16, padding: 16 }}>
${links}
        </nav>
        {children}
      </body>
    </html>
  );
}
`;
  }

  private buildPageFile(page: Page, componentNames: string[], allComponents: ConvertedComponent[]): string {
    const usedComponents = allComponents.filter(c => componentNames.includes(c.componentName));
    const imports = usedComponents.map(c => `import { ${c.componentName} } from '@/components/${c.componentName}';`).join('\n');
    const elements = componentNames.map(name => `      <${name} />`).join('\n');
    return `${imports}

export default function Page() {
  return (
    <>
${elements}
    </>
  );
}
`;
  }

  // Confirmed against Tailwind v4's own Next.js setup guide: @import
  // "tailwindcss" alone does nothing without @tailwindcss/postcss wired
  // into a postcss.config.mjs (see buildPostcssConfig below) - without
  // it, Next.js never runs Tailwind's PostCSS transform at all, so the
  // @theme block in globals.css passes through as literal, unrecognized
  // CSS and every token in it is silently dropped by the browser.
  // Confirmed by actually running the exported project and inspecting
  // the served CSS, not just by reading Tailwind's docs.
  private buildPackageJson(): string {
    return JSON.stringify({
      name: 'exported-site',
      version: '0.1.0',
      private: true,
      scripts: {
        dev: 'next dev',
        build: 'next build',
        start: 'next start',
      },
      dependencies: {
        next: '^16.3.4',
        react: '^19.1.0',
        'react-dom': '^19.1.0',
        tailwindcss: '^4.0.0',
      },
      devDependencies: {
        typescript: '^5.7.2',
        '@types/react': '^19.0.0',
        '@types/react-dom': '^19.0.0',
        '@types/node': '^24.0.0',
        postcss: '^8.5.28',
        '@tailwindcss/postcss': '^4.0.0',
      },
    }, null, 2);
  }

  private buildPostcssConfig(): string {
    return `const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
`;
  }

  // tokensToTailwindTheme (themeExport/tailwindExporter.ts) is shared with
  // the single-asset "download as Tailwind CSS" export route, which
  // deliberately uses Tailwind's own idiomatic variable names
  // (--color-background/--color-foreground/--spacing) so utilities like
  // bg-background generate for a user pasting the file into their own
  // Tailwind project - that contract has its own test
  // (test/assetExportRoute.test.ts) and must not change here.
  // But every real component's CSS (MockComponentGenerator.ts, and the
  // LLM tool-schema description in ComponentGenerator.ts) references the
  // PRE-EXISTING GameForge variable names instead: --color-bg, --color-fg,
  // --space-unit (colorAccent/colorBorder/fontHeading/fontBody/radiusBase
  // already match by coincidence). SiteExporter copies that component CSS
  // into the exported project verbatim, unrenamed - so without this alias
  // block, every exported component's background, text color, and
  // padding/margin/gap silently resolve to nothing. Confirmed by actually
  // exporting a themed style, running the exported project, and observing
  // an unstyled page - not just by reading the two files side by side.
  private buildThemeAliasBlock(themeBlock: string): string {
    if (!themeBlock) return '';
    return `:root {
  --color-bg: var(--color-background);
  --color-fg: var(--color-foreground);
  --space-unit: var(--spacing);
}
`;
  }

  private buildTsConfig(): string {
    return JSON.stringify({
      compilerOptions: {
        target: 'ES2017',
        lib: ['dom', 'dom.iterable', 'esnext'],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: 'preserve',
        incremental: true,
        paths: { '@/*': ['./*'] },
      },
      include: ['**/*.ts', '**/*.tsx'],
      exclude: ['node_modules'],
    }, null, 2);
  }
}

export const siteExporter = new SiteExporterImpl();
