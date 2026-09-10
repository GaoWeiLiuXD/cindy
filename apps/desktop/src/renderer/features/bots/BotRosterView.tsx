import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Pencil } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BotModelChainEditor } from './BotModelChainEditor';
import type { BotModelRoute } from '../../../shared/botModelChain';
import { normalizeBotName, type BotCreationDraft } from '../../../shared/botCreation';
import { BotInvitationWelcome } from './BotInvitationWelcome';
import { ConnectProviderCard } from '@/components/onboarding/ConnectProviderCard';
import { useProviderOnboarding } from '@/hooks/useProviderOnboarding';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { BotAvatar } from './BotAvatar';
import { BotPortraitPicker, galleryPortrait } from './BotPortraitPicker';
import {
  addBotProfileAndWait,
  BotModelSelectionRequiredError,
  refreshBotProfiles,
  useBotProfiles,
  type BotProfile,
} from './botStore';
import { extractIpcError } from '@/utils/ipcError';
import { getDraftForPreferenceSync } from '@/state/newMakerDraft';
import { getBotTemplate } from './botTemplates';

interface BotRosterViewProps {
  onCreated?: (bot: BotProfile) => void;
  onClose?: () => void;
  restoreFocus?: () => void;
}
const secondary =
  'inline-flex h-9 items-center justify-center gap-2 rounded-full px-4 text-13 text-[var(--text-secondary)] outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50';
const primary =
  'inline-flex h-10 items-center justify-center gap-2 rounded-full bg-[var(--accent-cta-bg)] px-6 text-13 font-medium text-[var(--accent-pure-cta-fg)] outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50';
const input =
  'w-full rounded-lg border border-[var(--border-default)] bg-[var(--confirm-bg)] p-3 text-14 leading-7 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

/** Describe → review and adjust in place → invite. The same profile fields stay visible throughout. */
export function BotRosterView({ onCreated, onClose, restoreFocus }: BotRosterViewProps = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const bots = useBotProfiles();
  const providerOnboarding = useProviderOnboarding({ dismissible: false });
  const [prompt, setPrompt] = useState('');
  const [refinement, setRefinement] = useState('');
  const [draft, setDraft] = useState<BotCreationDraft | null>(null);
  const [portrait, setPortrait] = useState<string>();
  const [editing, setEditing] = useState<'name' | 'description' | null>(null);
  const [modelChain, setModelChain] = useState<BotModelRoute[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invited, setInvited] = useState<BotProfile | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    refreshBotProfiles();
    return window.electronAPI?.maker?.onBotProfileChanged?.(() => refreshBotProfiles());
  }, []);
  const invitedBot = bots.find((bot) => bot.id === invited?.id) ?? invited;
  const existingCindy = bots
    .filter(
      (bot) => bot.templateId === 'cindy' && bot.status !== 'archived' && bot.status !== 'deleting',
    )
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  const duplicate =
    draft &&
    bots.some(
      (bot) =>
        bot.status !== 'archived' && normalizeBotName(bot.name) === normalizeBotName(draft.name),
    );
  const handleCreated = (bot: BotProfile) => {
    if (onCreated) onCreated(bot);
    else navigate(`/bots/${bot.id}`);
    onClose?.();
  };
  useEffect(() => {
    if (invitedBot?.invitation?.stage === 'ready') handleCreated(invitedBot);
  }, [invitedBot, navigate, onCreated, onClose]);

  const generate = async () => {
    const request = draft ? refinement : prompt;
    if (!request.trim() || generating) return;
    const current = ++generation.current;
    setGenerating(true);
    setError(null);
    setEditing(null);
    try {
      const defaults = getDraftForPreferenceSync();
      const prefs = defaults.lastByVendor[defaults.vendor];
      if (!prefs.model.trim()) {
        setError(t('bots.guided.modelRequired'));
        return;
      }
      const result = await window.electronAPI.localDb.bots.generateDraft({
        modelRoute: {
          agentKind: defaults.vendor === 'cc' || defaults.vendor === 'orca'
            ? 'claude-code' : defaults.vendor,
          providerId: prefs.providerId ?? null,
          model: prefs.model,
        },
        prompt: request,
        ...(draft ? { token: draft.token, name: draft.name, description: draft.description } : {}),
      });
      if (generation.current !== current) return;
      // Prepare real image bytes before exposing Invite. Never await a paid image model here.
      const avatar = portrait ?? (await galleryPortrait(bots.length % 16));
      if (generation.current !== current) return;
      setPortrait(avatar);
      setDraft(result);
      setRefinement('');
    } catch (error) {
      if (generation.current === current) {
        setError(t(extractIpcError(error)?.code === 'BOT_CREATION_MODEL_UNAVAILABLE'
          ? 'bots.guided.modelRequired' : 'bots.guided.generationFailed'));
      }
    } finally {
      if (generation.current === current) setGenerating(false);
    }
  };
  const invite = async (cindy = false) => {
    if (creating || generating) return;
    if (cindy && existingCindy) {
      handleCreated(existingCindy);
      return;
    }
    if (!cindy && (!draft?.name.trim() || !draft.description.trim() || duplicate || !portrait))
      return;
    setCreating(true);
    setError(null);
    try {
      const template = getBotTemplate('cindy');
      const bot = await addBotProfileAndWait({
        name: cindy ? 'Cindy' : draft!.name.trim(),
        description: cindy ? t('bots.guided.cindyDescription') : draft!.description.trim(),
        prepareInvitation: true,
        ...(cindy
          ? {
              templateId: 'cindy' as const,
              identitySource: template.identitySource,
              avatar: template.avatar,
            }
          : { creationDraftToken: draft!.token, avatarImageBase64: portrait!.split(',')[1] }),
        avatarColor: 'blue',
        capabilities: {
          ...(cindy ? { toolsetMode: 'allowlist' as const, toolsets: ['docs'] } : {}),
          ...(modelChain?.length ? { modelChainOverride: modelChain } : {}),
        },
      });
      if (bot.invitation && bot.invitation.stage !== 'ready') setInvited(bot);
      else handleCreated(bot);
    } catch (cause) {
      if (cause instanceof BotModelSelectionRequiredError) {
        setModelChain([]);
        return;
      }
      setError(t('bots.createWizard.createFailed'));
      refreshBotProfiles();
    } finally {
      setCreating(false);
    }
  };
  const close = () => {
    if (!creating) {
      if (onClose) onClose();
      else navigate('/bots');
    }
  };
  const busy = creating || generating;
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
        <Dialog.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            if (editing) {
              event.preventDefault();
              setEditing(null);
            }
          }}
          onCloseAutoFocus={(event) => {
            if (restoreFocus) {
              event.preventDefault();
              restoreFocus();
            }
          }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-32px)] max-w-[720px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface)] p-6 text-[var(--text-primary)] outline-none sm:p-10"
        >
          {providerOnboarding.visible ? (
            <>
              <Dialog.Title className="sr-only">
                {t('onboarding.connectProvider.title')}
              </Dialog.Title>
              <ConnectProviderCard dismissible={false} />
            </>
          ) : invitedBot ? (
            <>
              <Dialog.Title className="sr-only">{t('bots.invitation.title')}</Dialog.Title>
              <BotInvitationWelcome bot={invitedBot} />
              <div className="flex justify-end">
                <button type="button" onClick={close} className={secondary}>
                  {t('bots.invitation.leave')}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="mb-8 flex items-center justify-between gap-4">
                <Dialog.Title className="text-20 font-medium">
                  {t(draft ? 'bots.guided.reviewTitle' : 'bots.guided.title')}
                </Dialog.Title>
                <button type="button" onClick={close} disabled={creating} className={secondary}>
                  {t('commonUi.confirmDialog.cancel')}
                </button>
              </div>
              {!draft ? (
                <>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void generate();
                    }}
                  >
                    <label
                      htmlFor="companion-request"
                      className="mb-3 block text-14 leading-6 text-[var(--text-secondary)]"
                    >
                      {t('bots.guided.question')}
                    </label>
                    <textarea
                      id="companion-request"
                      autoFocus
                      value={prompt}
                      disabled={busy}
                      maxLength={4000}
                      rows={4}
                      onChange={(event) => setPrompt(event.target.value)}
                      placeholder={t('bots.guided.placeholder')}
                      className={`${input} resize-none`}
                    />
                    <div className="mt-4 flex flex-wrap gap-3">
                      {['english', 'ideas', 'life'].map((key) => (
                        <Button
                          key={key}
                          variant="secondary"
                          size="lg"
                          disabled={busy}
                          onClick={() => setPrompt(t(`bots.guided.examples.${key}.prompt`))}
                        >
                          {t(`bots.guided.examples.${key}.label`)}
                        </Button>
                      ))}
                    </div>
                    <div className="mt-5 flex justify-end">
                      <button type="submit" disabled={busy || !prompt.trim()} className={primary}>
                        {generating ? <Spinner size={14} /> : null}
                        {t(generating ? 'bots.guided.generating' : 'bots.guided.generate')}
                        <ArrowRight size={16} />
                      </button>
                    </div>
                  </form>
                  <div className="mt-10 flex items-center gap-4 border-t border-[var(--border-default)] pt-6">
                    <BotAvatar
                      bot={{ name: 'Cindy', avatar: getBotTemplate('cindy').avatar }}
                      size="lg"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-16 font-medium">Cindy</p>
                      <p className="mt-1 text-13 leading-6 text-[var(--text-secondary)]">
                        {t('bots.guided.cindySummary')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void invite(true)}
                      disabled={busy || (!existingCindy && modelChain?.length === 0)}
                      className={`${secondary} shrink-0 border border-[var(--border-default)]`}
                    >
                      {creating && <Spinner size={12} />}
                      {t(existingCindy ? 'bots.guided.openCindy' : 'bots.guided.addCindy')}
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <fieldset
                    disabled={busy}
                    className="min-w-0 rounded-xl border border-[var(--border-default)] bg-[var(--confirm-bg)] p-5 sm:p-7"
                  >
                    <div className="flex items-center gap-5">
                      <BotPortraitPicker
                        token={draft.token}
                        value={portrait}
                        disabled={busy}
                        onChange={setPortrait}
                      />
                      <div className="min-w-0 flex-1">
                        {editing === 'name' ? (
                          <div className="flex items-center gap-1">
                            <input
                              aria-label={t('bots.nameLabel')}
                              autoFocus
                              maxLength={100}
                              value={draft.name}
                              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' && !event.nativeEvent.isComposing)
                                  setEditing(null);
                              }}
                              className={`${input} rounded-full text-20`}
                            />
                            <button
                              type="button"
                              aria-label={t('bots.guided.done')}
                              disabled={!draft.name.trim() || Boolean(duplicate)}
                              onClick={() => setEditing(null)}
                              className={secondary}
                            >
                              <Check size={16} />
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setEditing('name')}
                            aria-label={t('bots.guided.editName')}
                            className="flex max-w-full items-center gap-3 rounded-full py-2 pr-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                          >
                            <span className="break-words text-28 font-medium">{draft.name}</span>
                            <Pencil size={15} className="shrink-0 text-[var(--text-secondary)]" />
                          </button>
                        )}
                        {duplicate && (
                          <p role="alert" className="mt-2 text-12 text-[var(--text-danger)]">
                            {t('bots.guided.duplicateName')}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="mt-6 border-t border-[var(--border-default)] pt-5">
                      <div className="mb-3 flex items-center justify-between">
                        <span className="text-13 text-[var(--text-secondary)]">
                          {t('bots.guided.introduction')}
                        </span>
                        <button
                          type="button"
                          aria-label={t(
                            editing === 'description'
                              ? 'bots.guided.done'
                              : 'bots.guided.editIntroduction',
                          )}
                          onClick={() =>
                            setEditing(editing === 'description' ? null : 'description')
                          }
                          className={secondary}
                        >
                          {editing === 'description' ? <Check size={15} /> : <Pencil size={15} />}
                        </button>
                      </div>
                      {editing === 'description' ? (
                        <textarea
                          aria-label={t('bots.guided.introduction')}
                          autoFocus
                          value={draft.description}
                          maxLength={2000}
                          rows={7}
                          onChange={(event) =>
                            setDraft({ ...draft, description: event.target.value })
                          }
                          className={input}
                        />
                      ) : (
                        <p className="whitespace-pre-wrap text-16 leading-8">{draft.description}</p>
                      )}
                    </div>
                  </fieldset>
                  <form
                    className="mt-5"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void generate();
                    }}
                  >
                    <label htmlFor="companion-refinement" className="sr-only">
                      {t('bots.guided.refine')}
                    </label>
                    <div className="flex items-end gap-2">
                      <textarea
                        id="companion-refinement"
                        value={refinement}
                        disabled={busy}
                        rows={2}
                        maxLength={4000}
                        onChange={(event) => setRefinement(event.target.value)}
                        placeholder={t('bots.guided.refinePlaceholder')}
                        className={`${input} resize-none`}
                      />
                      <button
                        type="submit"
                        disabled={busy || !refinement.trim()}
                        className={`${secondary} shrink-0 border border-[var(--border-default)]`}
                      >
                        {generating ? <Spinner size={14} /> : <ArrowRight size={16} />}
                        <span className="sr-only">{t('bots.guided.refine')}</span>
                      </button>
                    </div>
                  </form>
                  <div className="mt-7 flex items-center justify-between gap-3">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setDraft(null);
                        setError(null);
                      }}
                      className={secondary}
                    >
                      <ArrowLeft size={14} />
                      {t('bots.guided.back')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void invite()}
                      disabled={
                        busy ||
                        !draft.name.trim() ||
                        !draft.description.trim() ||
                        Boolean(duplicate) ||
                        !portrait ||
                        modelChain?.length === 0
                      }
                      className={primary}
                    >
                      {creating && <Spinner size={14} />}
                      {t('bots.guided.invite')}
                      <ArrowRight size={16} />
                    </button>
                  </div>
                </>
              )}
              {modelChain !== null && (
                <div className="mt-5">
                  <BotModelChainEditor
                    label={t('bots.settingsTabs.model')}
                    value={modelChain}
                    onChange={setModelChain}
                    onNavigateToProviders={() => navigate('/settings?tab=providers')}
                    disabled={busy}
                  />
                </div>
              )}
              {error && (
                <p role="alert" className="mt-4 text-13 text-[var(--text-danger)]">
                  {error}
                </p>
              )}
              {generating && draft && (
                <p role="status" className="mt-3 text-12 text-[var(--text-secondary)]">
                  {t('bots.guided.generating')}
                </p>
              )}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
