// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
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
    expect(getState).toHaveBeenCalledWith('collab', 'C:/projects/cindy');
  });

  it('refreshes the project policy when the window regains focus', async () => {
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ effectiveEnabled: true })
      .mockResolvedValueOnce({ effectiveEnabled: false });
    (window as unknown as { electronAPI: { maker: { plugins: { getState: typeof getState } } } }).electronAPI = {
      maker: { plugins: { getState } },
    };

    const { result } = renderHook(() => useCollabProjectPolicy('C:\\projects\\cindy', true));
    await waitFor(() => expect(result.current.enabled).toBe(true));

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(result.current.enabled).toBe(false));
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it('refreshes only when a visibility change brings the document to the foreground', async () => {
    let visibilityState: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState);
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ effectiveEnabled: true })
      .mockResolvedValueOnce({ effectiveEnabled: false });
    (window as unknown as { electronAPI: { maker: { plugins: { getState: typeof getState } } } }).electronAPI = {
      maker: { plugins: { getState } },
    };

    const { result } = renderHook(() => useCollabProjectPolicy('C:\\projects\\cindy', true));
    await waitFor(() => expect(result.current.enabled).toBe(true));

    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(getState).toHaveBeenCalledTimes(1);

    visibilityState = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(result.current.enabled).toBe(false));
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it('allows an unavailable policy to be retried without leaving the current window', async () => {
    const getState = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary IPC failure'))
      .mockResolvedValueOnce({ effectiveEnabled: true });
    (window as unknown as { electronAPI: { maker: { plugins: { getState: typeof getState } } } }).electronAPI = {
      maker: { plugins: { getState } },
    };

    const { result } = renderHook(() => useCollabProjectPolicy('C:\\projects\\cindy', true));
    await waitFor(() => expect(result.current.unavailable).toBe(true));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.enabled).toBe(true));
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it('does not keep global refresh listeners for ineligible sessions', async () => {
    const getState = vi.fn().mockResolvedValue({ effectiveEnabled: true });
    (window as unknown as { electronAPI: { maker: { plugins: { getState: typeof getState } } } }).electronAPI = {
      maker: { plugins: { getState } },
    };

    const { result, rerender } = renderHook(
      ({ eligible }: { eligible: boolean }) =>
        useCollabProjectPolicy('C:\\projects\\cindy', eligible),
      { initialProps: { eligible: true } },
    );
    await waitFor(() => expect(result.current.enabled).toBe(true));

    rerender({ eligible: false });
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('cindy:project-plugin-state-changed'));
    });
    expect(getState).toHaveBeenCalledTimes(1);
  });
});
