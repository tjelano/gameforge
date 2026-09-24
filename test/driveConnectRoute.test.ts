import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/DriveService', () => ({
  driveService: { getAuthUrl: vi.fn() },
}));

vi.mock('@/lib/utils/session', () => ({
  getCurrentUser: vi.fn(),
}));

describe('GET /api/drive/connect', () => {
  it('redirects to /login?reason=expired instead of returning raw JSON when not logged in', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const { GET } = await import('@/app/api/drive/connect/route');
    const req = new NextRequest('http://localhost/api/drive/connect');
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login?reason=expired');
  });

  it('redirects to the friendly not_configured error instead of Google\'s own confusing page when getAuthUrl() throws', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user-1', name: 'x', is_admin: 0, created_at: Date.now() });

    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(driveService.getAuthUrl).mockImplementation(() => {
      throw new Error('Google Drive is not configured -- set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
    });

    const { GET } = await import('@/app/api/drive/connect/route');
    const req = new NextRequest('http://localhost/api/drive/connect');
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('error=not_configured');
  });
});
