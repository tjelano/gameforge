// test/generateRoute.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import { setProjectRootForTests } from '@/lib/utils/projectRoot';
import { DatabaseConnection } from '@/lib/database';
import { styleService } from '@/lib/services/StyleService';
import { jobService } from '@/lib/services/JobService';
import { seedSession } from './helpers/testSession';
import { POST } from '@/app/api/generate/route';

let tempRoot: string;
let cookieHeader: string;
let styleId: string;

beforeEach(async () => {
  tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gameforge-generateroute-'));
  await fsPromises.writeFile(path.join(tempRoot, 'package.json'), JSON.stringify({ name: 'x' }));
  const realMigrationsDir = path.resolve(__dirname, '..', 'lib', 'database', 'migrations');
  const tempMigrationsDir = path.join(tempRoot, 'lib', 'database', 'migrations');
  await fsPromises.mkdir(tempMigrationsDir, { recursive: true });
  for (const file of await fsPromises.readdir(realMigrationsDir)) {
    await fsPromises.copyFile(path.join(realMigrationsDir, file), path.join(tempMigrationsDir, file));
  }
  setProjectRootForTests(tempRoot);
  DatabaseConnection.resetForTests();

  const seeded = await seedSession();
  cookieHeader = seeded.cookieHeader;
  const style = await styleService.create({ name: 'x', createdBy: seeded.userId, parameters: '{}' });
  styleId = style.id;
});

afterEach(async () => {
  DatabaseConnection.resetForTests();
  setProjectRootForTests(undefined);
  if (tempRoot) await fsPromises.rm(tempRoot, { recursive: true, force: true });
});

// Matches this codebase's real existing pattern (see test/pagesRoute.test.ts) -
// Cookie header, capital C, and seedSession()'s cookieHeader is already the
// full "session=<token>" string.
function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
    body: JSON.stringify(body),
  });
}

describe('POST /api/generate with referenceImage', () => {
  it('saves the reference image to storage/references/ and records its filename in options', async () => {
    const base64 = Buffer.from('fake-png-bytes').toString('base64');
    const res = await POST(req({
      styleId,
      assetType: 'hero',
      prompt: 'a hero section',
      outputKind: 'component',
      referenceImage: { base64, mediaType: 'image/png' },
    }));
    const body = await res.json();
    expect(body.success).toBe(true);

    const options = JSON.parse(body.data.options);
    expect(options.referenceImageFilename).toMatch(/^reference-.*\.png$/);

    const savedPath = path.join(tempRoot, 'storage', 'references', options.referenceImageFilename);
    const saved = await fsPromises.readFile(savedPath);
    expect(saved.toString()).toBe('fake-png-bytes');
  });

  it('records referenceStrength in options when provided alongside the image', async () => {
    const base64 = Buffer.from('x').toString('base64');
    const res = await POST(req({
      styleId,
      assetType: 'sprite',
      prompt: 'a goblin',
      outputKind: 'image',
      referenceImage: { base64, mediaType: 'image/png', referenceStrength: 400 },
    }));
    const body = await res.json();
    const options = JSON.parse(body.data.options);
    expect(options.referenceStrength).toBe(400);
  });

  it('rejects an oversized base64 payload with a 400, never reaching the filesystem', async () => {
    const hugeBase64 = 'A'.repeat(11_000_000);
    const res = await POST(req({
      styleId,
      assetType: 'hero',
      prompt: 'x',
      referenceImage: { base64: hugeBase64, mediaType: 'image/png' },
    }));
    expect(res.status).toBe(400);
    const referencesDir = path.join(tempRoot, 'storage', 'references');
    await expect(fsPromises.readdir(referencesDir)).rejects.toThrow();
  });

  it('rejects an unsupported mediaType with a 400', async () => {
    const res = await POST(req({
      styleId,
      assetType: 'hero',
      prompt: 'x',
      referenceImage: { base64: Buffer.from('x').toString('base64'), mediaType: 'image/gif' },
    }));
    expect(res.status).toBe(400);
  });

  it('records basedOnAssetId in options when provided', async () => {
    const fakeAssetId = randomUUID();
    const res = await POST(req({
      styleId,
      assetType: 'hero',
      prompt: 'make the button bigger',
      outputKind: 'component',
      basedOnAssetId: fakeAssetId,
    }));
    const body = await res.json();
    const options = JSON.parse(body.data.options);
    expect(options.basedOnAssetId).toBe(fakeAssetId);
  });

  it('creates a job with empty options when no referenceImage or basedOnAssetId is given (unchanged existing behavior)', async () => {
    const res = await POST(req({ styleId, assetType: 'sprite', prompt: 'a goblin' }));
    const body = await res.json();
    expect(JSON.parse(body.data.options)).toEqual({});
  });

  it('strips a client-injected referenceImageFilename/referenceStrength/basedOnAssetId smuggled inside options, rather than trusting them unvalidated', async () => {
    const res = await POST(req({
      styleId,
      assetType: 'sprite',
      prompt: 'a goblin',
      options: {
        referenceImageFilename: 'sneaky-existing-file.png',
        referenceStrength: 999,
        basedOnAssetId: 'not-a-uuid',
        harmlessKey: 'kept',
      },
    }));
    const body = await res.json();
    const options = JSON.parse(body.data.options);
    expect(options.referenceImageFilename).toBeUndefined();
    expect(options.referenceStrength).toBeUndefined();
    expect(options.basedOnAssetId).toBeUndefined();
    expect(options.harmlessKey).toBe('kept');
  });

  it('rejects an ollama provider combined with a reference image', async () => {
    const res = await POST(req({
      styleId, assetType: 'theme', prompt: 'warm', outputKind: 'theme',
      provider: 'ollama', model: 'llama3-groq-tool-use:8b', ollamaHost: 'http://localhost:11434',
      referenceImage: { base64: 'AAAA', mediaType: 'image/png' },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/reference image/i);
  });

  it('rejects an ollama provider for image (sprite) generation', async () => {
    const res = await POST(req({
      styleId, assetType: 'button', prompt: 'a button', outputKind: 'image',
      provider: 'ollama', model: 'llama3-groq-tool-use:8b', ollamaHost: 'http://localhost:11434',
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/image/i);
  });

  it('stores provider/model/ollamaHost in the job options when an ollama provider is given for a theme job', async () => {
    const res = await POST(req({
      styleId, assetType: 'theme', prompt: 'warm', outputKind: 'theme',
      provider: 'ollama', model: 'llama3-groq-tool-use:8b', ollamaHost: 'http://localhost:11434',
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const storedOptions = JSON.parse((await jobService.getById(body.data.id))!.options);
    expect(storedOptions.provider).toBe('ollama');
    expect(storedOptions.model).toBe('llama3-groq-tool-use:8b');
    expect(storedOptions.ollamaHost).toBe('http://localhost:11434');
  });
});
