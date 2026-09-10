// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

const mocks = vi.hoisted(() => ({
  BotModelSelectionRequiredError: class extends Error {},
  addBotProfileAndWait: vi.fn(),
  generateDraft: vi.fn(),
  defaultModel: 'cindy-selected-model',
  navigate: vi.fn(),
  onboarding: false,
  availableVendors: new Set(['cc', 'codex', 'pi']),
  profiles: [] as Array<{ id: string; name: string; invitation: { stage: string } }>,
}));
vi.mock('@/state/newMakerDraft', () => ({
  getDraftForPreferenceSync: () => ({
    vendor: 'codex',
    lastByVendor: { codex: { providerId: 'openai', model: mocks.defaultModel } },
  }),
}));
vi.mock('@/hooks/useProviderOnboarding', () => ({
  useProviderOnboarding: () => ({ visible: mocks.onboarding }),
}));
vi.mock('@/hooks/useAvailableAgents', () => ({
  useAvailableAgents: () => ({ availableVendors: mocks.availableVendors, loaded: true }),
}));
vi.mock('@/components/onboarding/ConnectProviderCard', () => ({
  ConnectProviderCard: () => <div>Shared provider setup</div>,
}));
vi.mock('../botStore', () => ({
  BotModelSelectionRequiredError: mocks.BotModelSelectionRequiredError,
  addBotProfileAndWait: mocks.addBotProfileAndWait,
  useBotProfiles: () => mocks.profiles,
  refreshBotProfiles: vi.fn(),
  retryBotInvitation: vi.fn(),
  getEffectiveBotModelSettings: () => ({
    model: 'custom-model',
    providerId: 'custom',
    effort: 'high',
    fastMode: false,
  }),
}));
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: ({
    unifiedAgents,
    onUnifiedSelect,
    disabled,
    vendorKey,
    onNavigateToProviders,
  }: {
    onNavigateToProviders?: () => void;
    disabled: boolean;
    vendorKey: string;
    unifiedAgents: string[];
    onUnifiedSelect: (selection: unknown) => void;
  }) => (
    <>
      {onNavigateToProviders && (
        <button type="button" onClick={onNavigateToProviders}>
          connect-source
        </button>
      )}
      <span data-testid="selected-engine">{vendorKey}</span>
      {(['pi', 'codex'] as const)
        .filter((engine) => unifiedAgents.includes(engine))
        .map((engine) => (
          <button
            key={engine}
            disabled={disabled}
            type="button"
            onClick={() =>
              onUnifiedSelect({
                engine,
                providerId: 'custom',
                modelId: 'custom-model',
                effort: 'high',
                fast: false,
              })
            }
          >
            {engine === 'pi' ? 'choose-custom-model' : 'choose-custom-codex-model'}
          </button>
        ))}
    </>
  ),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));

vi.mock('../BotPortraitPicker', () => ({
  BotPortraitPicker: () => <div>Portrait picker</div>,
  galleryPortrait: async () => 'data:image/png;base64,cG9ydHJhaXQ=',
}));

import { BotRosterView } from '../BotRosterView';

beforeEach(() => {
  mocks.defaultModel = 'cindy-selected-model';
  mocks.generateDraft.mockReset();
  mocks.generateDraft.mockResolvedValue({
    token: 'draft-1',
    name: 'Mika',
    description: 'Practice English together.',
    skills: [],
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { localDb: { bots: { generateDraft: mocks.generateDraft } } },
  });
  mocks.addBotProfileAndWait.mockReset();
  mocks.addBotProfileAndWait.mockResolvedValue({ id: 'bot-new', name: 'Ops buddy' });
  mocks.navigate.mockReset();
  mocks.profiles = [];
  mocks.onboarding = false;
  mocks.availableVendors = new Set(['cc', 'codex', 'pi']);
});

afterEach(() => cleanup());

describe('BotRosterView — 唯一的伙伴创建界面', () => {
  it('recovers an empty default chain through model selection before creating', async () => {
    mocks.addBotProfileAndWait.mockRejectedValueOnce(new mocks.BotModelSelectionRequiredError());
    render(<BotRosterView />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.addCindy' }));
    await screen.findByText('choose-custom-model');
    expect(
      (screen.getByRole('button', { name: 'bots.guided.addCindy' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(mocks.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('choose-custom-model'));
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.addCindy' }));
    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(2));
    expect(
      mocks.addBotProfileAndWait.mock.calls[1][0].capabilities.modelChainOverride[0],
    ).toMatchObject({ model: 'custom-model', providerId: 'custom' });
  });

  it('can connect a source from creation recovery when normal onboarding is hidden', async () => {
    mocks.addBotProfileAndWait.mockRejectedValueOnce(new mocks.BotModelSelectionRequiredError());
    render(<BotRosterView />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.addCindy' }));
    fireEvent.click(await screen.findByText('connect-source'));
    expect(mocks.navigate).toHaveBeenCalledWith('/settings?tab=providers');
    expect(mocks.addBotProfileAndWait).toHaveBeenCalledOnce();
  });

  it('locks the recovery picker while creation is pending and unlocks after failure', async () => {
    mocks.addBotProfileAndWait.mockRejectedValueOnce(new mocks.BotModelSelectionRequiredError());
    render(<BotRosterView />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.addCindy' }));
    fireEvent.click(await screen.findByText('choose-custom-model'));
    let reject!: (reason: Error) => void;
    mocks.addBotProfileAndWait.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.addCindy' }));
    const picker = screen.getByText('choose-custom-codex-model') as HTMLButtonElement;
    expect(picker.disabled).toBe(true);
    fireEvent.click(picker);
    expect(screen.getByTestId('selected-engine').textContent).toBe('pi');
    expect(
      mocks.addBotProfileAndWait.mock.lastCall?.[0].capabilities.modelChainOverride[0].harness,
    ).toBe('pi');
    await act(async () => {
      reject(new Error('offline'));
    });
    expect(picker.disabled).toBe(false);
    fireEvent.click(picker);
    expect(screen.getByTestId('selected-engine').textContent).toBe('codex');
  });

  it('offers only installed runtimes when recovering creation with an empty chain', async () => {
    mocks.availableVendors = new Set(['codex']);
    mocks.addBotProfileAndWait.mockRejectedValueOnce(new mocks.BotModelSelectionRequiredError());
    render(<BotRosterView />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.addCindy' }));
    await screen.findByText('choose-custom-codex-model');
    expect(screen.queryByText('choose-custom-model')).toBeNull();
    fireEvent.click(screen.getByText('choose-custom-codex-model'));
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.addCindy' }));
    await waitFor(() => expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(2));
    expect(
      mocks.addBotProfileAndWait.mock.calls[1][0].capabilities.modelChainOverride[0],
    ).toMatchObject({ harness: 'codex', model: 'custom-model', providerId: 'custom' });
  });

  it('uses the shared connection guide before creating an unconfigured teammate', () => {
    mocks.onboarding = true;
    const view = render(<BotRosterView />);
    expect(screen.getByText('Shared provider setup')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'bots.guided.addCindy' })).toBeNull();
    expect(mocks.addBotProfileAndWait).not.toHaveBeenCalled();
    mocks.onboarding = false;
    view.rerender(<BotRosterView />);
    expect(screen.getByRole('button', { name: 'bots.guided.addCindy' })).toBeTruthy();
  });

  it('waits in the invitation dialog and meets only after preparation completes', async () => {
    const preparing = { id: 'new', name: '阿橙', invitation: { stage: 'skills' } };
    mocks.addBotProfileAndWait.mockResolvedValue(preparing);
    const view = render(<BotRosterView />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.addCindy' }));
    await waitFor(() =>
      expect(screen.getByText('bots.invitation.skills:{"name":"阿橙"}')).toBeTruthy(),
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
    mocks.profiles = [{ ...preparing, invitation: { stage: 'ready' } }];
    view.rerender(<BotRosterView />);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/bots/new'));
  });

  it('allows leaving the welcome while main continues preparing', async () => {
    mocks.addBotProfileAndWait.mockResolvedValue({
      id: 'new',
      name: '阿橙',
      invitation: { stage: 'profile' },
    });
    const onClose = vi.fn();
    render(<BotRosterView onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.addCindy' }));
    fireEvent.click(await screen.findByRole('button', { name: 'bots.invitation.leave' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.addBotProfileAndWait).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('leads with a description and exposes only Cindy as a preset', () => {
    render(<BotRosterView />);
    expect(screen.getByLabelText('bots.guided.question')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByLabelText('bots.nameLabel')).toBeNull();
    expect(screen.getByRole('button', { name: 'bots.guided.addCindy' })).toBeTruthy();
  });

  it('opens the original Cindy by stable template identity even after a rename', () => {
    mocks.profiles = [
      { id: 'old-cindy', name: 'Renamed', templateId: 'cindy', createdAt: 1, status: 'active' },
    ] as never;
    render(<BotRosterView />);
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.openCindy' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/old-cindy');
    expect(mocks.addBotProfileAndWait).not.toHaveBeenCalled();
  });

  it('generates once, edits the displayed fields in place and submits the same draft', async () => {
    render(<BotRosterView />);
    fireEvent.change(screen.getByLabelText('bots.guided.question'), {
      target: { value: 'An English partner' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.generate' }));
    await screen.findByText('Mika');
    expect(mocks.addBotProfileAndWait).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.editName' }));
    expect(screen.queryByText('Mika')).toBeNull();
    fireEvent.change(screen.getByLabelText('bots.nameLabel'), { target: { value: 'June' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.done' }));
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.editIntroduction' }));
    fireEvent.change(screen.getByLabelText('bots.guided.introduction'), {
      target: { value: 'A patient partner' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.invite' }));
    await waitFor(() =>
      expect(mocks.addBotProfileAndWait).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'June',
          description: 'A patient partner',
          creationDraftToken: 'draft-1',
          avatarImageBase64: 'cG9ydHJhaXQ=',
        }),
      ),
    );
    expect(mocks.addBotProfileAndWait.mock.lastCall?.[0]).not.toHaveProperty('welcomeMessage');
  });

  it('retains the profile and edited fields when a refinement fails', async () => {
    render(<BotRosterView />);
    fireEvent.change(screen.getByLabelText('bots.guided.question'), {
      target: { value: 'An English partner' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.generate' }));
    await screen.findByText('Mika');
    expect(mocks.generateDraft.mock.lastCall?.[0].modelRoute.model).toBe('cindy-selected-model');
    mocks.defaultModel = 'updated-cindy-model';
    mocks.generateDraft.mockRejectedValueOnce(new Error('offline'));
    fireEvent.change(screen.getByLabelText('bots.guided.refine'), {
      target: { value: 'More playful' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.refine' }));
    await screen.findByRole('alert');
    expect(screen.getByText('Mika')).toBeTruthy();
    expect(mocks.generateDraft.mock.lastCall?.[0]).toMatchObject({
      token: 'draft-1',
      name: 'Mika',
      prompt: 'More playful',
      modelRoute: { agentKind: 'codex', providerId: 'openai', model: 'updated-cindy-model' },
    });
  });

  it('asks for a Cindy default without generating when the selection is empty', async () => {
    mocks.defaultModel = '';
    render(<BotRosterView />);
    fireEvent.change(screen.getByLabelText('bots.guided.question'), { target: { value: 'A partner' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.generate' }));
    await screen.findByText('bots.guided.modelRequired');
    expect(mocks.generateDraft).not.toHaveBeenCalled();
  });

  it('shows the default model recovery message when the host cannot use the selected route', async () => {
    mocks.generateDraft.mockRejectedValueOnce(new Error('[BOT_CREATION_MODEL_UNAVAILABLE] unavailable'));
    render(<BotRosterView />);
    fireEvent.change(screen.getByLabelText('bots.guided.question'), { target: { value: 'A partner' } });
    fireEvent.click(screen.getByRole('button', { name: 'bots.guided.generate' }));
    await screen.findByText('bots.guided.modelRequired');
    expect(mocks.generateDraft).toHaveBeenCalledTimes(1);
  });

  it('closes the creation dialog without creating a teammate', () => {
    const onClose = vi.fn();
    render(<BotRosterView onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'commonUi.confirmDialog.cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.addBotProfileAndWait).not.toHaveBeenCalled();
  });
});
