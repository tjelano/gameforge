// lib/services/openrouterToolCall.ts
//
// OpenRouter's chat-completions endpoint is OpenAI-shaped, like Ollama's
// tool-calling -- but unlike ollamaToolCall.ts, tool_calls[].function.
// arguments always arrives as a JSON-encoded string (the OpenAI tool-
// calling spec OpenRouter implements), never an already-structured object,
// so there's no "already structured" branch to handle here. No local-
// resource lock either -- OpenRouter is a cloud API shared across
// concurrent requests like Claude's, not a single local GPU.
import type { ProviderMessageResult } from '@/lib/services/copilotTool';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 60_000;

function combineWithTimeout(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
}

export interface OpenRouterMessageParams {
  apiKey: string;
  model: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  messages: Array<{ role: string; content: unknown }>;
  signal?: AbortSignal;
  /** e.g. "copilot message" -- used in the HTTP-failure and truncation error messages. */
  operationLabel: string;
  /** e.g. "the reply could not be completed" -- used in the truncation error message. */
  truncatedMessage: string;
}

interface OpenRouterChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ function: { name: string; arguments: string } }>;
    };
    finish_reason?: string;
  }>;
}

/**
 * Like callClaudeMessage()/callOllamaMessage(): tool use is optional, and
 * the reply may carry text, a tool call, or both.
 */
export async function callOpenRouterMessage(params: OpenRouterMessageParams): Promise<ProviderMessageResult> {
  const { apiKey, model, toolName, toolDescription, inputSchema, messages, signal, operationLabel, truncatedMessage } = params;

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      tools: [{ type: 'function', function: { name: toolName, description: toolDescription, parameters: inputSchema } }],
    }),
    signal: combineWithTimeout(signal),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${operationLabel} failed (${res.status}): ${body || res.statusText}`);
  }

  const data = (await res.json()) as OpenRouterChatResponse;
  const choice = data.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new Error(`OpenRouter response for ${operationLabel} was truncated (finish_reason: length) -- ${truncatedMessage}.`);
  }

  const text = choice?.message?.content ?? '';
  const toolCallRaw = choice?.message?.tool_calls?.[0];
  if (!toolCallRaw) return { text };

  try {
    const input = JSON.parse(toolCallRaw.function.arguments);
    return { text, toolCall: { name: toolCallRaw.function.name, input } };
  } catch {
    // Malformed structured output -- an otherwise-usable text reply still stands.
    return { text };
  }
}
