'use client';

import { useState } from 'react';

const QUICK_START = `GameForge uses an adversarial code-review technique worth borrowing for any project: alongside whatever AI coding assistant you're using to write code, have a SEPARATE, different-vendor model review it critically before you trust it -- cross-model review catches blind spots a same-model "review my own work" pass can't see.

This repo already has it set up at .claude/skills/deepseek-review/ -- if you have Claude Code open here, just ask it to "deepseek review this diff" or "deepseek review my plan" once you've set an OPENROUTER_API_KEY (get one at openrouter.ai -- a few dollars of credit covers a huge number of reviews, each call costs fractions of a cent).

To bring the same technique to a different project: the core idea is a plain chat-completions API call (no filesystem access needed) with a system prompt along these lines --

"You are an adversarial reviewer. Your mandate is to kill this [plan/diff], not improve it -- it only survives if you genuinely can't find a way to break it. You have no filesystem access; everything you need will be pasted to you. Attack from three angles: (1) what would a naive read-through miss? (2) does it actually do what it claims? (3) does it cross a hard boundary -- security, data loss, concurrency? One finding per line: what's wrong, why it matters, a one-line fix."

...then paste the diff/plan/relevant code directly into the message (the model can't fetch it itself), and treat every finding as a claim to verify against the real code yourself, not a fact -- expect roughly 1 in 5 "important" findings to actually hold up. The value is in the one that's real, not blind trust in all five.

Worth being explicit about: this pastes real source code into a third-party API. That's a conscious tradeoff to make per-project, not a default to enable without thinking about it.`;

type CopyState = 'idle' | 'copied' | 'failed';

export default function DeepSeekReviewSettingsPage() {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(QUICK_START);
      setCopyState('copied');
    } catch {
      // Clipboard access can fail (permissions, insecure context) -- the
      // text is still fully visible and selectable below as a fallback,
      // but say so explicitly rather than leaving the button unchanged,
      // which could read as "nothing happened" rather than "it failed."
      setCopyState('failed');
    } finally {
      setTimeout(() => setCopyState('idle'), 2000);
    }
  }

  return (
    <>
      <h1 className="page-title">DeepSeek Review</h1>
      <p className="page-subtitle">
        A cross-model adversarial code-review technique this project uses internally. Not a
        GameForge feature — a Claude Code skill, already set up in this repo.
      </p>

      <div className="card" style={{ maxWidth: 640 }}>
        <p style={{ marginTop: 0 }}>
          One model writes the code, a different model — DeepSeek V4.1 Flash, via OpenRouter —
          critiques it before you trust it. Cross-model review catches blind spots a same-model
          &quot;review my own work&quot; pass can&apos;t see.
        </p>
        <p>
          This repo already has it at{' '}
          <code>.claude/skills/deepseek-review/</code> — if you have Claude Code open here, just
          ask it to &quot;deepseek review this diff&quot; once you&apos;ve set an{' '}
          <code>OPENROUTER_API_KEY</code> (get one at{' '}
          <a href="https://openrouter.ai" target="_blank" rel="noopener noreferrer">
            openrouter.ai
          </a>
          ).
        </p>
        <p style={{ color: 'var(--ink-dim)', fontSize: 13 }}>
          Worth knowing: this pastes real source code and diffs into a third-party API (OpenRouter).
          That&apos;s a conscious tradeoff to make per-project, not a default to enable without
          thinking about it.
        </p>

        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="quick-start">
            Quick-start prompt — copy this into a fresh Claude conversation to bring the technique
            to a different project
          </label>
          <textarea
            id="quick-start"
            readOnly
            value={QUICK_START}
            rows={14}
            style={{ fontFamily: 'monospace', fontSize: 13, resize: 'vertical' }}
            onFocus={e => e.currentTarget.select()}
          />
        </div>
        <button className="btn btn-primary" onClick={handleCopy} style={{ marginTop: 12 }}>
          {copyState === 'copied' ? 'Copied!' : copyState === 'failed' ? 'Copy failed — select the text above' : 'Copy prompt'}
        </button>
      </div>
    </>
  );
}
