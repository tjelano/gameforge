import type { NextRequest } from 'next/server';
import { sessionService } from '@/lib/services/SessionService';
import type { User } from '@/lib/database/schema';

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: false,
  sameSite: 'lax' as const,
  path: '/',
};

// Reads request.cookies (NextRequest's own header-backed accessor), never
// next/headers's cookies() — see this plan's Global Constraints for why:
// this codebase's route tests construct a raw NextRequest and call the
// route function directly, without the request-scoped context next/headers
// depends on.
export async function getCurrentUser(req: NextRequest): Promise<User | null> {
  const token = req.cookies.get('session')?.value;
  if (!token) return null;
  return sessionService.getUserByToken(token);
}
