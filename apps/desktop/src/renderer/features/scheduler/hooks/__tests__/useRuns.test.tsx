// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRuns } from '../useRuns';

type Listener = (payload: unknown) => void;

let scheduleListeners: Listener[] = [];
let turnCostListeners: Listener[] = [];
let listRuns: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scheduleListeners = [];
  turnCostListeners = [];
  listRuns = vi.fn(async () => []);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      schedule: {
        listRuns,
        onEvent: (listener: Listener) => {
          scheduleListeners.push(listener);
          return () => {
            scheduleListeners = scheduleListeners.filter((item) => item !== listener);
          };
        },
      },
    },
    onUsageMessageTurnCost: (listener: Listener) => {
      turnCostListeners.push(listener);
      return () => {
        turnCostListeners = turnCostListeners.filter((item) => item !== listener);
      };
    },
  };
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.restoreAllMocks();
});

describe('useRuns 异步费用刷新', () => {
  it('费用广播晚于 completed 时重新读取运行历史', async () => {
    const { unmount } = renderHook(() => useRuns('schedule-1'));
    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(1));

    act(() => {
      turnCostListeners.forEach((listener) =>
        listener({ sessionId: 'session-1', clientId: 'assistant-1', turnCostUsd: 0.42 }),
      );
    });

    await waitFor(() => expect(listRuns).toHaveBeenCalledTimes(2));
    unmount();
    expect(turnCostListeners).toHaveLength(0);
  });
});
