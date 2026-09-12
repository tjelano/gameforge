// lib/services/claudeToolCall.ts
//
// Shared by ClaudeApiThemeGenerator, ClaudeApiComponentGenerator, and
// ClaudeApiPageLayoutSuggester: the near-identical ~35-line block each had
// (build headers incl. anthropic-version, POST with a forced tool_choice,
// check res.ok, check stop_reason === 'max_tokens', find the tool_use block)
// now lives once here. Each caller still supplies its own tool
// name/description/schema and its own operationLabel/truncatedMessage
// strings so error messages stay as specific and diagnosable as before —
// this deliberately does not flatten them into one generic message.
import type { ClaudeApiProvider } from '@/lib/services/claudeApiProviders';

const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 60_000;

type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
interface AnthropicMessageResponse {
  content: Array<{ type: string } & Record<string, unknown>>;
  stop_reason: string;
}

// This project's @types/node is ^24.0.0 (Node 20+ typings), so
// AbortSignal.any() is available — used directly, no feature-detection
// fallback for a runtime this project doesn't target.
function combineWithTimeout(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
}

export interface ClaudeToolCallParams {
  provider: ClaudeApiProvider;
  apiKey: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  messages: Array<{ role: string; content: unknown }>;
  maxTokens?: number;
  signal?: AbortSignal;
  /** e.g. "theme generation" — used in the HTTP-failure error message. */
  operationLabel: string;
  /** e.g. "the theme could not be generated" — used in the max_tokens error message. */
  truncatedMessage: string;
}

/**
 * Calls the Anthropic Messages API (or a provider proxying that same shape)
 * with a forced single tool call, and returns the tool_use block's raw
 * `input` — the caller does its own Zod parse against its own tool's
 * schema. Throws a specific Error for each of: HTTP failure, max_tokens
 * truncation, and a missing tool_use block.
 */
export async function callClaudeTool(params: ClaudeToolCallParams): Promise<unknown> {
  const { provider, apiKey, toolName, toolDescription, inputSchema, messages, maxTokens = 4096, signal, operationLabel, truncatedMessage } = params;

  const res = await fetch(provider.requestUrl, {
    method: 'POST',
    headers: {
      ...provider.buildAuthHeaders(apiKey),
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: maxTokens,
      tools: [{ name: toolName, description: toolDescription, input_schema: inputSchema }],
      tool_choice: { type: 'tool', name: toolName },
      messages,
    }),
    signal: combineWithTimeout(signal),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic ${operationLabel} failed via ${provider.name} (${res.status}): ${body || res.statusText}`);
  }

  const data = (await res.json()) as AnthropicMessageResponse;
  if (data.stop_reason === 'max_tokens') {
    throw new Error(`Anthropic response (via ${provider.name}) was truncated (stop_reason: max_tokens) before completing the tool call — ${truncatedMessage}.`);
  }
  const toolUse = data.content.find((block): block is ToolUseBlock => block.type === 'tool_use');
  if (!toolUse) {
    throw new Error(`Anthropic response (via ${provider.name}) contained no tool_use block for ${toolName}.`);
  }
  return toolUse.input;
}
