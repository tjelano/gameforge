import { NextRequest, NextResponse } from 'next/server';
import { gitService } from '@/lib/services/GitService';
import { getCurrentUser } from '@/lib/utils/session';
import { userService } from '@/lib/services/UserService';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      // Mirrors app/api/auth/login/route.ts's own bootstrap exception: before
      // any account exists, the login screen's "Pull from git first" button
      // (app/login/LoginForm.tsx) has no session to send — a session always
      // joins to a real user row, so zero users means zero possible sessions.
      // Allow the pull only in that narrow, self-closing window; once any
      // account exists, this route requires login same as everywhere else.
      const existingUsers = await userService.getAll();
      if (existingUsers.length > 0) {
        return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
      }
    }

    const result = await gitService.pull();
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
