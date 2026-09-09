import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { assetService } from '@/lib/services/AssetService';
import { PUT as updateAsset } from '@/app/api/assets/[id]/route';

let tempRoot: string;
const STYLE_ID = '88888888-8888-8888-8888-888888888888';
const ASSET_ID = '77777777-7777-7777-7777-777777777777';

function putRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/assets/x', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-assetupdate-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  const db = DatabaseConnection.getInstance();
  db.prepare(
    `INSERT INTO styles (id, name, created_by, parameters, is_deleted, created_at, updated_at)
     VALUES (?, 'style', 'user-1', '{}', 0, 1000, 1000)`
  ).run(STYLE_ID);
  db.prepare(
    `INSERT INTO assets (id, style_id, created_by, asset_type, prompt, image_path, created_at, is_deleted)
     VALUES (?, ?, 'user-1', 'button', 'Inventory', 'inv.png', 1000, 0)`
  ).run(ASSET_ID, STYLE_ID);
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('PUT /api/assets/[id] — 9-slice margins and states', () => {
  it('sets nine_slice_margins and states, round-tripping through the JSON columns', async () => {
    const res = await updateAsset(
      putRequest({ nineSliceMargins: { top: 8, right: 8, bottom: 8, left: 8 }, states: ['hover', 'pressed'] }),
      { params: Promise.resolve({ id: ASSET_ID }) }
    );
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(JSON.parse(body.data.nine_slice_margins)).toEqual({ top: 8, right: 8, bottom: 8, left: 8 });
    expect(JSON.parse(body.data.states)).toEqual(['hover', 'pressed']);
  });

  it('rejects a malformed margins object instead of silently storing it', async () => {
    const res = await updateAsset(
      putRequest({ nineSliceMargins: { top: 8 } }),
      { params: Promise.resolve({ id: ASSET_ID }) }
    );
    expect(res.status).toBe(400);
  });
});

describe('AssetService.update() — edited_externally', () => {
  it('sets edited_externally to 1 when patched with true', async () => {
    const updated = await assetService.update(ASSET_ID, { editedExternally: true });

    expect(updated).not.toBeNull();
    expect(updated!.edited_externally).toBe(1);
  });

  it('sets edited_externally to 0 when patched with false', async () => {
    const db = DatabaseConnection.getInstance();
    // First set it to 1
    db.prepare('UPDATE assets SET edited_externally = 1 WHERE id = ?').run(ASSET_ID);

    const updated = await assetService.update(ASSET_ID, { editedExternally: false });

    expect(updated).not.toBeNull();
    expect(updated!.edited_externally).toBe(0);
  });

  it('preserves edited_externally when not included in patch', async () => {
    const db = DatabaseConnection.getInstance();
    // Set it to 1 initially
    db.prepare('UPDATE assets SET edited_externally = 1 WHERE id = ?').run(ASSET_ID);

    // Update with a different field, omitting editedExternally
    const updated = await assetService.update(ASSET_ID, { prompt: 'Updated prompt' });

    expect(updated).not.toBeNull();
    expect(updated!.edited_externally).toBe(1); // Should still be 1
    expect(updated!.prompt).toBe('Updated prompt');
  });

  it('does not reset edited_externally when updating other fields', async () => {
    const db = DatabaseConnection.getInstance();
    db.prepare('UPDATE assets SET edited_externally = 1 WHERE id = ?').run(ASSET_ID);

    const updated = await assetService.update(ASSET_ID, { assetType: 'input' });

    expect(updated).not.toBeNull();
    expect(updated!.edited_externally).toBe(1); // Should still be 1
    expect(updated!.asset_type).toBe('input');
  });
});
