import { configDefaults, defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    testTimeout: 15000,
    // Nested git worktrees (.worktrees/, .claude/worktrees/) each carry a
    // full copy of this repo, including their own test/ directory. Without
    // this, a worktree left in place after merging (rather than cleaned up
    // immediately) gets its tests collected and run a second time under the
    // MAIN checkout's environment/credentials — real failures, not a
    // regression in this checkout's own code. Confirmed by counting: 85
    // real files in this checkout's test/, 172 collected before this fix.
    exclude: [...configDefaults.exclude, '**/.worktrees/**', '**/.claude/worktrees/**'],
  },
});
