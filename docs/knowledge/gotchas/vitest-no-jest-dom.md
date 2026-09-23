---
title: Vitest config has no @testing-library/jest-dom
date: 2026-09-22
tags: [testing, vitest]
---

`@testing-library/jest-dom` is NOT installed or wired into this project's `vitest.config.*` (no
`setupFiles` entry for it). Any jest-dom matcher — `toHaveAttribute`, `toBeInTheDocument`,
`toHaveClass`, `toBeVisible`, etc. — throws `Invalid Chai property: <matcher>` at runtime, not a
type error, so it won't be caught until the test actually runs.

Use plain-Chai equivalents instead, matching the established pattern already used across this
codebase's test suite (e.g. `test/stylesPageCreateError.test.tsx`):
- `expect(el.getAttribute('id')).toBe('foo')` instead of `expect(el).toHaveAttribute('id', 'foo')`
- `expect(document.body.contains(el)).toBe(true)` instead of `expect(el).toBeInTheDocument()`
- `expect(el.className).toContain('foo')` instead of `expect(el).toHaveClass('foo')`

Discovered independently twice in the same session (2026-09-22/23, the `audit-fixes-2` SDD run)
when two different task implementers hit this while writing new accessibility tests. Worth
checking for before writing any new test that asserts on a DOM attribute/class — re-verify
`@testing-library/jest-dom` is still absent before trusting this note, in case it's added later.
