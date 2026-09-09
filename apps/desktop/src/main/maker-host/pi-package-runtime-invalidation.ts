import type { Maker, Session, PiManagedPackageRuntimeConvergence } from '@cindy/maker-core';

import type { PiPackagesChangeOrigin } from './pi-package-store.js';

/**
 * Stop every live local ordinary Pi runtime after Settings changes the managed
 * package roster. Pi loads extensions only at process startup, so leaving an
 * existing process alive would make the Settings state a lie: disabled code
 * could keep exposing tools, or a newly enabled package would remain absent.
 *
 * Remote and Review runtimes never load this local managed-package roster and
 * are deliberately outside this invalidation boundary.
 */
export interface PiPackageRuntimeInvalidationResult {
  requestedSessionIds: string[];
  failedSessionIds: string[];
  deferredSessionIds?: string[];
}

type InvalidationMaker = Pick<
  Maker,
  | 'advanceLocalPiPackageRuntimeGeneration'
  | 'listActiveSessions'
  | 'getSessionMeta'
  | 'closeSessionIfCurrent'
>;

export async function invalidateLocalPiPackageRuntimesForObservedChange(
  maker: InvalidationMaker,
  origin: PiPackagesChangeOrigin,
): Promise<PiPackageRuntimeInvalidationResult | null> {
  if (origin !== 'external-runtime') return null;
  return invalidateLocalPiPackageRuntimes(maker);
}

interface PiPackageRuntimeSnapshotEntry {
  session: Session;
  eligible: boolean;
  metadataFailed: boolean;
}

export interface PiPackageRuntimeInvalidationSnapshot {
  entries: readonly PiPackageRuntimeSnapshotEntry[];
}

/** Fence startup and bind the exact runtime instances that predate the mutation. */
export async function captureLocalPiPackageRuntimeInvalidationSnapshot(
  maker: InvalidationMaker,
): Promise<PiPackageRuntimeInvalidationSnapshot> {
  maker.advanceLocalPiPackageRuntimeGeneration();
  const candidates = maker.listActiveSessions().filter((session) => session.agentKind === 'pi');
  const entries = await Promise.all(candidates.map(async (session) => {
    try {
      const meta = await maker.getSessionMeta(session.id);
      return {
        session,
        eligible: Boolean(meta && !meta.remoteHostId && !meta.reviewMode),
        metadataFailed: meta === null,
      };
    } catch {
      // Unknown metadata cannot safely cross the remote/Review boundary.
      return { session, eligible: false, metadataFailed: true };
    }
  }));
  return { entries };
}

/** Retire only exact instances captured at the durable mutation edge. */
export async function invalidateLocalPiPackageRuntimeSnapshot(
  maker: InvalidationMaker,
  snapshot: PiPackageRuntimeInvalidationSnapshot,
  opts?: { afterCurrentTurn?: boolean },
): Promise<PiPackageRuntimeInvalidationResult> {
  const eligible = snapshot.entries.filter((entry) => entry.eligible);
  const requestedSessionIds = eligible.map(({ session }) => session.id);
  const outcomes = await Promise.allSettled(
    eligible.map(({ session }) => opts?.afterCurrentTurn
      ? maker.closeSessionIfCurrent(session, 'runtime-refresh', opts)
      : maker.closeSessionIfCurrent(session, 'requested')),
  );
  return {
    requestedSessionIds,
    ...(opts?.afterCurrentTurn ? {
      deferredSessionIds: outcomes.flatMap((outcome, index) =>
        outcome.status === 'fulfilled' && outcome.value === 'deferred'
          ? [requestedSessionIds[index]!] : []),
    } : {}),
    failedSessionIds: [
      ...snapshot.entries.flatMap(({ session, metadataFailed }) => (
        metadataFailed ? [session.id] : []
      )),
      ...outcomes.flatMap((outcome, index) => (
        outcome.status === 'rejected' ? [requestedSessionIds[index]!] : []
      )),
    ],
  };
}

/** A tool receipt is not a consumed result: retain every in-flight caller/sibling. */
export async function settleLocalPiPackageRuntimeSnapshot(
  maker: InvalidationMaker,
  snapshot: PiPackageRuntimeInvalidationSnapshot,
  callerSessionId?: string,
): Promise<PiManagedPackageRuntimeConvergence> {
  const result = await invalidateLocalPiPackageRuntimeSnapshot(maker, snapshot, { afterCurrentTurn: true });
  if (result.failedSessionIds.length > 0
    || (callerSessionId && !snapshot.entries.some(({ session, eligible }) => eligible && session.id === callerSessionId))) return {
    runtimeConvergence: 'partial', recoveryAction: 'restart-cindy-to-refresh-packages',
  };
  return { runtimeConvergence: result.deferredSessionIds?.length ? 'deferred' : 'complete' };
}

export async function invalidateLocalPiPackageRuntimes(
  maker: InvalidationMaker,
): Promise<PiPackageRuntimeInvalidationResult> {
  const snapshot = await captureLocalPiPackageRuntimeInvalidationSnapshot(maker);
  return invalidateLocalPiPackageRuntimeSnapshot(maker, snapshot);
}
