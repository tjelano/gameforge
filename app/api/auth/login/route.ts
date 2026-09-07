import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { userService } from '@/lib/services/UserService';
import { sessionService } from '@/lib/services/SessionService';

export const dynamic = 'force-dynamic';

const LoginSchema = z.union([
  z.object({ userId: z.string().min(1) }),
  z.object({ name: z.string().min(1) }),
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
      if (existing.length > 0) {
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
    res.cookies.set('session', token, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 90,
      path: '/',
    });
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
