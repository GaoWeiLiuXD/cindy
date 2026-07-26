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

  // 徽章溯源 = flat 流实际会路由的来源(effectiveSourceIdForModel(null):已连接收窄 +
  // native 优先),不是目录首见者 —— anthropic 目录序在前,但 claude-code 的 native 默认
  // 源是 xd,选中该行后实际经 xd 调用,徽章必须跟路由一致(Greptile+codex P1)。
  it('徽章溯源跟实际路由:native 优先的 xd 而非目录首见的 anthropic', () => {
    const providers = [
      provider('anthropic', 'claude-code', [catalogModel('claude-opus-5')], {
        access: { kind: 'subscription', product: 'Claude.ai' },
      }),
      provider('xd', 'claude-code', [catalogModel('claude-opus-5')], {
        access: { kind: 'managed' },
      }),
    ];
    const [m] = deriveModelsFromProviders(providers, 'claude-code');
    expect(m.sourceAccess).toEqual({ kind: 'managed' });
  });

  it('徽章溯源:首见订阅源断开、连接的 managed 源实际路由 → 不再显示订阅', () => {
    const providers = [
      provider('anthropic', 'claude-code', [catalogModel('claude-opus-5')], {
        access: { kind: 'subscription', product: 'Claude.ai' },
        connected: false,
      }),
      provider('custom-m', 'claude-code', [catalogModel('claude-opus-5')], {
        access: { kind: 'managed' },
      }),
    ];
    const [m] = deriveModelsFromProviders(providers, 'claude-code');
    expect(m.sourceAccess).toEqual({ kind: 'managed' });
  });

  // flat 行的对话性与徽章共用「实际路由源」真相:user 源提供 'gpt-image-2'(自定义对话)
  // 而 XD 同 id 是媒体模型时,flat 选中只存 model id、会路由到 native 的 XD —— 逐 provider
  // 豁免会留下「显示可用、实际跑 XD 媒体路由」的行(codex review;自定义源同名模型走分段)。
  it('对话性按路由源判:user 源同名豁免不敌 native 路由的媒体判定', () => {
    const providers = [
      provider('xd', 'claude-code', [catalogModel('gpt-image-2')], {
        access: { kind: 'managed' },
        source: 'builtin',
      }),
      provider('my-prov', 'claude-code', [catalogModel('gpt-image-2', { group: 'custom:my-prov' })], {
        source: 'user',
      }),
    ];
    // native(xd)是实际路由源,其条目判媒体 → 该 flat 行剔除
    expect(deriveModelsFromProviders(providers, 'claude-code')).toEqual([]);
  });

  it('user 源独占的自定义对话模型:路由源即 user 源,豁免生效保留', () => {
    const providers = [
      provider('my-prov', 'claude-code', [catalogModel('my-image-analysis-chat', { group: 'custom:my-prov' })], {
        source: 'user',
      }),
    ];
    const ids = deriveModelsFromProviders(providers, 'claude-code').map((m) => m.id);
    expect(ids).toEqual(['my-image-analysis-chat']);
  });

  it('徽章溯源:全部来源断开 → 不带 access,徽章诚实不显示', () => {
    const providers = [
      provider('anthropic', 'claude-code', [catalogModel('claude-opus-5')], {
        access: { kind: 'subscription', product: 'Claude.ai' },
        connected: false,
      }),
    ];
    const [m] = deriveModelsFromProviders(providers, 'claude-code');
    expect(m.sourceAccess).toBeUndefined();
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
