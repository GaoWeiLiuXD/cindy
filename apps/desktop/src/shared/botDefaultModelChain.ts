import { isModelSelectableForNewRoute } from '@cindy/model-providers';
import type { resolveNewMakerDefaultTuples } from './newMakerDefaultTuple.js';
import type { BotModelRoute } from './botModelChain.js';

/** Adapt the client's ordered defaults to Bot routes without another selection policy. */
export function defaultBotModelChain(
  args: Parameters<typeof resolveNewMakerDefaultTuples>[0] & { preferredRoute?: BotModelRoute | null },
): BotModelRoute[] {
  const preferred = args.preferredRoute;
  if (preferred && !args.providersLoading && args.availableAgentsLoaded) {
    const agent = preferred.harness === 'claude' ? 'claude-code' : preferred.harness;
    const vendor = agent === 'claude-code' ? 'cc' : agent;
    const provider = args.providers.find(p => p.id === preferred.providerId && p.connected
      && !p.suspended && !p.modelDiscoveryFailure);
    const model = provider?.models[agent]?.find(m => m.id === preferred.model);
    if (provider && model && args.availableAgents.has(vendor)
      && (args.isModelEnabled?.(agent, provider.id, model) ?? model.defaultEnabled !== false)
      && isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' })) {
      // A selected Cindy default is not consent to add factory fallback models.
      // Additional routes belong to the explicitly configured Bot model chain.
      return [preferred];
    }
  }
  // Missing, stale or unavailable Cindy defaults are not permission to choose a replacement.
  return [];
}
