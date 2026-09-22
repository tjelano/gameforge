import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';
import { SESSION_COOKIE_OPTIONS } from '@/lib/utils/session';

export const dynamic = 'force-dynamic';

const LoginSchema = z.union([
  z.object({ userId: z.string().min(1) }),
  // force is a deliberate, UI-mediated bypass of the 403 below -- only the
  // "+Add another account" flow (LoginForm, reachable only once real
  // accounts already exist and are visible on screen) sends it, and only
  // after offering the same "Pull from git first" choice the guard exists
  // to encourage. It cannot grant admin: UserService.create() derives
  // is_admin from its own fresh COUNT(*) at insert time, independent of
  // this flag, and that count is guaranteed non-zero whenever force is
  // actually honored (existing.length > 0 is the only case it applies to).
  // That "guaranteed non-zero" claim also assumes no concurrent user
  // deletion between the `existing.length` check below and create()'s own
  // COUNT(*) -- true today because no user-deletion route/feature exists
  // anywhere in this app; revisit this comment if one is ever added.
  // Not an oversight -- see this task's own notes in the audit-fixes-2 plan
  // for the full reasoning.
  z.object({ name: z.string().min(1), force: z.boolean().optional() }),
]);

export async function POST(req: NextRequest) {
  try {
    const input = LoginSchema.parse(await req.json());

    let user;
    if ('userId' in input) {
      user = await userService.getById(input.userId);
      if (!user) {
        return NextResponse.json({ success: false, error: 'Account not found' }, { status: 404 });
      }
    } else {
      const existing = await userService.getAll();
      if (existing.length > 0 && !input.force) {
        return NextResponse.json({
          success: false,
          error: 'An account already exists — pick your name from the list, or Pull from git first.',
        }, { status: 403 });
      }
      try {
        user = await userService.create({ name: input.name });
      } catch (e: any) {
        return NextResponse.json({ success: false, error: 'That name is already taken.' }, { status: 409 });
      }
    }

    const { token } = await sessionService.create(user.id);
    const res = NextResponse.json({
      success: true,
      data: { id: user.id, name: user.name, isAdmin: !!user.is_admin },
    });
    res.cookies.set('session', token, { ...SESSION_COOKIE_OPTIONS, maxAge: 60 * 60 * 24 * 90 });
    return res;
  } catch (error: any) {
    if (error instanceof ZodError) {
      return NextResponse.json({
        success: false,
        error: error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
      }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
