import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'components', 'settings', 'BuiltinToolsSection.tsx'),
  'utf8',
);

describe('BuiltinToolsSection working directory scope', () => {
  it('groups managed worktrees locally without changing the shared active cwd', () => {
    expect(source).toContain(
      "import { normalizeWorkingDirForGrouping } from '../../../shared/workingDir';",
    );
    expect(source).toContain(
      'const activeProjectWorkingDir = normalizeWorkingDirForGrouping(workingDir) ?? undefined;',
    );
    expect(source).toContain(
      'normalizeWorkingDirForGrouping(selectedScope === undefined ? workingDir : selectedScope)',
    );
    expect(source).toContain('const grouped = normalizeWorkingDirForGrouping(p) ?? undefined;');
  });
});
