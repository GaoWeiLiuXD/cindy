import { useEffect, useState } from 'react';

import { createLogger } from '@/lib/logger';

const log = createLogger('useCollabProjectPolicy');

interface PolicyState {
  workingDir: string | null;
  enabled: boolean | null;
  unavailable: boolean;
}

export interface CollabProjectPolicy {
  enabled: boolean;
  loading: boolean;
  unavailable: boolean;
}

/**
 * Reads the effective project-scoped collab plugin state for renderer gating.
 * Main IPC authorization remains authoritative for every create request.
 */
export function useCollabProjectPolicy(
  workingDir: string | null | undefined,
  eligible: boolean,
): CollabProjectPolicy {
  const requestedWorkingDir = eligible && workingDir ? workingDir : null;
  const [state, setState] = useState<PolicyState>({
    workingDir: null,
    enabled: requestedWorkingDir == null ? false : null,
    unavailable: false,
  });

  useEffect(() => {
    if (!requestedWorkingDir) {
      setState({ workingDir: null, enabled: false, unavailable: false });
      return;
    }

    let cancelled = false;
    setState({ workingDir: requestedWorkingDir, enabled: null, unavailable: false });
    void window.electronAPI.maker.plugins
      .getState('collab', requestedWorkingDir)
      .then((next) => {
        if (cancelled) return;
        setState({
          workingDir: requestedWorkingDir,
          enabled: next.effectiveEnabled,
          unavailable: false,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        log.warn('failed to read project collab policy', {
          workingDir: requestedWorkingDir,
          err,
        });
        // Fail closed for starting collaboration, but do not turn a transient
        // policy read failure into a persisted "disabled" user choice.
        setState({ workingDir: requestedWorkingDir, enabled: null, unavailable: true });
      });

    return () => {
      cancelled = true;
    };
  }, [requestedWorkingDir]);

  const current = state.workingDir === requestedWorkingDir ? state.enabled : null;
  const unavailable =
    state.workingDir === requestedWorkingDir && current === null && state.unavailable;
  return {
    enabled: current === true,
    loading: current === null && !unavailable,
    unavailable,
  };
}
