import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/DriveService', () => ({
  driveService: {
    createFolder: vi.fn(),
  },
}));

vi.mock('@/lib/utils/session', () => ({
  getCurrentUser: vi.fn(),
}));

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/drive/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/drive/folders', () => {
  it('creates a folder', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(driveService.createFolder).mockResolvedValue({
      id: 'newfolder1', name: 'Sprites', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-09-07T00:00:00Z',
    });

    const { POST } = await import('@/app/api/drive/folders/route');
    const res = await POST(postRequest({ name: 'Sprites', parentFolderId: 'root' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.name).toBe('Sprites');
    expect(driveService.createFolder).toHaveBeenCalledWith('Sprites', 'root');
  });

  it('returns 400 for a malformed body', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);

    const { POST } = await import('@/app/api/drive/folders/route');
    const res = await POST(postRequest({ name: '' }));
    expect(res.status).toBe(400);
  });

  it('401s when not logged in', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const { POST } = await import('@/app/api/drive/folders/route');
    const res = await POST(postRequest({ name: 'Sprites', parentFolderId: 'root' }));
    expect(res.status).toBe(401);
  });
});
