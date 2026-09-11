import type { ProviderView } from '@cindy/model-providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeAppDefaultModel, configureAppDefaultModelSelection, inspectAppDefaultModel } from '../appDefaultModelControl';
import { setNewMakerDraftCache } from '../../maker-host/newMakerDefaultsCache';

const host = vi.hoisted(() => ({ owner: 'owner:1', enabled: true, connected: true, agents: ['codex'],
  providers: vi.fn() }));
vi.mock('../../maker-host/index.js', () => ({ getMakerIfReady: () => ({ listAvailableAgents: () => host.agents }) }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders: host.providers }),
}));
vi.mock('../../maker-host/model-visibility-mirror.js', () => ({
  waitForModelVisibilityMirror: async () => {}, getModelVisibilityOverride: (_a: string, _p: string, model: string) => model === 'luna' && host.enabled,
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => host.owner, isAppSessionBoundaryPending: () => false,
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }),
}));
const route = { harness: 'codex' as const, providerId: 'openai', model: 'luna', effort: 'medium', fastMode: false };
const mirror = (selectedRoute = route, requestId?: string) => setNewMakerDraftCache({ selectedRoute,
  lastByVendor: {}, fastModeByModel: {}, effortByModel: {} }, host.owner, requestId);
const id = JSON.stringify(['codex', 'openai', 'luna']);

beforeEach(() => {
  host.owner = 'owner:1'; host.enabled = true; host.connected = true; host.agents = ['codex'];
  host.providers.mockImplementation(async () => [{ id: 'openai', source: 'builtin', connected: host.connected,
    models: { codex: ['luna', 'sol'].map(model => ({ id: model, status: 'active', mode: 'chat', defaultEnabled: true,
      efforts: ['low', 'medium'], defaultEffort: 'medium' })) } }] as ProviderView[]);
  mirror();
});
afterEach(() => { configureAppDefaultModelSelection(null); vi.useRealTimers(); });

describe('Bot control of the real Cindy default', () => {
  it('only lists the enabled connected model, even if another model is in the catalog', async () => {
    expect(await inspectAppDefaultModel()).toMatchObject({ current: route, available: [{ id, route }] });
    expect((await inspectAppDefaultModel()).available).toHaveLength(1);
  });
  it.each(['disabled', 'disconnected', 'missing harness'] as const)('rejects a stale selection that is now %s', async failure => {
    await inspectAppDefaultModel();
    if (failure === 'disabled') host.enabled = false;
    if (failure === 'disconnected') host.connected = false;
    if (failure === 'missing harness') host.agents = [];
    const dispatch = vi.fn(); configureAppDefaultModelSelection(dispatch);
    await expect(changeAppDefaultModel(id)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('waits for the real owner-fenced mirror instead of mutating the cache itself', async () => {
    const dispatch = vi.fn(selection => mirror(selection.route, selection.requestId));
    configureAppDefaultModelSelection(dispatch);
    expect(await changeAppDefaultModel(id, 'low')).toEqual({ current: { ...route, effort: 'low' } });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ expectedRoute: route,
      ownerStamp: { dataOwnerId: 'owner', ownerGeneration: 1 } }));
  });
  it('does not claim success when an unrelated mirror matches but the renderer never confirms this write', async () => {
    vi.useFakeTimers(); configureAppDefaultModelSelection(() => mirror());
    const result = expect(changeAppDefaultModel(id)).rejects.toThrow('未确认');
    await vi.advanceTimersByTimeAsync(5001); await result;
  });
  it('rejects an owner switch during catalog reading before dispatch', async () => {
    const providers = await host.providers();
    host.providers.mockImplementation(async () => { host.owner = 'owner:2'; return providers; });
    const dispatch = vi.fn(); configureAppDefaultModelSelection(dispatch);
    await expect(changeAppDefaultModel(id)).rejects.toThrow('账号');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('rejects an unsupported effort without changing anything', async () => {
    const dispatch = vi.fn(); configureAppDefaultModelSelection(dispatch);
    await expect(changeAppDefaultModel(id, 'ultra')).rejects.toThrow('不可用');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
