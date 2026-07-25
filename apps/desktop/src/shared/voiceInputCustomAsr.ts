export type VoiceInputCustomAsrProtocol = 'openai-realtime' | 'qwen-realtime';

export type VoiceInputCustomAsrConfig = {
  protocol: VoiceInputCustomAsrProtocol;
  websocketUrl: string;
  model: string;
};

export const MAX_CUSTOM_ASR_WEBSOCKET_URL_CHARS = 2_048;
export const MAX_CUSTOM_ASR_MODEL_CHARS = 200;
export const MAX_CUSTOM_ASR_API_KEY_CHARS = 8_192;

export function validateVoiceInputCustomAsrWebsocketUrl(value: string): string | null {
  const websocketUrl = value.trim();
  if (!websocketUrl || websocketUrl.length > MAX_CUSTOM_ASR_WEBSOCKET_URL_CHARS) {
    return 'customAsr.websocketUrl is required and must be at most 2048 characters';
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(websocketUrl);
  } catch {
    return 'customAsr.websocketUrl must be a valid URL';
  }
  const loopbackHost = parsedUrl.hostname === 'localhost'
    || parsedUrl.hostname === '::1'
    || parsedUrl.hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(parsedUrl.hostname);
  if (parsedUrl.protocol !== 'wss:' && !(parsedUrl.protocol === 'ws:' && loopbackHost)) {
    return 'customAsr.websocketUrl must use wss, or ws on a loopback host';
  }
  if (parsedUrl.username || parsedUrl.password) {
    return 'customAsr.websocketUrl must not contain credentials';
  }
  const containsCredentialQuery = [...parsedUrl.searchParams.keys()].some((key) => (
    /^(?:api[-_]?key|x[-_]?api[-_]?key|access[-_]?token|token|authorization|auth|bearer|credential|secret|key)$/i.test(key)
  ));
  if (containsCredentialQuery) {
    return 'customAsr.websocketUrl must not contain credentials in query parameters';
  }
  if (parsedUrl.hash) {
    return 'customAsr.websocketUrl must not contain a fragment';
  }
  return null;
}

export function validateVoiceInputCustomAsrConfig(
  value: unknown,
): { ok: true; value: VoiceInputCustomAsrConfig } | { ok: false; error: string } {
  if (!isPlainObject(value)) return { ok: false, error: 'customAsr must be an object' };

  const protocol = typeof value.protocol === 'string' ? value.protocol.trim().toLowerCase() : '';
  if (protocol !== 'openai-realtime' && protocol !== 'qwen-realtime') {
    return { ok: false, error: 'customAsr.protocol must be openai-realtime or qwen-realtime' };
  }

  const websocketUrl = typeof value.websocketUrl === 'string' ? value.websocketUrl.trim() : '';
  const websocketUrlError = validateVoiceInputCustomAsrWebsocketUrl(websocketUrl);
  if (websocketUrlError) return { ok: false, error: websocketUrlError };

  const model = typeof value.model === 'string' ? value.model.trim() : '';
  const hasControlCharacter = [...model].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!model || model.length > MAX_CUSTOM_ASR_MODEL_CHARS || hasControlCharacter) {
    return { ok: false, error: 'customAsr.model is required and must be at most 200 characters' };
  }

  return {
    ok: true,
    value: {
      protocol,
      websocketUrl,
      model,
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
