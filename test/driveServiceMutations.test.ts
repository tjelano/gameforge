import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFilesUpdate = vi.fn();
const mockFilesCreate = vi.fn();

vi.mock('@googleapis/drive', () => ({
  drive: () => ({
    files: {
      update: mockFilesUpdate,
      create: mockFilesCreate,
    },
  }),
}));

vi.mock('@/lib/services/SettingsService', () => ({
  settingsService: {
    get: vi.fn().mockResolvedValue('fake-refresh-token'),
    set: vi.fn(),
  },
}));

beforeEach(() => {
  mockFilesUpdate.mockReset();
  mockFilesCreate.mockReset();
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
});

describe('driveService mutations', () => {
  it('trashFile sets trashed:true via files.update — never calls a delete method', async () => {
    mockFilesUpdate.mockResolvedValue({ data: {} });
    const { driveService } = await import('@/lib/services/DriveService');
    await driveService.trashFile('file1');

    expect(mockFilesUpdate).toHaveBeenCalledWith(expect.objectContaining({
      fileId: 'file1',
      requestBody: { trashed: true },
    }));
  });

  it('renameFile updates the name field', async () => {
    mockFilesUpdate.mockResolvedValue({ data: { id: 'file1', name: 'new-name.png', mimeType: 'image/png', modifiedTime: '2026-09-07T00:00:00Z' } });
    const { driveService } = await import('@/lib/services/DriveService');
    const result = await driveService.renameFile('file1', 'new-name.png');

    expect(result.name).toBe('new-name.png');
    expect(mockFilesUpdate).toHaveBeenCalledWith(expect.objectContaining({
      fileId: 'file1',
      requestBody: { name: 'new-name.png' },
    }), expect.anything());
  });

  it('moveFile adds the new parent and removes the old one in one call', async () => {
    mockFilesUpdate.mockResolvedValue({ data: { id: 'file1', name: 'x.png', mimeType: 'image/png', modifiedTime: '2026-09-07T00:00:00Z' } });
    const { driveService } = await import('@/lib/services/DriveService');
    await driveService.moveFile('file1', 'newFolder', 'oldFolder');

    expect(mockFilesUpdate).toHaveBeenCalledWith(expect.objectContaining({
      fileId: 'file1',
      addParents: 'newFolder',
      removeParents: 'oldFolder',
    }), expect.anything());
  });

  it('createFolder creates a folder-mimeType file', async () => {
    mockFilesCreate.mockResolvedValue({ data: { id: 'newfolder1', name: 'Sprites', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-09-07T00:00:00Z' } });
    const { driveService } = await import('@/lib/services/DriveService');
    const result = await driveService.createFolder('Sprites', 'root');

    expect(result.name).toBe('Sprites');
    expect(mockFilesCreate).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: { name: 'Sprites', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
    }), expect.anything());
  });
});
