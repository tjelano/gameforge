// test/driveThumbnailRoute.test.ts
import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'stream';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/DriveService', () => ({
  driveService: {
    getThumbnail: vi.fn(),
  },
}));

vi.mock('@/lib/utils/session', () => ({
  getCurrentUser: vi.fn(),
}));

describe('GET /api/drive/files/[id]/thumbnail', () => {
  it('streams the thumbnail with its real content type', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(driveService.getThumbnail).mockResolvedValue({
      stream: Readable.from([Buffer.from('fake jpeg bytes')]),
      mimeType: 'image/jpeg',
    });

    const { GET } = await import('@/app/api/drive/files/[id]/thumbnail/route');
    const req = new NextRequest('http://localhost/api/drive/files/f1/thumbnail');
    const res = await GET(req, { params: Promise.resolve({ id: 'f1' }) });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('returns 404 when there is no thumbnail', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(driveService.getThumbnail).mockResolvedValue(null);

    const { GET } = await import('@/app/api/drive/files/[id]/thumbnail/route');
    const req = new NextRequest('http://localhost/api/drive/files/f1/thumbnail');
    const res = await GET(req, { params: Promise.resolve({ id: 'f1' }) });
    expect(res.status).toBe(404);
  });

  it('401s when not logged in', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const { GET } = await import('@/app/api/drive/files/[id]/thumbnail/route');
    const req = new NextRequest('http://localhost/api/drive/files/f1/thumbnail');
    const res = await GET(req, { params: Promise.resolve({ id: 'f1' }) });
    expect(res.status).toBe(401);
  });
});
