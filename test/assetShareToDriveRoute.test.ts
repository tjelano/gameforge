import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';

vi.mock('@/lib/services/DriveService', () => ({
  driveService: {
    uploadFile: vi.fn(),
  },
}));

vi.mock('@/lib/services/AssetService', () => ({
  assetService: {
    getById: vi.fn(),
  },
}));

vi.mock('@/lib/utils/session', () => ({
  getCurrentUser: vi.fn(),
}));

let tempRoot: string;

beforeEach(async () => {
  // vitest.config.ts has no global clearMocks, and this file's mocks are
  // module-scoped (one vi.fn() shared across every test in this file) —
  // without this, driveService.uploadFile.mock.calls accumulates across
  // tests and a later test's mock.calls[0] silently reads an earlier
  // test's call args instead of its own.
  vi.clearAllMocks();
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-sharetodrive-'));
  setProjectRootForTests(tempRoot);
});

afterEach(async () => {
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/assets/asset1/share-to-drive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// <img> is deliberately excluded from componentSanitize's ALLOWED_TAGS, so
// it's the reliable "sanitizer would strip this" payload — same fixture
// used by Task 11's tests (see test/assetExportRoute.test.ts's IMG_DOC).
const IMG_DOC = '<!DOCTYPE html><html><head><style>.hero { color: red; }</style></head>'
  + '<body><div class="hero"><img src="/hero.png" alt="Hero"></div></body></html>';

describe('POST /api/assets/[id]/share-to-drive', () => {
  it('returns 404 when the asset does not exist', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { assetService } = await import('@/lib/services/AssetService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(assetService.getById).mockResolvedValue(null);

    const { POST } = await import('@/app/api/assets/[id]/share-to-drive/route');
    const res = await POST(postRequest({ parentFolderId: 'root' }), { params: Promise.resolve({ id: 'asset1' }) });
    expect(res.status).toBe(404);
  });

  it('returns 400 when the asset has no stored file', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { assetService } = await import('@/lib/services/AssetService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(assetService.getById).mockResolvedValue({
      id: 'asset1', image_path: null, output_kind: 'image', prompt: 'x',
    } as any);

    const { POST } = await import('@/app/api/assets/[id]/share-to-drive/route');
    const res = await POST(postRequest({ parentFolderId: 'root' }), { params: Promise.resolve({ id: 'asset1' }) });
    expect(res.status).toBe(400);
  });

  it('401s when not logged in', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    vi.mocked(getCurrentUser).mockResolvedValue(null);

    const { POST } = await import('@/app/api/assets/[id]/share-to-drive/route');
    const res = await POST(postRequest({ parentFolderId: 'root' }), { params: Promise.resolve({ id: 'asset1' }) });
    expect(res.status).toBe(401);
  });

  it('returns a clean 500 (not a hang or unhandled exception) when a valid image_path is missing on disk', async () => {
    // Proves the fs.createReadStream fix: createReadStream() never throws
    // synchronously for a missing file, it only emits an async 'error'
    // event once the open fails. Uses a real temp directory with no file
    // written at the target path, not a mock, so this fails the way the
    // original code actually failed if the fsPromises.access() check were
    // removed.
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { assetService } = await import('@/lib/services/AssetService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(assetService.getById).mockResolvedValue({
      id: 'asset1', image_path: 'does-not-exist.png', output_kind: 'image', prompt: 'x',
    } as any);
    // storage/images itself exists, but the file inside it does not.
    await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });

    const { POST } = await import('@/app/api/assets/[id]/share-to-drive/route');
    const res = await POST(postRequest({ parentFolderId: 'root' }), { params: Promise.resolve({ id: 'asset1' }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('returns 400 when asset.image_path contains a path-traversal sequence', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { assetService } = await import('@/lib/services/AssetService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(assetService.getById).mockResolvedValue({
      id: 'asset1', image_path: '../../../secrets.png', output_kind: 'image', prompt: 'x',
    } as any);

    const { POST } = await import('@/app/api/assets/[id]/share-to-drive/route');
    const res = await POST(postRequest({ parentFolderId: 'root' }), { params: Promise.resolve({ id: 'asset1' }) });
    expect(res.status).toBe(400);
  });

  it('uploads a component marked edited_externally with its hand-edited content intact', async () => {
    // Same fixture/rule as test/assetExportRoute.test.ts's equivalent case
    // for the export route — edited_externally === 1 means the trust
    // decision was already made at write time, so re-sanitization is
    // skipped here too.
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { assetService } = await import('@/lib/services/AssetService');
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(assetService.getById).mockResolvedValue({
      id: 'asset1', image_path: 'component-1.html', output_kind: 'component', prompt: 'x', edited_externally: 1,
    } as any);
    vi.mocked(driveService.uploadFile).mockResolvedValue({ id: 'drive-file-1' } as any);
    await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'component-1.html'), IMG_DOC);

    const { POST } = await import('@/app/api/assets/[id]/share-to-drive/route');
    const res = await POST(postRequest({ parentFolderId: 'root' }), { params: Promise.resolve({ id: 'asset1' }) });

    expect(res.status).toBe(200);
    const uploadedStream = vi.mocked(driveService.uploadFile).mock.calls[0][0].stream;
    const uploaded = await streamToString(uploadedStream);
    expect(uploaded).toContain('<img');
    expect(uploaded).toContain('/hero.png');
  });

  it('still sanitizes a component upload when the asset is not marked edited_externally', async () => {
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { assetService } = await import('@/lib/services/AssetService');
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(assetService.getById).mockResolvedValue({
      id: 'asset1', image_path: 'component-2.html', output_kind: 'component', prompt: 'x', edited_externally: 0,
    } as any);
    vi.mocked(driveService.uploadFile).mockResolvedValue({ id: 'drive-file-2' } as any);
    await fsPromises.mkdir(path.join(tempRoot, 'storage', 'components'), { recursive: true });
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'components', 'component-2.html'), IMG_DOC);

    const { POST } = await import('@/app/api/assets/[id]/share-to-drive/route');
    const res = await POST(postRequest({ parentFolderId: 'root' }), { params: Promise.resolve({ id: 'asset1' }) });

    expect(res.status).toBe(200);
    const uploadedStream = vi.mocked(driveService.uploadFile).mock.calls[0][0].stream;
    const uploaded = await streamToString(uploadedStream);
    expect(uploaded).not.toContain('<img');
    expect(uploaded).not.toContain('/hero.png');
    // Proves the <img> was SANITIZED OUT, not that the whole component was
    // dropped — the surrounding allowed markup is still in the upload.
    expect(uploaded).toContain('class="hero"');
  });

  it('uploads the raw file bytes unchanged for a non-component (image) asset', async () => {
    // Confirms this task's new branch is scoped to output_kind ===
    // 'component' only — images still go straight through
    // fs.createReadStream with no parsing/sanitization.
    const { getCurrentUser } = await import('@/lib/utils/session');
    const { assetService } = await import('@/lib/services/AssetService');
    const { driveService } = await import('@/lib/services/DriveService');
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', name: 'Alice', is_admin: 0, created_at: 0 } as any);
    vi.mocked(assetService.getById).mockResolvedValue({
      id: 'asset1', image_path: 'sprite.png', output_kind: 'image', prompt: 'x',
    } as any);
    vi.mocked(driveService.uploadFile).mockResolvedValue({ id: 'drive-file-3' } as any);
    await fsPromises.mkdir(path.join(tempRoot, 'storage', 'images'), { recursive: true });
    const rawBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    await fsPromises.writeFile(path.join(tempRoot, 'storage', 'images', 'sprite.png'), rawBytes);

    const { POST } = await import('@/app/api/assets/[id]/share-to-drive/route');
    const res = await POST(postRequest({ parentFolderId: 'root' }), { params: Promise.resolve({ id: 'asset1' }) });

    expect(res.status).toBe(200);
    const uploadCall = vi.mocked(driveService.uploadFile).mock.calls[0][0];
    expect(uploadCall.mimeType).toBe('image/png');
    const uploadedStream = uploadCall.stream;
    const chunks: Buffer[] = [];
    for await (const chunk of uploadedStream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    expect(Buffer.concat(chunks).equals(rawBytes)).toBe(true);
  });
});
