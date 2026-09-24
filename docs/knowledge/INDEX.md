# Knowledge Base Index

Committed, git-versioned research/decisions archive for this project — see
`~/.claude/skills/knowledge-base/SKILL.md` for the convention this follows. Check here before
starting new research on a topic; don't re-derive something already answered.

## gotchas/
- [Vitest config has no @testing-library/jest-dom](gotchas/vitest-no-jest-dom.md) — use plain-Chai assertions instead of jest-dom matchers.
- [Per-list-item component fetch creates an unbounded N+1](gotchas/per-card-fetch-n-plus-1.md) — a component rendered in a `.map()` fetching its own data independently looks harmless in isolation; check what happens at N=50+.

## backlog/
- [UX backlog raised 2026-09-23](backlog/ux-backlog-2026-09-23.md) — slow nav (real cause found + fixed 2026-09-24, was an N+1 API pattern not a missing loading.tsx), broken asset previews, unified website-creation flow w/ live editing, Drive OAuth error 400, copilot history not persisting.

## research/
_(empty)_

## decisions/
_(empty)_

See also: `docs/copilot-knowledge.md` (unrelated — feature reference for the AI copilot's own
grounding, not a notes/knowledge system) and `docs/superpowers/specs/` / `docs/superpowers/plans/`
for formal spec/plan docs, which this index links to rather than duplicates.
