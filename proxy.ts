import { NextResponse, type NextRequest } from 'next/server';

// Optimistic check ONLY — presence of a session cookie, not validity. Proxy
// runs on every request including prefetches; a DB-backed check belongs at
// the route/page layer (getCurrentUser), not here. See the design spec's
// "Proxy-level redirect" section.
export function proxy(request: NextRequest) {
  const hasSession = request.cookies.has('session');
  if (!hasSession) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
}

export const config = {
  matcher: ['/((?!login|api|_next/static|_next/image|favicon.ico).*)'],
};
