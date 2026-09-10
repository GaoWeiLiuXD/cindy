import { throwIpcError } from '../utils/ipcValidate.js';
import type { AgentKind } from '@cindy/maker-core';
import { normalizeBotModelChain, type BotModelRoute } from '../../shared/botModelChain.js';

interface RuntimeRoute {
  agentKind: AgentKind;
  model: string;
  providerId: string | null;
  effort: string | null;
  fastMode: boolean;
}

interface BotRouteState {
  chain: BotModelRoute[];
  current: RuntimeRoute;
  hasRuntimeOverride: boolean;
  followsCindyDefault?: boolean;
  next?: RuntimeRoute;
}

function configuredRoute(state: BotRouteState, previous: string | undefined, chain = state.chain): RuntimeRoute | null {
  const key = JSON.stringify(chain);
  const isDraftChange = key !== JSON.stringify(state.chain);
  if (!state.followsCindyDefault && !isDraftChange && state.hasRuntimeOverride && (previous === undefined || previous === key)) return null;
  const primary = chain[0];
  if (!primary) return null;
  return {
    agentKind: primary.harness === 'claude' ? 'claude-code' : primary.harness,
    model: primary.model, providerId: primary.providerId,
    effort: primary.effort || null, fastMode: primary.fastMode,
  };
}

function sameRoute(a: RuntimeRoute, b: RuntimeRoute): boolean {
  return a.agentKind === b.agentKind && a.model === b.model && a.providerId === b.providerId
    && a.effort === b.effort && a.fastMode === b.fastMode;
}

/** Apply the permanent profile through ordinary Session model/switch controls.
 * Fallback and Agent choices remain effective until the configured chain changes.
 * Background tasks keep their frozen route; the reader selects canonical tasks only.
 */
export function createBotModelRouteReconciler(deps: {
  ownerEpoch(): string;
  withSessionLock?<T>(sessionId: string, run: () => Promise<T>): Promise<T>;
  read(sessionId: string, purpose: 'apply' | 'preview'): Promise<BotRouteState | null>;
  apply(sessionId: string, route: RuntimeRoute, current: RuntimeRoute): Promise<void>;
}) {
  let owner: string | undefined;
  const configured = new Map<string, string>();
  const inFlight = new Map<string, Promise<void>>();
  const syncOwner = () => {
    const epoch = deps.ownerEpoch();
    if (owner !== epoch) {
      owner = epoch;
      configured.clear();
      inFlight.clear();
    }
    return epoch;
  };
  const reconcile = async (sessionId: string, sessionLockHeld = false): Promise<void> => {
    const epoch = syncOwner();
    const existing = inFlight.get(sessionId);
    if (existing && !sessionLockHeld) return existing;
    const run = async () => {
      const state = await deps.read(sessionId, 'apply');
      if (deps.ownerEpoch() !== epoch) throw new Error('Bot model route owner changed');
      if (!state) {
        configured.delete(sessionId);
        return;
      }
      if (!state.chain.length) {
        configured.delete(sessionId);
        throwIpcError('PRECONDITION_FAILED', '请先选择已开启的伙伴模型');
      }
      const key = JSON.stringify(state.chain);
      const route = configuredRoute(state, configured.get(sessionId));
      if (!route) {
        configured.set(sessionId, key);
        return;
      }
      const current = state.current;
      if (!sameRoute(route, current) || (state.next && !sameRoute(route, state.next))) {
        await deps.apply(sessionId, route, current);
      }
      if (deps.ownerEpoch() !== epoch) throw new Error('Bot model route owner changed');
      configured.set(sessionId, key);
    };
    // Read after acquiring the same lock as ordinary sends. A caller already
    // inside that lock must never await an outside reconcile queued behind it.
    if (sessionLockHeld) return run();
    const operation = deps.withSessionLock ? deps.withSessionLock(sessionId, run) : run();
    inFlight.set(sessionId, operation);
    try { await operation; } finally {
      if (inFlight.get(sessionId) === operation) inFlight.delete(sessionId);
    }
  };
  return Object.assign(reconcile, {
    /** Read-only preview: sharing the send decision must not consume a profile change. */
    async preview(sessionId: string, draftChain?: BotModelRoute[]): Promise<RuntimeRoute | null> {
      const epoch = syncOwner();
      await inFlight.get(sessionId);
      const state = await deps.read(sessionId, 'preview');
      if (deps.ownerEpoch() !== epoch) throw new Error('Bot model route owner changed');
      if (!state?.chain.length) return null;
      return configuredRoute(state, configured.get(sessionId), draftChain ? normalizeBotModelChain(draftChain) : undefined)
        ?? state.next ?? state.current;
    },
  });
}
