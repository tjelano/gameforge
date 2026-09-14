import fsPromises from 'fs/promises';
import path from 'path';
import { getProjectRoot } from '@/lib/utils/projectRoot';
import { getProjectContextSummary } from '@/lib/services/projectContext';

const ESCALATION_INSTRUCTION = 'If the knowledge doc above and the live project state below don\'t clearly answer the question, say so plainly and ask a clarifying question instead of guessing -- never invent a GameForge feature, setting, or path that isn\'t described above.';

/**
 * Assembles the copilot's full system prompt fresh on every call (the live
 * project state below can change between messages, so this is never
 * cached across turns): the curated knowledge doc verbatim, the current
 * project state as JSON, then a fixed escalation instruction. See
 * docs/superpowers/specs/2026-09-13-dashboard-ai-copilot-design.md,
 * Section 3, for why this is a prompt-level instruction rather than a
 * computed confidence score.
 */
export async function buildCopilotSystemPrompt(): Promise<string> {
  let knowledgeDoc: string;
  try {
    knowledgeDoc = await fsPromises.readFile(path.join(getProjectRoot(), 'docs', 'copilot-knowledge.md'), 'utf-8');
  } catch (e) {
    console.error('Failed to read docs/copilot-knowledge.md:', e);
    knowledgeDoc = '';
  }

  const context = await getProjectContextSummary();

  return [
    knowledgeDoc,
    '## Current project state',
    JSON.stringify(context, null, 2),
    ESCALATION_INSTRUCTION,
  ].join('\n\n');
}
