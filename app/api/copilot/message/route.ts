import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { getCurrentUser } from '@/lib/utils/session';
import { resolveClaudeProvider } from '@/lib/services/claudeApiProviders';
import { callClaudeMessage } from '@/lib/services/claudeToolCall';
import { callOllamaMessage } from '@/lib/services/ollamaToolCall';
import { buildNavigateTool, NavigateToPageInputSchema, type ProviderMessageResult } from '@/lib/services/copilotTool';
import { buildCopilotSystemPrompt } from '@/lib/services/copilotSystemPrompt';
import { copilotConversationService } from '@/lib/services/CopilotConversationService';
import { copilotMessageService } from '@/lib/services/CopilotMessageService';

export const dynamic = 'force-dynamic';

const TITLE_MAX_LENGTH = 60;

const MessageSchema = z.object({
  conversationId: z.string().uuid().optional(),
  text: z.string().min(1).max(4000),
  provider: z.enum(['claude', 'ollama']).optional(),
  model: z.string().min(1).optional(),
  ollamaHost: z.string().regex(/^https?:\/\//).optional(),
}).refine(
  input => input.provider !== 'ollama' || (!!input.model && !!input.ollamaHost),
  { message: 'model and ollamaHost are required when provider is "ollama"' }
);

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not logged in' }, { status: 401 });
    }

    const input = MessageSchema.parse(await req.json());

    let conversationId = input.conversationId;
    if (conversationId) {
      const existing = await copilotConversationService.getById(conversationId);
      if (!existing) {
        return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 });
      }
      if (existing.created_by !== user.id) {
        return NextResponse.json({ success: false, error: 'You do not have access to this conversation' }, { status: 403 });
      }
    } else {
      const title = input.text.length > TITLE_MAX_LENGTH ? `${input.text.slice(0, TITLE_MAX_LENGTH)}…` : input.text;
      const created = await copilotConversationService.create({ title, createdBy: user.id });
      conversationId = created.id;
    }

    const priorMessages = await copilotMessageService.listByConversation(conversationId);
    await copilotMessageService.append({ conversationId, role: 'user', content: input.text });

    const tool = buildNavigateTool();
    const systemPrompt = await buildCopilotSystemPrompt();
    const turnMessages = [
      ...priorMessages.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: input.text },
    ];

    let result: ProviderMessageResult;
    let providerUsed: 'claude' | 'ollama';
    let modelUsed: string;

    if (input.provider === 'ollama') {
      providerUsed = 'ollama';
      modelUsed = input.model!;
      try {
        result = await callOllamaMessage({
          host: input.ollamaHost!,
          model: input.model!,
          toolName: tool.name,
          toolDescription: tool.description,
          inputSchema: tool.inputSchema,
          messages: [{ role: 'system', content: systemPrompt }, ...turnMessages],
          operationLabel: 'copilot message',
          truncatedMessage: 'the reply could not be completed',
        });
      } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message }, { status: 502 });
      }
    } else {
      const resolved = resolveClaudeProvider();
      if ('error' in resolved) {
        return NextResponse.json({ success: false, error: resolved.error }, { status: 503 });
      }
      providerUsed = 'claude';
      modelUsed = resolved.provider.model;
      try {
        result = await callClaudeMessage({
          provider: resolved.provider,
          apiKey: resolved.apiKey,
          toolName: tool.name,
          toolDescription: tool.description,
          inputSchema: tool.inputSchema,
          messages: turnMessages,
          system: systemPrompt,
          operationLabel: 'copilot message',
          truncatedMessage: 'the reply could not be completed',
        });
      } catch (e: any) {
        // Same 502 treatment as the Ollama branch above -- a resolved,
        // configured provider that still fails mid-call (HTTP failure,
        // truncation) is a transient upstream problem, not the "isn't
        // configured" case resolveClaudeProvider() already caught as 503.
        return NextResponse.json({ success: false, error: e.message }, { status: 502 });
      }
    }

    let toolCall: { name: string; input: unknown } | undefined;
    if (result.toolCall) {
      const parsed = NavigateToPageInputSchema.safeParse(result.toolCall.input);
      if (parsed.success) {
        toolCall = { name: result.toolCall.name, input: parsed.data };
      }
      // An out-of-enum or malformed path is silently dropped -- the text reply still stands.
    }

    await copilotMessageService.append({
      conversationId,
      role: 'assistant',
      content: result.text,
      toolCall,
      provider: providerUsed,
      model: modelUsed,
    });
    await copilotConversationService.touch(conversationId);

    return NextResponse.json({ success: true, data: { conversationId, reply: { text: result.text, toolCall } } });
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
