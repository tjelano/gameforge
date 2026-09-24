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
});
