# Knowledge Base Index

Committed, git-versioned research/decisions archive for this project — see
`~/.claude/skills/knowledge-base/SKILL.md` for the convention this follows. Check here before
starting new research on a topic; don't re-derive something already answered.

## gotchas/
- [Vitest config has no @testing-library/jest-dom](gotchas/vitest-no-jest-dom.md) — use plain-Chai assertions instead of jest-dom matchers.
- [Per-list-item component fetch creates an unbounded N+1](gotchas/per-card-fetch-n-plus-1.md) — a component rendered in a `.map()` fetching its own data independently looks harmless in isolation; check what happens at N=50+.

## backlog/
- [UX backlog raised 2026-09-23](backlog/ux-backlog-2026-09-23.md) — slow nav FIXED, asset previews FIXED (MockGenerator + a separate invalid Pixellab key, both resolved), Drive OAuth 400 FIXED, remaining: copilot history not persisting, unified website-creation flow w/ live editing, copilot-always-prefers-Ollama (added 2026-09-24).

## research/
_(empty)_

## decisions/
_(empty)_

See also: `docs/copilot-knowledge.md` (unrelated — feature reference for the AI copilot's own
grounding, not a notes/knowledge system) and `docs/superpowers/specs/` / `docs/superpowers/plans/`
for formal spec/plan docs, which this index links to rather than duplicates.
