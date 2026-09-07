import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFilesGet = vi.fn();
const mockFetch = vi.fn();
const mockGetAccessToken = vi.fn();

vi.mock('@googleapis/drive', () => ({
  drive: () => ({
    files: {
      get: mockFilesGet,
    },
  }),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class MockOAuth2Client {
    credentials: { refresh_token: string };
    constructor() {
      this.credentials = { refresh_token: 'fake-refresh-token' };
    }
    setCredentials() {}
    getAccessToken = mockGetAccessToken;
  },
}));

vi.mock('@/lib/services/SettingsService', () => ({
  settingsService: {
    get: vi.fn().mockResolvedValue('fake-refresh-token'),
    set: vi.fn(),
  },
}));

beforeEach(() => {
  mockFilesGet.mockReset();
  mockFetch.mockReset();
  mockGetAccessToken.mockReset();
  mockGetAccessToken.mockResolvedValue({ token: 'test-access-token' });
  vi.stubGlobal('fetch', mockFetch);
  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('driveService.getThumbnail', () => {
  it('returns null when the file has no thumbnailLink', async () => {
    mockFilesGet.mockResolvedValue({ data: {} });
    const { driveService } = await import('@/lib/services/DriveService');
    expect(await driveService.getThumbnail('file1')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches the thumbnail with an Authorization header when thumbnailLink exists', async () => {
    mockFilesGet.mockResolvedValue({ data: { thumbnailLink: 'https://drive.example/thumb' } });
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'image/jpeg']]) as any,
      body: new ReadableStream(),
    });
    const { driveService } = await import('@/lib/services/DriveService');
    const result = await driveService.getThumbnail('file1');

    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe('image/jpeg');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://drive.example/thumb',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringContaining('Bearer ') }) })
    );
  });
});
