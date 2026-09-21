// lib/services/providerOverride.ts
//
// Cross-provider override for a single generation call, letting a job opt
// out of the server-configured default (Claude via ANTHROPIC_API_KEY /
// CHEAPERINFERENCE_API_KEY) and use a different backend instead. Lives here
// rather than in ollamaToolCall.ts (its original home before OpenRouter
// support) since every generator class consumes it regardless of provider,
// not just the Ollama path.
export interface OllamaProviderOverride {
  type: 'ollama';
  host: string;
  model: string;
  /** Set by the "Retry with correction" flow to add one corrective instruction. */
  correctionRequested?: boolean;
}

export interface OpenRouterProviderOverride {
  type: 'openrouter';
  model: string;
  /** Set by the "Retry with correction" flow to add one corrective instruction. */
  correctionRequested?: boolean;
}

export type ProviderOverride = OllamaProviderOverride | OpenRouterProviderOverride;
