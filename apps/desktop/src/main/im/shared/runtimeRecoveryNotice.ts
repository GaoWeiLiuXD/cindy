import type { Session } from '@cindy/maker-core';

// One actual channel owner per runtime. A product terminal does not unsubscribe:
// retirement can fail afterwards. Runtime termination/replacement releases it.
const owners = new WeakMap<Session, () => void>();

export function bindRuntimeRecoveryNotice(
  session: Session,
  deliver: (text: string) => Promise<unknown>,
  log: { warn(message: string): void },
): void {
  if (session.agentKind !== 'pi') return;
  owners.get(session)?.();
  const generation = session.getTurnGeneration();
  const cleanup = (): void => {
    offEvent();
    offStatus();
    if (owners.get(session) === cleanup) owners.delete(session);
  };
  const offEvent = session.onEvent((event) => {
    if (!event.runtimeRecovery || event.sessionInstanceId !== session.instanceId
      || event.sessionTurnGeneration !== generation || event.type !== 'text') return;
    const text = (event.data as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || !text) return;
    cleanup(); // Claim once before invoking any asynchronous channel operation.
    try {
      void deliver(text).then((result) => {
        if (result === false) log.warn('runtime recovery channel notice was not delivered');
      }).catch(() => log.warn('runtime recovery channel notice delivery failed'));
    } catch {
      log.warn('runtime recovery channel notice delivery failed');
    }
  });
  const offStatus = session.onStatusChange((status) => {
    if (status === 'closed' || status === 'error') cleanup();
  });
  owners.set(session, cleanup);
}
