export type CustomAsrSecretUpdate =
  | { action: 'none' }
  | { action: 'set'; value: string }
  | { action: 'clear' };

export type CustomAsrSecretStore = {
  get(id: 'voice-asr'): string | null;
  set(id: 'voice-asr', value: string): boolean;
  remove(id: 'voice-asr'): { success: boolean; error?: string };
};

/**
 * Persist a custom ASR secret and model-selection patch as one best-effort
 * transaction. The secret is applied first so config is never committed after
 * a rejected safeStorage write; a config failure restores the previous secret.
 */
export function persistVoiceInputSelectionWithCustomAsrSecret<T>(
  persistSelection: () => T,
  secretStore: CustomAsrSecretStore,
  secretUpdate: CustomAsrSecretUpdate,
): T {
  if (secretUpdate.action === 'none') return persistSelection();

  const previousSecret = secretStore.get('voice-asr');
  applySecretUpdate(secretStore, secretUpdate);
  try {
    return persistSelection();
  } catch (error) {
    if (!restoreSecret(secretStore, previousSecret)) {
      throw new Error('Failed to save voice input model selection and restore the previous ASR key.');
    }
    throw error;
  }
}

function applySecretUpdate(
  secretStore: CustomAsrSecretStore,
  secretUpdate: Exclude<CustomAsrSecretUpdate, { action: 'none' }>,
): void {
  if (secretUpdate.action === 'set') {
    if (!secretStore.set('voice-asr', secretUpdate.value)) {
      throw new Error('Failed to store the custom ASR API key.');
    }
    return;
  }
  if (!secretStore.remove('voice-asr').success) {
    throw new Error('Failed to remove the custom ASR API key.');
  }
}

function restoreSecret(
  secretStore: CustomAsrSecretStore,
  previousSecret: string | null,
): boolean {
  return previousSecret === null
    ? secretStore.remove('voice-asr').success
    : secretStore.set('voice-asr', previousSecret);
}
