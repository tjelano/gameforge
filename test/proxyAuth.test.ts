import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { config, proxy } from '@/proxy';

describe('proxy.ts auth redirect', () => {
  it('redirects to /login when there is no session cookie', async () => {
    const req = new NextRequest('http://localhost/dashboard/generate');
    const res = proxy(req);
    expect(res?.status).toBe(307);
    expect(res?.headers.get('location')).toContain('/login');
  });

  it('does not redirect when a session cookie is present (even an invalid one — optimistic check only)', async () => {
    const req = new NextRequest('http://localhost/dashboard/generate', {
      headers: { Cookie: 'session=whatever' },
    });
    const res = proxy(req);
    expect(res).toBeUndefined();
  });

  it('matcher excludes /login, /api, and Next internals', () => {
    expect(config.matcher).toEqual(['/((?!login|api|_next/static|_next/image|favicon.ico).*)']);
  });
});
