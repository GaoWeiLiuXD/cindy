/**
 * providerModels —— 从 live `useProviders()` 派生某 agent 的模型清单（renderer 侧）。
 *
 * 这是 main 的 `maker-host/catalog-to-descriptors.ts:deriveAvailableModels` 的 **renderer live 版**：
 * 模型清单 SSoT 是 provider catalog；picker 改为直接从 `useProviders()`（实时读 active-catalog）
 * 派生，而非读 agent 构造时冻结的 `capabilities.availableModels`。这样：
 *   - 内置部分与冻结快照**逐字节相同**（同一 active-catalog 源、同 provider 序、同 first-wins 去重）→ no-break；
 *   - 自定义供应商的模型自动并入、增删改即时反映（PROVIDER_CHANGED 广播 → useProviders refetch），无需重启。
 *
 * 顺序契约：按 `providers` 数组序（= catalog 序：anthropic → openai → xd → 自定义…）flatMap
 * 各 provider 的 `models[agent]`，按 id 首见胜出去重。
 */

import {
  deriveModelList,
  effectiveSourceIdForModel,
  isConversationModel,
  providerOffersModel,
  sessionModelSupportsFastMode,
  type AgentKind,
  type ModelListEntry,
  type ProviderView,
} from '@cindy/model-providers';

// 用 renderer 自己的 ModelDescriptor（Effort=string，宽松）—— 与 capabilities.availableModels
// 同型，picker 现有代码（effortDisplayNames 按 string 索引等）零改动即可消费。
import type { AgentCapabilities, ModelDescriptor } from '@/hooks/useAgentCapabilities';
import { isSubscriptionDirectModel } from '../../shared/subscriptionModels';

/**
 * 标准派生条目 → renderer ModelDescriptor(name→displayName)。P2 起补透传
 * group / sortOrder(此前丢失,折扣版分组只能靠前缀兜底)与 sourceAccess
 * (flat 清单订阅徽章的真实溯源 —— 此前 flat 模式标签消失)。
 * **显式逐字段投影**:标准条目是带溯源字段的拷贝,禁止整对象 spread 过 wire
 * (见 visibleModelUnion 的物理差异警告)。
 */
function toDescriptor(m: ModelListEntry): ModelDescriptor {
  const d: ModelDescriptor = {
    id: m.id,
    displayName: m.name,
    contextWindow: m.contextWindow,
    efforts: m.efforts,
    defaultEffort: m.defaultEffort,
  };
  if (m.description !== undefined) d.description = m.description;
  if (m.effortDisplayNames !== undefined) d.effortDisplayNames = m.effortDisplayNames;
  if (m.supportsFastMode !== undefined) d.supportsFastMode = m.supportsFastMode;
  if (m.group !== undefined) d.group = m.group;
  if (m.sortOrder !== undefined) d.sortOrder = m.sortOrder;
  if (m.sourceAccess !== undefined) d.sourceAccess = m.sourceAccess;
  return d;
}

/**
 * Fast 可用判定的**唯一渲染层入口** —— 本地会话与 device-link 远程会话统一走同一套共享纯逻辑
 * （`sessionModelSupportsFastMode`，per-(provider, model) 唯一真相），**控制端不另写远程判断逻辑**。
 *
 * 数据源选择遵守 device-link「以被控端为准」契约:
 *   - device-link 远程会话（deviceId 非空）→ 用被控端经隧道(`maker:provider:list`)带来的 `deviceProviders`；
 *   - 本机会话 → 用本地 `localProviders`。
 *
 * **旧被控端回退（no-break 硬约束）**:旧版被控端不支持 `maker:provider:list` ⇒ `deviceProviders` 为空,
 * 此时回退到拍平的 `capabilities.availableModels[].supportsFastMode`（与本次改造前 device-link 行为逐字节一致）,
 * 否则 fast 开关会被误隐藏。注:device providers 加载首帧也可能为空 → 暂走拍平回退;现内置目录无 per-provider
 * 分叉，拍平==per-provider，无可见跳变。
 *
 * 本函数**已包含 agent 级 `hasFastMode` 粗粒度 gate**，调用点不要再叠一次。
 */
export function resolveFastSupported(params: {
  deviceId: string | undefined;
  deviceProviders: ProviderView[];
  localProviders: ProviderView[];
  capabilities: AgentCapabilities | null;
  providerId: string | null | undefined;
  modelId: string;
  agentKind: AgentKind | null;
}): boolean {
  const { deviceId, deviceProviders, localProviders, capabilities, providerId, modelId, agentKind } =
    params;
  if (!agentKind) return false;
  // agent 级粗粒度 gate（agent 运行时是否实现 fast 管道）。
  if (!capabilities?.hasFastMode) return false;

  const effectiveProviders = deviceId ? deviceProviders : localProviders;

  // 旧被控端（或 device providers 加载首帧）→ 无 per-provider 数据 → 回退拍平 caps。
  if (deviceId && effectiveProviders.length === 0) {
    return !!capabilities.availableModels.find((m) => m.id === modelId)?.supportsFastMode;
  }

  // 本地 + 现代被控端:统一走共享 per-provider 纯函数（含生效来源解析）。
  return sessionModelSupportsFastMode(effectiveProviders, providerId ?? null, modelId, agentKind);
}

/**
 * 自定义供应商头像首字母（显示名首个字符大写；Array.from 正确处理 emoji / 代理对，空名兜底 `?`）。
 * 设置→供应商列表与对话模型选择器 trigger 共用，保证两处自定义 logo 一致。
 */
export function providerMonogram(name: string): string {
  const ch = Array.from(name.trim())[0] ?? '?';
  return ch.toUpperCase();
}

/** Whether a provider relies on the local Responses-to-Chat handler for Codex. */
export function isChatBridgedCodexProvider(provider: ProviderView): boolean {
  return provider.routing?.codex?.wireProtocol === 'openai-chat';
}

export function filterChatBridgedCodexProviders(
  providers: ProviderView[],
  agent: AgentKind,
  exclude: boolean,
): ProviderView[] {
  return exclude && agent === 'codex'
    ? providers.filter((provider) => !isChatBridgedCodexProvider(provider))
    : providers;
}

/**
 * 派生某 agent 的可见模型清单：跨 provider union（数组序）+ 按 id 首见去重。
 *
 * `excludeProvider` 命中的供应商整条跳过（其模型不加入、也不占 seen），这样若同一
 * model id 另有可路由的供应商提供，仍能由后者补上——用于 SSH 远程排除仅本地可桥接的来源。
 */
export function deriveModelsFromProviders(
  providers: ProviderView[],
  agent: AgentKind,
  opts?: { excludeProvider?: (provider: ProviderView) => boolean },
): ModelDescriptor[] {
  // P2: 内部改标准派生(deriveModelList)。口径逐项对应原实现:providersForAgent =
  // providerScope 'all-for-agent',first-wins 去重,excludeProvider 不占 seen,无可见性过滤。
  // **统一对话模型过滤(P2 有意的可见变化)**:本函数是对话选择面(会话 picker / IM 默认 /
  // SSH 草稿)的本机派生唯一入口 —— 服务端目录缺 defaultEnabled 时 ASR/生图/向量模型
  // 会混进清单(IM bot 线上实撞),这里按 isConversationModel 统一剔除,不依赖服务端
  // 数据质量。设置 → 供应商模型管理列表不走本函数,仍列全部目录项。
  // 徽章路由解析池必须先应用 excludeProvider(SSH 排除 chat-bridged Codex 等):
  // 否则同模型多来源时,徽章可能反映被选择面排除的来源,与清单实际保留的来源不一致
  // (Greptile 复审)。
  const routingPool = opts?.excludeProvider
    ? providers.filter((p) => !opts.excludeProvider!(p))
    : providers;
  return deriveModelList({
    providers,
    agent,
    providerScope: 'all-for-agent',
    dedupe: 'first-wins',
    excludeModel: (m, p) => !isConversationModel(m, p),
    ...(opts?.excludeProvider ? { excludeProvider: opts.excludeProvider } : {}),
  }).map((entry) => {
    const d = toDescriptor(entry);
    // 徽章溯源 = flat 流**实际会路由**的来源(已连接收窄 + native 优先,与选中后
    // effectiveSourceIdForModel(null) 的解析一致),不是目录首见者:首见供应商可能已断开、
    // 或与 nativeDefaultSourceId 的路由选择不一致 —— 按首见取 access 会让徽章说谎
    // (显示订阅实际走 managed,或反之;Greptile + codex P1)。解析不到已连接来源(全部
    // 断开)→ 不带 access,徽章诚实不显示。
    const routedId = effectiveSourceIdForModel([...routingPool], null, entry.id, agent);
    const routed = routedId !== null ? routingPool.find((p) => p.id === routedId) : undefined;
    if (routed?.access !== undefined) d.sourceAccess = routed.access;
    else delete d.sourceAccess;
    return d;
  });
}

/**
 * picker 模型清单来源选择 —— device-link「以被控端为准」契约的 SSoT。
 *
 *  - **device-link 远程会话(deviceId 非空)**:列**被控端**模型 —— 用 deviceId 作用域的
 *    `capabilities.availableModels`(隧道 `maker:get-capabilities` 拉到的被控端目录),
 *    **绝不读控制端本地 provider catalog**。否则控制端的自定义供应商 / 版本差异会让 picker
 *    列出被控端跑不了的模型(或漏掉被控端独有模型),且选中后 create / effort / fast 解析
 *    (按被控端能力 `getModelById(id, deviceId)`)与列表对不上 —— 见 useAgentCapabilities
 *    的「以被控端为准」契约。model-providers 重构曾把列表来源改成本地派生,无意中破坏了它。
 *  - **本机会话(deviceId === undefined)**:从 live `providers` 派生(provider-first,
 *    含自定义供应商),与重构后的本地行为逐字节一致。
 *
 * `agentKind` 锁定时取单边;为 null 时 cc + codex 按 id 首见去重并集(与历史合并口径一致)。
 * device 侧两个数组由调用方传 `cc/codex.capabilities.availableModels ?? []`(可空 → 空数组)。
 */
export function selectVisibleModels(params: {
  agentKind: AgentKind | null;
  deviceId: string | undefined;
  providers: ProviderView[];
  deviceCcModels: ModelDescriptor[];
  deviceCodexModels: ModelDescriptor[];
  /**
   * 过滤订阅直连模型(chatgpt/ / xai/,经本地 compat-proxy 的 responses-bridge 翻译)。
   * SSH 远程会话(remoteHostId)必须传 true:远程模式走 remoteEndpoint、不经本地 loopback
   * proxy,bridge 前缀模型送出去不会被翻译,选了必失败。device-link 远程不受影响
   * (被控端跑完整 app,其本地 proxy 上 bridge 可用,模型清单本就来自被控端)。
   */
  excludeSubscriptionDirect?: boolean;
  /**
   * 过滤 `wireProtocol: 'openai-chat'` 的 Codex 供应商(DeepSeek / Kimi / GLM 等):它们的
   * Responses→Chat 翻译只挂在本地 codex-proxy 的 localHandler 上。SSH 远程会话(remoteHostId)
   * 必须传 true:远程走 daemon transport、不经本地 proxy,未经桥接的 Chat-only 模型送到远端必失败。
   * 与 excludeSubscriptionDirect 同由 `!!remoteHostId` 驱动;device-link 远程不受影响(被控端跑完整 app)。
   */
  excludeChatBridgedCodex?: boolean;
}): ModelDescriptor[] {
  const { agentKind, deviceId, providers, deviceCcModels, deviceCodexModels, excludeSubscriptionDirect, excludeChatBridgedCodex } = params;
  const drop = (
    list: ModelDescriptor[],
    agent: AgentKind,
    fromDevicePath: boolean,
  ): ModelDescriptor[] => {
    // 对话过滤只作用 device-link 拍平路径:本机路径在 deriveModelsFromProviders 内已带
    // provider 上下文过滤(user 源豁免),此处二次过滤会把豁免过的自定义对话模型重新
    // 误杀(codex review)。device 场景调用方契约保证 `providers` 即**被控端**供应商目录
    // (useDeviceProviders),有目录时同样带上下文过滤,被控端自定义对话模型的豁免生效;
    // 老被控端(不支持 maker:provider:list,目录为空)退化纯启发式 —— 已记录边界。
    const conversational = fromDevicePath
      ? list.filter((m) => {
          const offering = providers.filter((p) => providerOffersModel(p, m.id, agent));
          if (offering.length === 0) return isConversationModel(m);
          return offering.some((p) => {
            const cm = p.models[agent]?.find((x) => x.id === m.id);
            return cm !== undefined && isConversationModel(cm, p);
          });
        })
      : list;
    return excludeSubscriptionDirect
      ? conversational.filter((m) => !isSubscriptionDirectModel(m.id))
      : conversational;
  };
  const codexDeriveOpts = excludeChatBridgedCodex
    ? { excludeProvider: isChatBridgedCodexProvider }
    : undefined;
  const cc = drop(
    deviceId ? deviceCcModels : deriveModelsFromProviders(providers, 'claude-code'),
    'claude-code',
    !!deviceId,
  );
  const codex = drop(
    deviceId ? deviceCodexModels : deriveModelsFromProviders(providers, 'codex', codexDeriveOpts),
    'codex',
    !!deviceId,
  );
  if (agentKind === 'claude-code') return cc;
  if (agentKind === 'codex') return codex;
  const merged = [...cc];
  const seen = new Set(merged.map((m) => m.id));
  for (const m of codex) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push(m);
  }
  return merged;
}

/**
 * Resolve one row's agent using the same first-wins order as `selectVisibleModels`.
 * This is deliberately row-scoped: a merged picker must not classify every row from the currently
 * selected model's agent when deciding whether the controlled device can route that row.
 */
export function resolveVisibleModelAgentKind(params: {
  modelId: string;
  agentKind: AgentKind | null;
  ccModels: ModelDescriptor[];
  codexModels: ModelDescriptor[];
  providers: ProviderView[];
}): AgentKind | null {
  const { modelId, agentKind, ccModels, codexModels, providers } = params;
  if (agentKind) return agentKind;
  if (ccModels.some((model) => model.id === modelId)) return 'claude-code';
  if (codexModels.some((model) => model.id === modelId)) return 'codex';
  if (providers.some((provider) => providerOffersModel(provider, modelId, 'claude-code'))) {
    return 'claude-code';
  }
  if (providers.some((provider) => providerOffersModel(provider, modelId, 'codex'))) {
    return 'codex';
  }
  return null;
}
