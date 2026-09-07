import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

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
});
