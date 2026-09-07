// test/driveFilesListRoute.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/DriveService', () => ({
  driveService: {
    listFiles: vi.fn(),
  },
}));

vi.mock('@/lib/utils/session', () => ({
  getCurrentUser: vi.fn(),
}));

describe('GET /api/drive/files', () => {
  it('lists files for the requested folder and query', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(driveService.listFiles).mockResolvedValue([
      { id: 'f1', name: 'sprite.png', mimeType: 'image/png', modifiedTime: '2026-09-07T00:00:00Z' },
    ]);

    const { GET } = await import('@/app/api/drive/files/route');
    const req = new NextRequest('http://localhost/api/drive/files?folderId=folder1&q=sprite');
    const res = await GET(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(driveService.listFiles).toHaveBeenCalledWith('folder1', 'sprite');
  });

  it('401s when not logged in', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const { GET } = await import('@/app/api/drive/files/route');
    const req = new NextRequest('http://localhost/api/drive/files');
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});
