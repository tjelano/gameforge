import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { assetService } from '@/lib/services/AssetService';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';
import { combineComponentHtml, type ComponentTokens } from '@/lib/services/componentDocument';
import { POST } from '@/app/api/assets/[id]/component/patch-element/route';
import { seedSession } from '@/test/helpers/testSession';

let tempRoot: string;
let cookieHeader: string;
let userId: string;

const FIXTURE: ComponentTokens = {
  html: '<button data-gf-id="1" class="btn-primary">Buy now</button>',
  css: '.btn-primary { background: var(--color-accent); }',
};

const VALID_BODY = { dataGfId: '1', documentHash: 'irrelevant-because-service-is-mocked', instruction: 'make it bigger' };

/** Creates a component asset for `creatorId` (default: the shared test user), mirroring
 * test/assetComponentEditRoute.test.ts's fixture. `editedExternally` lets the
 * edited_externally-rejection test seed a hand-edited asset directly. */
async function makeComponentAsset(
  creatorId = userId,
  options: { editedExternally?: boolean; outputKind?: 'image' | 'theme' | 'component'; isDeleted?: boolean } = {}
): Promise<{ assetId: string; filename: string; styleId: string }> {
  const style = await styleService.create({ name: 'x', createdBy: creatorId, parameters: '{}' });
  const filename = `component-${crypto.randomUUID()}.html`;
  await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', filename), combineComponentHtml(FIXTURE));
  const asset = await assetService.create({
    styleId: style.id, createdBy: creatorId, assetType: 'component', prompt: 'x', imagePath: filename,
    outputKind: options.outputKind ?? 'component',
  });
  if (options.editedExternally) {
    await assetService.update(asset.id, creatorId, { editedExternally: true }, true);
  }
  if (options.isDeleted) {
    await assetService.softDelete(asset.id, creatorId, true);
  }
  return { assetId: asset.id, filename, styleId: style.id };
}

function postRequest(body: Record<string, unknown>, cookie = cookieHeader): NextRequest {
  return new NextRequest('http://localhost/x', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-assetpatchelement-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();
  vi.restoreAllMocks();
  const { userId: newUserId, cookieHeader: newCookieHeader } = await seedSession();
  userId = newUserId;
  cookieHeader = newCookieHeader;
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

describe('POST /api/assets/[id]/component/patch-element', () => {
  it('returns 401 when not logged in', async () => {
    const { assetId } = await makeComponentAsset();
    const res = await POST(postRequest(VALID_BODY, ''), { params: Promise.resolve({ id: assetId }) });
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown asset', async () => {
    const res = await POST(postRequest(VALID_BODY), { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a soft-deleted asset', async () => {
    const { assetId } = await makeComponentAsset(userId, { isDeleted: true });
    const res = await POST(postRequest(VALID_BODY), { params: Promise.resolve({ id: assetId }) });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-component asset', async () => {
    const { assetId } = await makeComponentAsset(userId, { outputKind: 'theme' });
    const res = await POST(postRequest(VALID_BODY), { params: Promise.resolve({ id: assetId }) });
    expect(res.status).toBe(404);
  });

  it('returns 403 when the requesting user is not the asset creator or an admin', async () => {
    // seedSession() in beforeEach already created the first user in this test's fresh DB (and that
    // slot is the one that becomes admin), so owner and stranger below are both created after it
    // and are both non-admin — a genuine "neither creator nor admin" case.
    const owner = await userService.create({ name: 'Owner' });
    const stranger = await userService.create({ name: 'Stranger' });
    const { token } = await sessionService.create(stranger.id);
    const { assetId } = await makeComponentAsset(owner.id);
    const res = await POST(postRequest(VALID_BODY, `session=${token}`), { params: Promise.resolve({ id: assetId }) });
    expect(res.status).toBe(403);
  });

  it('returns 400 with a clear message for an edited_externally asset', async () => {
    const { assetId } = await makeComponentAsset(userId, { editedExternally: true });
    const res = await POST(postRequest(VALID_BODY), { params: Promise.resolve({ id: assetId }) });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toMatch(/hand-edited/i);
  });

  it('returns 400 for a malformed JSON body instead of a 500', async () => {
    const { assetId } = await makeComponentAsset();
    const req = new NextRequest('http://localhost/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: 'not valid json{',
    });
    const res = await POST(req, { params: Promise.resolve({ id: assetId }) });
    expect(res.status).toBe(400);
  });

  it('calls applyElementPatch and returns its result', async () => {
    const { assetId, filename, styleId } = await makeComponentAsset();
    const patchResult = {
      ok: true as const,
      idMap: { rootId: '1', newDescendantIds: ['2', '3'] },
      newDocumentHash: 'new-hash',
    };
    const spy = vi.spyOn(await import('@/lib/services/componentPatchService'), 'applyElementPatch').mockResolvedValue(patchResult);

    const res = await POST(postRequest(VALID_BODY), { params: Promise.resolve({ id: assetId }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: patchResult });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      filename,
      assetId,
      requestingUserId: userId,
      isAdmin: true, // the beforeEach session user is the first user created, so is admin
      dataGfId: VALID_BODY.dataGfId,
      documentHash: VALID_BODY.documentHash,
      instruction: VALID_BODY.instruction,
      styleId,
    }));
  });

  it.each([
    [{ code: 'ELEMENT_CHANGED' }, 409, 'ELEMENT_CHANGED'],
    [{ code: 'ELEMENT_NOT_FOUND' }, 404, 'ELEMENT_NOT_FOUND'],
    [{ code: 'SANITIZE_REJECTED', message: 'nope' }, 400, 'nope'],
    [{ code: 'CONFLICT' }, 409, 'CONFLICT'],
    [{ code: 'COMPONENT_NOT_FOUND' }, 404, 'COMPONENT_NOT_FOUND'],
    [{ code: 'WRITE_FAILED', message: 'disk full' }, 500, 'disk full'],
  ] as const)('maps a PatchError %o to status %i, surfacing its message when present', async (error, status, expectedError) => {
    const { assetId } = await makeComponentAsset();
    vi.spyOn(await import('@/lib/services/componentPatchService'), 'applyElementPatch').mockResolvedValue({ ok: false, error });

    const res = await POST(postRequest(VALID_BODY), { params: Promise.resolve({ id: assetId }) });
    const body = await res.json();
    expect(res.status).toBe(status);
    // SANITIZE_REJECTED/WRITE_FAILED carry a diagnostic `message` (e.g. which CSS rule was
    // rejected) that would otherwise be silently discarded in favor of the generic code.
    expect(body.error).toBe(expectedError);
  });
});
