import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/services/DriveService', () => ({
  driveService: {
    renameFile: vi.fn(),
    moveFile: vi.fn(),
    trashFile: vi.fn(),
  },
}));

vi.mock('@/lib/utils/session', () => ({
  getCurrentUser: vi.fn(),
}));

function withAuth() {
  return import('@/lib/utils/session').then(({ getCurrentUser }) => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
  });
}

describe('PATCH /api/drive/files/[id]', () => {
  it('renames when name is given', async () => {
    await withAuth();
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(driveService.renameFile).mockResolvedValue({ id: 'f1', name: 'renamed.png', mimeType: 'image/png', modifiedTime: 'x' });

    const { PATCH } = await import('@/app/api/drive/files/[id]/route');
    const req = new NextRequest('http://localhost/api/drive/files/f1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed.png' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'f1' }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.name).toBe('renamed.png');
    expect(driveService.renameFile).toHaveBeenCalledWith('f1', 'renamed.png');
  });

  it('moves when newParentId/oldParentId are given', async () => {
    await withAuth();
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(driveService.moveFile).mockResolvedValue({ id: 'f1', name: 'x.png', mimeType: 'image/png', modifiedTime: 'x' });

    const { PATCH } = await import('@/app/api/drive/files/[id]/route');
    const req = new NextRequest('http://localhost/api/drive/files/f1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newParentId: 'folderB', oldParentId: 'folderA' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'f1' }) });

    expect(res.status).toBe(200);
    expect(driveService.moveFile).toHaveBeenCalledWith('f1', 'folderB', 'folderA');
  });

  it('returns 400 when neither a name nor a full move pair is given', async () => {
    await withAuth();
    const { PATCH } = await import('@/app/api/drive/files/[id]/route');
    const req = new NextRequest('http://localhost/api/drive/files/f1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'f1' }) });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/drive/files/[id]', () => {
  it('trashes the file', async () => {
    await withAuth();
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(driveService.trashFile).mockResolvedValue(undefined);

    const { DELETE } = await import('@/app/api/drive/files/[id]/route');
    const req = new NextRequest('http://localhost/api/drive/files/f1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'f1' }) });

    expect(res.status).toBe(200);
    expect(driveService.trashFile).toHaveBeenCalledWith('f1');
  });

  it('401s when not logged in', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const { DELETE } = await import('@/app/api/drive/files/[id]/route');
    const req = new NextRequest('http://localhost/api/drive/files/f1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'f1' }) });
    expect(res.status).toBe(401);
  });
});
