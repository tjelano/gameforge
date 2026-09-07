import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

const mockFilesCreate = vi.fn();

vi.mock('@googleapis/drive', () => ({
  drive: () => ({
    files: {
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
  mockFilesCreate.mockReset();
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('driveService.uploadFile', () => {
  it('creates a file with the given name, mimeType, and parent folder', async () => {
    mockFilesCreate.mockResolvedValue({
      data: { id: 'newfile1', name: 'sprite.png', mimeType: 'image/png', modifiedTime: '2026-09-07T00:00:00Z' },
    });

    const { driveService } = await import('@/lib/services/DriveService');
    const stream = Readable.from([Buffer.from('fake image bytes')]);
    const result = await driveService.uploadFile({
      name: 'sprite.png',
      mimeType: 'image/png',
      stream,
      parentFolderId: 'folder123',
    });

    expect(result.id).toBe('newfile1');
    expect(mockFilesCreate).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: { name: 'sprite.png', parents: ['folder123'] },
      media: { mimeType: 'image/png', body: stream },
      fields: expect.any(String),
    }));
  });
});
