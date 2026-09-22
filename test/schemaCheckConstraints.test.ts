// test/schemaCheckConstraints.test.ts
//
// Migration 016 hardcoded copilot_messages.provider's CHECK constraint to
// ('claude', 'ollama') independently of the Zod enum in schema.ts -- when
// the Zod side was later widened to add 'openrouter', the SQL side silently
// didn't follow, and the drift was only caught by live manual browser
// testing (see migration 019 and the OpenRouter integration PRs). This test
// closes that class of bug generically: it discovers every `CHECK (col IN
// (...))` constraint in the REAL post-migration schema (not the migration
// files themselves, which can't tell you the current column value without
// tracking which migration last touched it) and cross-checks each one
// against a matching Zod enum.
//
// A CHECK constraint found in the live schema with no entry in
// KNOWN_CHECK_MAPPINGS below fails the test loudly, rather than being
// silently skipped -- this is what makes the test future-proof: adding a
// new CHECK-constrained enum column without registering it here is a
// failure, not a gap nobody notices until it breaks live.
import { describe, it, expect, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { JobStatusSchema, OutputKindSchema, CopilotMessageSchema } from '@/lib/database/schema';

const REAL_MIGRATIONS_DIR = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');

const KNOWN_CHECK_MAPPINGS: Array<{ table: string; column: string; zodValues: readonly string[] }> = [
  { table: 'jobs', column: 'status', zodValues: JobStatusSchema.options },
  { table: 'jobs', column: 'output_kind', zodValues: OutputKindSchema.options },
  { table: 'assets', column: 'output_kind', zodValues: OutputKindSchema.options },
  { table: 'copilot_messages', column: 'role', zodValues: CopilotMessageSchema.shape.role.options },
  { table: 'copilot_messages', column: 'provider', zodValues: CopilotMessageSchema.shape.provider.unwrap().options },
];

// Matches `<col> TEXT ... CHECK (<col> IN ('a', 'b', ...))` -- the exact
// shape every migration in this project uses for an enum-like column.
// `[^,]` (not `.`) between TEXT and CHECK so it still matches across the
// newlines SQLite preserves verbatim in sqlite_master.sql.
const CHECK_PATTERN = /(\w+)\s+TEXT[^,]*?\bCHECK\s*\(\s*\1\s+IN\s*\(([^)]+)\)\)/gi;

function extractCheckedColumns(createTableSql: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const match of createTableSql.matchAll(CHECK_PATTERN)) {
    const [, column, rawValues] = match;
    const values = rawValues.split(',').map(v => v.trim().replace(/^'|'$/g, ''));
    found.set(column, values);
  }
  return found;
}

let tempRoot: string;

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('SQL CHECK constraints match their Zod enum counterparts', () => {
  it('every CHECK (col IN (...)) in the live schema is registered and in sync with schema.ts', async () => {
    tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-checkconstraints-'));
    await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'gameforge-test' }));
    const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
    await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
    const migrationFiles = (await fsPromises.readdir(REAL_MIGRATIONS_DIR)).filter(f => f.endsWith('.sql'));
    for (const file of migrationFiles) {
      await fsPromises.copyFile(path.join(REAL_MIGRATIONS_DIR, file), path.join(tempMigrationsDir, file));
    }

    setProjectRootForTests(tempRoot);
    const db = DatabaseConnection.getInstance();

    const tables = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL`).all() as Array<{ name: string; sql: string }>;

    const knownKeys = new Set(KNOWN_CHECK_MAPPINGS.map(m => `${m.table}.${m.column}`));
    const discoveredKeys = new Set<string>();

    for (const table of tables) {
      const checked = extractCheckedColumns(table.sql);
      for (const [column, sqlValues] of checked) {
        const key = `${table.name}.${column}`;
        discoveredKeys.add(key);
        expect(knownKeys.has(key), `${key} has a CHECK constraint but no entry in KNOWN_CHECK_MAPPINGS -- add one so it's checked against its Zod enum`).toBe(true);
      }
    }

    for (const mapping of KNOWN_CHECK_MAPPINGS) {
      const key = `${mapping.table}.${mapping.column}`;
      expect(discoveredKeys.has(key), `${key} is registered in KNOWN_CHECK_MAPPINGS but no CHECK constraint was found for it in the live schema -- update or remove this mapping`).toBe(true);

      const checked = extractCheckedColumns(tables.find(t => t.name === mapping.table)!.sql);
      const sqlValues = checked.get(mapping.column)!;
      expect(new Set(sqlValues), `${key}: SQL CHECK values must match the Zod enum in schema.ts`).toEqual(new Set(mapping.zodValues));
    }
  });
});
