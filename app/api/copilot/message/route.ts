import { NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';
import { getCurrentUser } from '@/lib/utils/session';
import { resolveClaudeProvider } from '@/lib/services/claudeApiProviders';
import { callClaudeMessage } from '@/lib/services/claudeToolCall';
import { callOllamaMessage } from '@/lib/services/ollamaToolCall';
import { callOpenRouterMessage } from '@/lib/services/openrouterToolCall';
import { buildNavigateTool, NavigateToPageInputSchema, type ProviderMessageResult } from '@/lib/services/copilotTool';
import { buildCopilotSystemPrompt } from '@/lib/services/copilotSystemPrompt';
import { copilotConversationService } from '@/lib/services/CopilotConversationService';
import { copilotMessageService } from '@/lib/services/CopilotMessageService';

export const dynamic = 'force-dynamic';

const TITLE_MAX_LENGTH = 60;
const DEFAULT_OPENROUTER_MODEL = 'deepseek/deepseek-v4.1-flash';

const MessageSchema = z.object({
  conversationId: z.string().uuid().optional(),
  text: z.string().min(1).max(4000),
  provider: z.enum(['claude', 'ollama', 'openrouter']).optional(),
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

    // Nothing is persisted until the provider call below succeeds -- a
    // conversation row and/or a dangling, unanswered user message would
    // otherwise survive a provider failure with no way to clean it up (no
    // delete feature), and for Ollama a dangling message gets replayed on
    // every retry, which can brick the conversation once replayed history
    // exceeds num_ctx.
    let conversationId = input.conversationId;
    let priorMessages: Awaited<ReturnType<typeof copilotMessageService.listByConversation>> = [];
    if (conversationId) {
      const existing = await copilotConversationService.getById(conversationId);
      if (!existing) {
        return NextResponse.json({ success: false, error: 'Conversation not found' }, { status: 404 });
      }
      if (existing.created_by !== user.id) {
        return NextResponse.json({ success: false, error: 'You do not have access to this conversation' }, { status: 403 });
      }
      priorMessages = await copilotMessageService.listByConversation(conversationId);
    }

    const tool = buildNavigateTool();
    const systemPrompt = await buildCopilotSystemPrompt();
    const turnMessages = [
      // A stored assistant message can be an empty string when a prior turn
      // was tool-call-only (see test/ollamaToolCall.test.ts) -- replaying an
      // empty content block back to a provider (Anthropic in particular)
      // can get rejected, so drop blanks before they go back out.
      ...priorMessages.filter(m => m.content.trim() !== '').map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: input.text },
    ];

    let result: ProviderMessageResult;
    let providerUsed: 'claude' | 'ollama' | 'openrouter';
    let modelUsed: string;

    if (input.provider === 'openrouter') {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        return NextResponse.json({ success: false, error: 'OpenRouter isn\'t configured -- set OPENROUTER_API_KEY.' }, { status: 503 });
      }
      providerUsed = 'openrouter';
      modelUsed = process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
      try {
        result = await callOpenRouterMessage({
          apiKey,
          model: modelUsed,
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
    } else if (input.provider === 'ollama') {
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

    // Only now, after a successful provider call, do we touch the database.
    if (!conversationId) {
      const title = input.text.length > TITLE_MAX_LENGTH ? `${input.text.slice(0, TITLE_MAX_LENGTH)}…` : input.text;
      const created = await copilotConversationService.create({ title, createdBy: user.id });
      conversationId = created.id;
    }

    await copilotMessageService.append({ conversationId, role: 'user', content: input.text });
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
