// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCollabProjectPolicy } from '../useCollabProjectPolicy';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
  }),
}));

describe('useCollabProjectPolicy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reports an unavailable policy without converting it into an explicit disable', async () => {
    const getState = vi.fn().mockRejectedValue(new Error('temporary IPC failure'));
    (window as unknown as { electronAPI: { maker: { plugins: { getState: typeof getState } } } }).electronAPI = {
      maker: { plugins: { getState } },
    };

    const { result } = renderHook(() => useCollabProjectPolicy('C:\\projects\\cindy', true));

    await waitFor(() => expect(result.current.unavailable).toBe(true));

    expect(result.current.enabled).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(getState).toHaveBeenCalledWith('collab', 'C:\\projects\\cindy');
  });
});
