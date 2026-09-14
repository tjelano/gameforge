import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/utils/session';
import { copilotConversationService } from '@/lib/services/CopilotConversationService';
import { copilotMessageService } from '@/lib/services/CopilotMessageService';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const { id } = await params;
    const conversation = await copilotConversationService.getById(id);
    if (!conversation) {
      return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 });
    }
    if (conversation.created_by !== user.id) {
      return NextResponse.json({ success: false, error: 'You do not have access to this conversation' }, { status: 403 });
    }

    const messages = await copilotMessageService.listByConversation(id);
    return NextResponse.json({
      success: true,
      data: {
        id: conversation.id,
        title: conversation.title,
        messages: messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          toolCall: m.tool_call ? JSON.parse(m.tool_call) : undefined,
          provider: m.provider,
          model: m.model,
          createdAt: m.created_at,
        })),
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
