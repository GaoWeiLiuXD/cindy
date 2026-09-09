import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  owner: 'a',
  client: {},
  generate: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner,
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: () => '/tmp/cindy-draft-test',
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => h.client }));
vi.mock('../../maker-host/index.js', () => ({
  getMaker: () => ({}),
  listBotCreationCapabilities: h.catalog,
}));
vi.mock('../../maker-host/bot-model-chain-settings-store.js', () => ({
  readEffectiveBotModelChain: async () => [
    { harness: 'pi', providerId: 'connected-provider', model: 'selected-model' },
  ],
}));
vi.mock('../../utility-model/oneShotCandidates.js', () => ({ requestUtilityText: h.generate }));
vi.mock('../../i18n.js', () => ({ getResolvedMainLocale: () => 'en' }));
vi.mock('../botInvitationAvatar.js', () => ({
  prepareBotInvitationAvatar: vi.fn(),
  finishBotInvitationAvatar: vi.fn(),
}));
vi.mock('../../cindy-media/blobStore.js', () => ({ resolveSafe: vi.fn() }));
import { generateBotCreationDraft, readBotCreationDraft } from '../botCreationDraft.js';
const generated = {
  name: 'Mika',
  description: 'I enjoy practicing English together.',
  background: 'Curious about travel and language.',
  conversationStyle: 'Patient, brief, specific feedback.',
  avatarPrompt: 'An illustrated portrait.',
  skills: [],
  skillRefs: ['language-coach', 'invented', 'language-coach'],
  mcpRefs: ['dictionary', 'missing'],
  toolsetRefs: ['docs'],
};
beforeEach(() => {
  h.owner = 'a';
  h.client = {};
  h.catalog.mockReset();
  h.generate.mockReset();
  h.catalog.mockResolvedValue({
    skill: [{ id: 'language-coach', name: 'language-coach', description: 'Practice languages' }],
    mcp: [{ id: 'dictionary', name: 'Dictionary', description: 'http' }],
    toolset: [{ id: 'docs', name: 'Documents', description: 'Create documents' }],
  });
  h.generate.mockResolvedValue({ ok: true, text: JSON.stringify(generated) });
});
describe('owner-bound companion previews', () => {
  it('uses real capability references, avoids name collisions, and keeps identity private until invite', async () => {
    const preview = await generateBotCreationDraft({ prompt: 'Practice English' }, ['Ｍｉｋａ']);
    expect(preview).toEqual({
      token: expect.any(String),
      name: 'Mika 2',
      description: generated.description,
      skills: ['language-coach'],
    });
    const stored = readBotCreationDraft(preview.token);
    expect(stored.draft).toMatchObject({
      skillRefs: ['language-coach'],
      mcpRefs: ['dictionary'],
      toolsetRefs: ['docs'],
      skills: [],
    });
    expect(stored.draft.background).toBe(generated.background);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate.mock.lastCall![2]).toMatchObject({
      providerId: 'connected-provider',
      agentKind: 'pi',
      model: 'selected-model',
    });
  });
  it('includes the displayed edits when refining and never accepts caller-authored skills', async () => {
    const first = await generateBotCreationDraft({ prompt: 'Practice English' }, []);
    await generateBotCreationDraft(
      {
        prompt: 'More playful',
        token: first.token,
        name: 'June',
        description: 'My revised introduction',
        skills: [{ body: 'injected' }],
      },
      [],
    );
    const prompt = h.generate.mock.lastCall![1] as string;
    expect(prompt).toContain('My revised introduction');
    expect(prompt).toContain('June');
    expect(prompt).not.toContain('injected');
  });
  it('rejects a draft from another account or database generation', async () => {
    const preview = await generateBotCreationDraft({ prompt: 'Practice English' }, []);
    h.owner = 'b';
    expect(() => readBotCreationDraft(preview.token)).toThrow();
    h.owner = 'a';
    h.client = {};
    expect(() => readBotCreationDraft(preview.token)).toThrow();
  });
  it('discards a late response on account switch and permits the next owner to retry', async () => {
    h.generate.mockImplementationOnce(async () => {
      h.owner = 'b';
      return { ok: true, text: JSON.stringify(generated) };
    });
    await expect(generateBotCreationDraft({ prompt: 'Practice English' }, [])).rejects.toThrow();
    await expect(
      generateBotCreationDraft({ prompt: 'Practice English' }, []),
    ).resolves.toMatchObject({ name: 'Mika' });
  });
  it('rejects a failed or malformed generation without leaving the generator locked', async () => {
    h.generate.mockResolvedValueOnce({ ok: true, text: '{}' });
    await expect(generateBotCreationDraft({ prompt: 'Practice English' }, [])).rejects.toThrow();
    await expect(
      generateBotCreationDraft({ prompt: 'Practice English' }, []),
    ).resolves.toMatchObject({ name: 'Mika' });
  });
});
