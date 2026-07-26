/**
 * P2 行为锁:providerModels 切标准派生(deriveModelList)后的三个新行为。
 * 既有口径(first-wins / excludeProvider 不占 seen / 无可见性过滤)由标准层
 * 包测试与本仓 13k 既有测试共同锁定,此处只锁 P2 的**有意变化**:
 *   1. 对话模型统一过滤 —— 服务端目录缺 defaultEnabled 时 ASR/生图/向量混入清单
 *      (IM bot 线上实撞),对话选择面客户端自保剔除;
 *   2. group / sortOrder / sourceAccess 透传 —— flat 清单订阅徽章的真实溯源
 *      (此前 flat 模式订阅标签消失,用户误以为订阅绑定坏了)。
 */
import type { AgentKind, ProviderView } from '@cindy/model-providers';
import { describe, expect, it } from 'vitest';

import { deriveModelsFromProviders, selectVisibleModels } from '../providerModels';
import type { ModelDescriptor } from '@/hooks/useAgentCapabilities';

const catalogModel = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  contextWindow: 200_000,
  efforts: ['high'],
  defaultEffort: 'high',
  ...extra,
});

const provider = (
  id: string,
  agent: AgentKind,
  models: ReturnType<typeof catalogModel>[],
  extra: Record<string, unknown> = {},
): ProviderView =>
  ({
    id,
    name: id,
    connected: true,
    agents: [agent],
    models: { [agent]: models },
    ...extra,
  }) as unknown as ProviderView;

describe('deriveModelsFromProviders — P2 标准派生切换', () => {
  it('统一剔除非对话模型(前缀识别 + 目录 group 数据优先)', () => {
    const providers = [
      provider('gw', 'claude-code', [
        catalogModel('claude-opus-5'),
        catalogModel('gpt-4o-transcribe'),
        catalogModel('gpt-image-2'),
        catalogModel('voyage/voyage-3'),
        catalogModel('normal-id-but-audio', { group: 'audio' }),
      ]),
    ];
    const ids = deriveModelsFromProviders(providers, 'claude-code').map((m) => m.id);
    expect(ids).toEqual(['claude-opus-5']);
  });

  it('透传 group / sortOrder / sourceAccess(flat 订阅徽章与折扣分组的数据通路)', () => {
    const providers = [
      provider(
        'anthropic',
        'claude-code',
        [catalogModel('claude-opus-5', { group: 'anthropic', sortOrder: 3 })],
        { access: { kind: 'subscription', product: 'Claude.ai' } },
      ),
    ];
    const [m] = deriveModelsFromProviders(providers, 'claude-code');
    expect(m.group).toBe('anthropic');
    expect(m.sortOrder).toBe(3);
    expect(m.sourceAccess).toEqual({ kind: 'subscription', product: 'Claude.ai' });
  });

  it('first-wins 溯源:同 id 取首见供应商的 sourceAccess', () => {
    const providers = [
      provider('anthropic', 'claude-code', [catalogModel('claude-opus-5')], {
        access: { kind: 'subscription', product: 'Claude.ai' },
      }),
      provider('xd', 'claude-code', [catalogModel('claude-opus-5')], {
        access: { kind: 'managed' },
      }),
    ];
    const [m] = deriveModelsFromProviders(providers, 'claude-code');
    expect(m.sourceAccess).toEqual({ kind: 'subscription', product: 'Claude.ai' });
  });
});

describe('selectVisibleModels — device-link 路径同样过滤非对话模型', () => {
  it('被控端拍平清单里的非对话模型不进 picker', () => {
    const deviceModels: ModelDescriptor[] = [
      { id: 'claude-opus-5', displayName: 'Opus 5', contextWindow: 200_000, efforts: ['high'], defaultEffort: 'high' },
      { id: 'gpt-4o-transcribe', displayName: 'Transcribe', contextWindow: 16_000, efforts: [], defaultEffort: null },
    ];
    const ids = selectVisibleModels({
      agentKind: 'claude-code',
      deviceId: 'device-1',
      providers: [],
      deviceCcModels: deviceModels,
      deviceCodexModels: [],
    }).map((m) => m.id);
    expect(ids).toEqual(['claude-opus-5']);
  });
});
