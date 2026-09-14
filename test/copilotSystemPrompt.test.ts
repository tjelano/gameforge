import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { buildCopilotSystemPrompt } from '@/lib/services/copilotSystemPrompt';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-copilotprompt-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  await fsPromises.mkdir(path.join(tempRoot, 'docs'), { recursive: true });
  await fsPromises.writeFile(path.join(tempRoot, 'docs', 'copilot-knowledge.md'), '# Test knowledge doc\n\nThemes live at /dashboard/themes.');
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('buildCopilotSystemPrompt', () => {
  it('includes the knowledge doc, live project state, and the escalation instruction', async () => {
    const prompt = await buildCopilotSystemPrompt();
    expect(prompt).toContain('Themes live at /dashboard/themes.');
    expect(prompt).toContain('"styles"');
    expect(prompt).toContain('"inFlightJobs"');
    expect(prompt.toLowerCase()).toContain('clarifying question');
  });

  it('does not throw when the knowledge doc is missing -- falls back to an empty section', async () => {
    await fsPromises.rm(path.join(tempRoot, 'docs', 'copilot-knowledge.md'));
    const prompt = await buildCopilotSystemPrompt();
    expect(prompt).not.toContain('Themes live at /dashboard/themes.'); // the deleted file's own content must be gone, not silently cached
    expect(prompt).toContain('"styles"'); // the live-context section still assembles fine on its own
    expect(prompt).toContain('clarifying question');
  });
});
