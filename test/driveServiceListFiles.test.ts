import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFilesList = vi.fn();

vi.mock('@googleapis/drive', () => ({
  drive: () => ({
    files: {
      list: mockFilesList,
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
  mockFilesList.mockReset();
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
});

describe('driveService.listFiles', () => {
  it('lists files in the given folder, defaulting to root', async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [
          { id: 'f1', name: 'sprite.png', mimeType: 'image/png', size: '1024', modifiedTime: '2026-09-07T00:00:00Z', webViewLink: 'https://drive.google.com/x', iconLink: 'https://icon', parents: ['root'] },
        ],
      },
    });

    const { driveService } = await import('@/lib/services/DriveService');
    const files = await driveService.listFiles();

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('sprite.png');
    expect(mockFilesList).toHaveBeenCalledWith(expect.objectContaining({
      q: "'root' in parents and trashed = false",
    }));
  });

  it('passes a search query combined with the folder filter', async () => {
    mockFilesList.mockResolvedValue({ data: { files: [] } });
    const { driveService } = await import('@/lib/services/DriveService');
    await driveService.listFiles('folder123', 'dungeon');

    expect(mockFilesList).toHaveBeenCalledWith(expect.objectContaining({
      q: "'folder123' in parents and trashed = false and name contains 'dungeon'",
    }));
  });

  it('escapes both backslashes and single quotes in a search query, backslashes first', async () => {
    mockFilesList.mockResolvedValue({ data: { files: [] } });
    const { driveService } = await import('@/lib/services/DriveService');
    await driveService.listFiles('folder123', String.raw`a\' or trashed = true and name contains 'b`);

    expect(mockFilesList).toHaveBeenCalledWith(expect.objectContaining({
      q: String.raw`'folder123' in parents and trashed = false and name contains 'a\\\' or trashed = true and name contains \'b'`,
    }));
  });
});
