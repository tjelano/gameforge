import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';

vi.mock('@/lib/services/DriveService', () => ({
  driveService: {
    uploadFile: vi.fn(),
  },
}));

vi.mock('@/lib/services/AssetService', () => ({
  assetService: {
    getById: vi.fn(),
  },
}));

vi.mock('@/lib/utils/session', () => ({
  getCurrentUser: vi.fn(),
}));

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-sharetodrive-'));
  setProjectRootForTests(tempRoot);
});

afterEach(async () => {
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/assets/asset1/share-to-drive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/assets/[id]/share-to-drive', () => {
  it('returns 404 when the asset does not exist', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { assetService } = await import('@/lib/services/AssetService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(assetService.getById).mockResolvedValue(null);

    const { POST } = await import('@/app/api/assets/[id]/share-to-drive/route');
    const res = await POST(postRequest({ parentFolderId: 'root' }), { params: Promise.resolve({ id: 'asset1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 400 when the asset has no stored file', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { assetService } = await import('@/lib/services/AssetService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(assetService.getById).mockResolvedValue({
      id: 'asset1', image_path: null, output_kind: 'image', prompt: 'x',
    } as any);

    const { POST } = await import('@/app/api/assets/[id]/share-to-drive/route');
    const res = await POST(postRequest({ parentFolderId: 'root' }), { params: Promise.resolve({ id: 'asset1' }) });
    expect(res.status).toBe(400);
  });

  it('401s when not logged in', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const { POST } = await import('@/app/api/assets/[id]/share-to-drive/route');
    const res = await POST(postRequest({ parentFolderId: 'root' }), { params: Promise.resolve({ id: 'asset1' }) });
    expect(res.status).toBe(401);
  });

  it('returns a clean 500 (not a hang or unhandled exception) when a valid image_path is missing on disk', async () => {
    // Proves the fs.createReadStream fix: createReadStream() never throws
    // synchronously for a missing file, it only emits an async 'error'
    // event once the open fails. Uses a real temp directory with no file
    // written at the target path, not a mock, so this fails the way the
    // original code actually failed if the fsPromises.access() check were
    // removed.
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { assetService } = await import('@/lib/services/AssetService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(assetService.getById).mockResolvedValue({
      id: 'asset1', image_path: 'does-not-exist.png', output_kind: 'image', prompt: 'x',
    } as any);
    // storage/images itself exists, but the file inside it does not.
    await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });

    const { POST } = await import('@/app/api/assets/[id]/share-to-drive/route');
    const res = await POST(postRequest({ parentFolderId: 'root' }), { params: Promise.resolve({ id: 'asset1' }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('returns 400 when asset.image_path contains a path-traversal sequence', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { assetService } = await import('@/lib/services/AssetService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(assetService.getById).mockResolvedValue({
      id: 'asset1', image_path: '../../../secrets.png', output_kind: 'image', prompt: 'x',
    } as any);

    const { POST } = await import('@/app/api/assets/[id]/share-to-drive/route');
    const res = await POST(postRequest({ parentFolderId: 'root' }), { params: Promise.resolve({ id: 'asset1' }) });
    expect(res.status).toBe(400);
  });
});
