// test/driveFilesUploadRoute.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/DriveService', () => ({
  driveService: {
    listFiles: vi.fn(),
    uploadFile: vi.fn(),
  },
}));

vi.mock('@/lib/utils/session', () => ({
  getCurrentUser: vi.fn(),
}));

describe('POST /api/drive/files', () => {
  it('uploads the given file to the given parent folder', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(driveService.uploadFile).mockResolvedValue({
      id: 'newfile1', name: 'test.png', mimeType: 'image/png', modifiedTime: '2026-09-07T00:00:00Z',
    });

    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'test.png');
    formData.append('parentFolderId', 'folder1');

    const { POST } = await import('@/app/api/drive/files/route');
    const req = new NextRequest('http://localhost/api/drive/files', { method: 'POST', body: formData });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.id).toBe('newfile1');
    expect(driveService.uploadFile).toHaveBeenCalledWith(expect.objectContaining({
      name: 'test.png',
      mimeType: 'image/png',
      parentFolderId: 'folder1',
    }));
  });

  it('returns 400 when no file is provided', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);

    const formData = new FormData();
    formData.append('parentFolderId', 'folder1');

    const { POST } = await import('@/app/api/drive/files/route');
    const req = new NextRequest('http://localhost/api/drive/files', { method: 'POST', body: formData });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('401s when not logged in', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const { POST } = await import('@/app/api/drive/files/route');
    const req = new NextRequest('http://localhost/api/drive/files', { method: 'POST', body: new FormData() });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});
