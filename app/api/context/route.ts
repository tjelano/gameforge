import { NextResponse } from 'next/server';
import { getProjectContextSummary } from '@/lib/services/projectContext';

export const dynamic = 'force-dynamic';

/**
 * Modular context summary for AI assistants (AGENTS.md/CLAUDE.md-facing).
 * The blueprint names this endpoint but never specifies its shape — this
 * is an inferred minimal design: current styles, asset counts per style,
 * and in-flight job counts, so an assistant can orient without querying
 * the DB directly. Extend as concrete AI-assistant use cases emerge.
 */
export async function GET() {
  try {
    const data = await getProjectContextSummary();
    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
