import { defineConfig } from 'vitest/config';

// Windows note: running from Git Bash with an MSYS path (`cd /d/...`) makes the
// drive letter's case differ, so vitest loads itself twice ("Cannot read
// properties of undefined (reading 'config')"). Run from PowerShell / the
// VS Code terminal, or `cd 'D:\path\to\repo'` in Git Bash first.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
});
