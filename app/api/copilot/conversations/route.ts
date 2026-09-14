import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/utils/session';
import { copilotConversationService } from '@/lib/services/CopilotConversationService';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }
    const conversations = await copilotConversationService.listForUser(user.id);
    return NextResponse.json({
      success: true,
      data: conversations.map(c => ({ id: c.id, title: c.title, updatedAt: c.updated_at })),
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
