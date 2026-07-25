import { afterEach, describe, expect, it } from 'vitest';

import { getLastWorkingDir, setLastWorkingDir } from '../state/lastWorkingDir';

describe('lastWorkingDir', () => {
  afterEach(() => setLastWorkingDir(null));

  it('normalizes Cindy-managed worktrees to their base repository for project settings', () => {
    setLastWorkingDir('D:\\projects\\cindy\\.cindy-worktrees\\task-123\\apps\\desktop');
    expect(getLastWorkingDir()).toBe('D:/projects/cindy');

    setLastWorkingDir('/projects/cindy/.xdt-worktrees/task-456/apps/desktop');
    expect(getLastWorkingDir()).toBe('/projects/cindy');
  });

  it('keeps ordinary project directories as the selected project scope', () => {
    setLastWorkingDir('D:\\projects\\cindy\\');
    expect(getLastWorkingDir()).toBe('D:/projects/cindy');
  });
});
