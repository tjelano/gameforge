//
// Mirrors claudeToolCall.ts's call shape for a second provider. Ollama has
// no forced tool-choice (confirmed directly against Ollama's own API docs)
// -- the model decides for itself whether to call the one tool offered,
// and can just return plain text instead. Since only one tool is ever
// offered, "wrong tool" isn't a real risk; "no tool call at all" is a
// real, EXPECTED failure mode here, not a rare edge case, and every branch
// below treats it that way.

// Local inference (especially CPU-only) is much slower than a cloud API --
// claudeToolCall.ts's 60s is too tight here.
const OLLAMA_REQUEST_TIMEOUT_MS = 120_000;

// All 3 in-scope schemas (theme tokens, component html/css, page-layout
// order array) are small and flat -- verified directly against their real
// definitions, none use oneOf/anyOf/enum. One generous constant covers
// prompt + schema + output for all 3 without a per-call estimation formula.
const DEFAULT_NUM_CTX = 8192;

export const OLLAMA_NO_TOOL_CALL_ERROR_PREFIX = 'Ollama model did not produce structured output';

export interface OllamaProviderOverride {
  type: 'ollama';
  host: string;
  model: string;
  /** Set by the "Retry with correction" flow (Task 10) to add one corrective instruction. */
  correctionRequested?: boolean;
}

export interface OllamaToolCallParams {
  host: string;
  model: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  messages: Array<{ role: string; content: unknown }>;
  signal?: AbortSignal;
  /** e.g. "theme generation" -- used in the HTTP-failure and truncation error messages. */
  operationLabel: string;
  /** e.g. "the theme could not be generated" -- used in the truncation error message. */
  truncatedMessage: string;
}

interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  };
  done: boolean;
  prompt_eval_count?: number;
}

function combineWithTimeout(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
}

// GameForge's worker processes up to WORKER_BATCH_SIZE (default 5) jobs
// concurrently (see worker.ts's processJobs()) -- fine for a cloud API that
// scales independently of this machine, but firing several concurrent
// generations at one local Ollama daemon on typical consumer hardware (one
// GPU, finite VRAM) risks real resource contention. This serializes every
// Ollama call from this process: one in flight at a time, others wait
// their turn. A single global lock, not per-host/per-model -- the
// simplest thing that removes the real risk.
// ponytail: global lock, per-account locks if throughput matters
let ollamaCallLock: Promise<void> = Promise.resolve();

async function withOllamaLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = ollamaCallLock;
  let release!: () => void;
  ollamaCallLock = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Calls Ollama's native /api/chat (never the OpenAI-compatible endpoint --
 * that endpoint has no way to set num_ctx, risking silent truncation of a
 * large tool schema under the small default context window) with a single
 * offered tool, and returns the tool call's raw `arguments` -- the caller
 * does its own Zod parse against its own tool's schema, same contract as
 * callClaudeTool. Throws a specific Error for an HTTP failure, a
 * truncation, and -- the real, expected case with Ollama -- no tool call
 * at all.
 */
export async function callOllamaTool(params: OllamaToolCallParams): Promise<unknown> {
  const { host, model, toolName, toolDescription, inputSchema, messages, signal, operationLabel, truncatedMessage } = params;

  return withOllamaLock(async () => {
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages,
        tools: [{ type: 'function', function: { name: toolName, description: toolDescription, parameters: inputSchema } }],
        options: { num_ctx: DEFAULT_NUM_CTX },
      }),
      signal: combineWithTimeout(signal),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama ${operationLabel} failed (${res.status}): ${body || res.statusText}`);
    }

    const data = (await res.json()) as OllamaChatResponse;

    if (typeof data.prompt_eval_count === 'number' && data.prompt_eval_count >= DEFAULT_NUM_CTX) {
      throw new Error(`Ollama response for ${operationLabel} was truncated (prompt_eval_count reached num_ctx) -- ${truncatedMessage}.`);
    }

    const toolCall = data.message?.tool_calls?.[0];
    if (!toolCall) {
      throw new Error(`${OLLAMA_NO_TOOL_CALL_ERROR_PREFIX} for ${toolName} (model: ${model}) -- try a different model, or retry with a correction.`);
    }

    const args = toolCall.function.arguments;
    if (typeof args === 'string') {
      // Nested tool-call arguments come back as a JSON-encoded string, not
      // structured JSON -- a real, documented Ollama quirk. A malformed
      // string maps to the same hard-fail error as "no tool call at all",
      // not a raw parse exception -- the request was fine, the model's
      // output wasn't.
      try {
        return JSON.parse(args);
      } catch {
        throw new Error(`${OLLAMA_NO_TOOL_CALL_ERROR_PREFIX} for ${toolName} (model: ${model}) -- the model's structured output was malformed.`);
      }
    }
    return args;
  });
}
