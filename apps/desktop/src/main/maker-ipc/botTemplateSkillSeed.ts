import type { BotTemplatePresetId } from '../../shared/botTemplatePreset.js';
import { listBotSkills, type BotSkillRecord } from './botSkillStore.js';

export interface BotTemplateSkillSeedResult {
  completedNow: boolean;
  skills: Array<{ record: BotSkillRecord; created: boolean }>;
}

/**
 * Compatibility entry for old creation/invitation callers. Every new Bot now
 * receives the shared managed baseline at runtime, never a role capability pack.
 * Preserve and normalize previously seeded/user-edited files without restoring
 * deleted Skills or rewriting old completion markers.
 */
export async function seedBotTemplateSkills(
  userDataDir: string,
  botId: string,
  _templateId: BotTemplatePresetId,
): Promise<BotTemplateSkillSeedResult> {
  await listBotSkills(userDataDir, botId);
  return { completedNow: false, skills: [] };
}
