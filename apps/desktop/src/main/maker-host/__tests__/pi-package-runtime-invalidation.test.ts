import { Session, type Maker, type AgentEvent, type AgentSessionHandle } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import {
  captureLocalPiPackageRuntimeInvalidationSnapshot,
  invalidateLocalPiPackageRuntimeSnapshot,
  invalidateLocalPiPackageRuntimes,
  invalidateLocalPiPackageRuntimesForObservedChange,
  settleLocalPiPackageRuntimeSnapshot,
} from '../pi-package-runtime-invalidation.js';

type InvalidationMaker = Pick<
  Maker,
  | 'advanceLocalPiPackageRuntimeGeneration'
  | 'listActiveSessions'
  | 'getSessionMeta'
  | 'closeSessionIfCurrent'
>;

function session(id: string, agentKind: Session['agentKind']): Session {
  return { id, agentKind } as Session;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('Pi package runtime invalidation', () => {
  it('keeps both busy caller and sibling alive, delivers their results, and retires each independently', async () => {
    function live(id: string) {
      const pending: AgentEvent[] = [];
      let wake: (() => void) | undefined;
      let running = false;
      let ended = false;
      const emit = (event: AgentEvent) => { pending.push(event); wake?.(); };
      const close = vi.fn(async () => { ended = true; wake?.(); });
      const handle = {
        id, agentKind: 'pi', model: 'm', close,
        send: vi.fn(async () => { running = true; }),
        isTurnRunning: () => running,
        setInteractionResolver() {},
        async *events() {
          while (!ended || pending.length) {
            if (!pending.length) await new Promise<void>((resolve) => { wake = resolve; });
            const event = pending.shift();
            if (event) yield event;
          }
        },
      } as unknown as AgentSessionHandle;
      const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
      const instance = new Session({ id, agentKind: 'pi', workDir: '/repo', handle,
        capabilities: {} as never, logger, turnStallMs: 0 });
      const seen: AgentEvent[] = [];
      instance.onEvent((event) => seen.push(event));
      const finish = (result: string) => {
        running = false;
        emit({ type: 'text', source: 'pi', data: { text: result } });
        emit({ type: 'done', source: 'pi', data: { status: 'completed', result } });
      };
      return { instance, handle, close, emit, seen, finish };
    }
    const caller = live('caller');
    const sibling = live('sibling');
    const idle = live('idle');
    const instances = [caller, sibling, idle].map((entry) => entry.instance);
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: () => instances,
      getSessionMeta: vi.fn(async (id: string) => ({ id, agentKind: 'pi' as const, workDir: '/repo',
        model: 'm', title: id, createdAt: 1, updatedAt: 1 })),
      closeSessionIfCurrent: async (instance, _reason, opts) => opts?.afterCurrentTurn
        ? instance.closeAfterCurrentTurn() : (await instance.close(), 'closed'),
    };
    await caller.instance.send('update and continue');
    await sibling.instance.send('build');
    const snapshot = await captureLocalPiPackageRuntimeInvalidationSnapshot(maker);
    caller.emit({ type: 'tool_result', source: 'pi', data: { toolUseId: 'update', isError: true } });
    expect(await settleLocalPiPackageRuntimeSnapshot(maker, snapshot)).toEqual({ runtimeConvergence: 'deferred' });
    expect(idle.close).toHaveBeenCalledOnce();
    expect(caller.close).not.toHaveBeenCalled();
    expect(sibling.close).not.toHaveBeenCalled();
    caller.finish('update failed; here is the result');
    await vi.waitFor(() => expect(caller.instance.getStatus()).toBe('closed'));
    expect(caller.seen.map((event) => event.type)).toEqual(['tool_result', 'text', 'done']);
    expect(sibling.close).not.toHaveBeenCalled();
    sibling.finish('build finished');
    await vi.waitFor(() => expect(sibling.instance.getStatus()).toBe('closed'));
    expect(sibling.seen.at(-1)?.data).toMatchObject({ result: 'build finished' });
    expect(caller.handle.send).toHaveBeenCalledOnce();
    expect(sibling.handle.send).toHaveBeenCalledOnce();
  });

  it('replaces local ordinary Pi runtimes only', async () => {
    const sessions = [
      session('local-pi', 'pi'),
      session('remote-pi', 'pi'),
      session('review-pi', 'pi'),
      session('codex', 'codex'),
    ];
    const getSessionMeta = vi.fn(async (id: string) => ({
      id,
      agentKind: 'pi' as const,
      workDir: '/tmp',
      title: id,
      model: 'test',
      createdAt: 1,
      updatedAt: 1,
      ...(id === 'remote-pi' ? { remoteHostId: 'ssh-host' } : {}),
      ...(id === 'review-pi' ? { reviewMode: true as const } : {}),
    }));
    const closeSessionIfCurrent = vi.fn(async () => undefined);
    const advanceGeneration = vi.fn();
    const listActiveSessions = vi.fn(() => sessions);
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: advanceGeneration,
      listActiveSessions,
      getSessionMeta,
      closeSessionIfCurrent,
    };

    await expect(
      invalidateLocalPiPackageRuntimesForObservedChange(maker, 'external-runtime'),
    ).resolves.toEqual({
      requestedSessionIds: ['local-pi'],
      failedSessionIds: [],
    });
    expect(getSessionMeta).toHaveBeenCalledTimes(3);
    expect(advanceGeneration.mock.invocationCallOrder[0]).toBeLessThan(
      listActiveSessions.mock.invocationCallOrder[0]!,
    );
    expect(closeSessionIfCurrent).toHaveBeenCalledWith(sessions[0], 'requested');
  });

  it('does not close a replacement runtime published during metadata lookup', async () => {
    const original = session('local-pi', 'pi');
    const replacement = session('local-pi', 'pi');
    let current = original;
    const metadata = deferred<Awaited<ReturnType<Maker['getSessionMeta']>>>();
    const closed = vi.fn();
    const closeSessionIfCurrent = vi.fn(async (candidate: Session) => {
      if (current === candidate) closed(candidate);
    });
    const getSessionMeta = vi.fn(() => metadata.promise);
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: () => [original],
      getSessionMeta,
      closeSessionIfCurrent,
    };

    const invalidation = invalidateLocalPiPackageRuntimes(maker);
    await vi.waitFor(() => expect(getSessionMeta).toHaveBeenCalledWith('local-pi'));
    current = replacement;
    metadata.resolve({
      id: 'local-pi',
      agentKind: 'pi',
      workDir: '/tmp',
      title: 'Pi',
      model: 'test',
      createdAt: 1,
      updatedAt: 1,
    });

    await expect(invalidation).resolves.toEqual({
      requestedSessionIds: ['local-pi'],
      failedSessionIds: [],
    });
    expect(closeSessionIfCurrent).toHaveBeenCalledWith(original, 'requested');
    expect(closed).not.toHaveBeenCalled();
  });

  it('does not retire a new-generation runtime started between commit and settled receipt', async () => {
    const beforeCommit = session('before-commit', 'pi');
    const afterCommit = session('after-commit', 'pi');
    const active = [beforeCommit];
    const closeSessionIfCurrent = vi.fn(async () => undefined);
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: vi.fn(() => [...active]),
      getSessionMeta: vi.fn(async (id: string) => ({
        id,
        agentKind: 'pi' as const,
        workDir: '/tmp',
        title: id,
        model: 'test',
        createdAt: 1,
        updatedAt: 1,
      })),
      closeSessionIfCurrent,
    };

    const commitSnapshot = await captureLocalPiPackageRuntimeInvalidationSnapshot(maker);
    active.push(afterCommit);
    await expect(
      invalidateLocalPiPackageRuntimeSnapshot(maker, commitSnapshot),
    ).resolves.toEqual({
      requestedSessionIds: ['before-commit'],
      failedSessionIds: [],
    });

    expect(maker.advanceLocalPiPackageRuntimeGeneration).toHaveBeenCalledOnce();
    expect(closeSessionIfCurrent).toHaveBeenCalledWith(beforeCommit, 'requested');
    expect(closeSessionIfCurrent).not.toHaveBeenCalledWith(afterCommit, 'requested');
  });

  it('does not duplicate convergence for the same-process token publication', async () => {
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: vi.fn(() => []),
      getSessionMeta: vi.fn(),
      closeSessionIfCurrent: vi.fn(),
    };

    await expect(
      invalidateLocalPiPackageRuntimesForObservedChange(maker, 'local'),
    ).resolves.toBeNull();
    expect(maker.advanceLocalPiPackageRuntimeGeneration).not.toHaveBeenCalled();
    expect(maker.listActiveSessions).not.toHaveBeenCalled();
  });

  it('still closes known-local siblings when one metadata lookup fails', async () => {
    const closeSessionIfCurrent = vi.fn(async () => undefined);
    const sessions = [session('unknown-pi', 'pi'), session('local-pi', 'pi')];
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: () => sessions,
      getSessionMeta: vi.fn(async (id: string) => {
        if (id === 'unknown-pi') throw new Error('metadata unavailable');
        return {
          id,
          agentKind: 'pi' as const,
          workDir: '/tmp',
          title: 'Pi',
          model: 'test',
          createdAt: 1,
          updatedAt: 1,
        };
      }),
      closeSessionIfCurrent,
    };

    await expect(invalidateLocalPiPackageRuntimes(maker)).resolves.toEqual({
      requestedSessionIds: ['local-pi'],
      failedSessionIds: ['unknown-pi'],
    });
    expect(closeSessionIfCurrent).toHaveBeenCalledWith(sessions[1], 'requested');
  });

  it('reports null metadata without preventing known-local siblings from closing', async () => {
    const closeSessionIfCurrent = vi.fn(async () => undefined);
    const sessions = [session('missing-pi', 'pi'), session('local-pi', 'pi')];
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: () => sessions,
      getSessionMeta: vi.fn(async (id: string) => (
        id === 'missing-pi'
          ? null
          : {
              id,
              agentKind: 'pi' as const,
              workDir: '/tmp',
              title: 'Pi',
              model: 'test',
              createdAt: 1,
              updatedAt: 1,
            }
      )),
      closeSessionIfCurrent,
    };

    await expect(invalidateLocalPiPackageRuntimes(maker)).resolves.toEqual({
      requestedSessionIds: ['local-pi'],
      failedSessionIds: ['missing-pi'],
    });
    expect(closeSessionIfCurrent).toHaveBeenCalledTimes(1);
    expect(closeSessionIfCurrent).toHaveBeenCalledWith(sessions[1], 'requested');
  });

  it('reports close failures without rewriting an already committed package mutation', async () => {
    const maker: InvalidationMaker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: () => [session('local-pi', 'pi')],
      getSessionMeta: vi.fn(async () => ({
        id: 'local-pi',
        agentKind: 'pi' as const,
        workDir: '/tmp',
        title: 'Pi',
        model: 'test',
        createdAt: 1,
        updatedAt: 1,
      })),
      closeSessionIfCurrent: vi.fn(async () => {
        throw new Error('close failed');
      }),
    };

    await expect(invalidateLocalPiPackageRuntimes(maker)).resolves.toEqual({
      requestedSessionIds: ['local-pi'],
      failedSessionIds: ['local-pi'],
    });
  });
});
