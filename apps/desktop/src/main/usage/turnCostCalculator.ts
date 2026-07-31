/**
 * 单轮费用计算。定价先看实际 billing route，再看模型；模型名不再决定来源。
 */

import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

import {
  gatewayLedgerCurrency,
  getModelPriceQuote,
  providerReferencePriceQuote,
} from '../../shared/modelPriceQuote.js';
import {
  addRegionalMoney,
  gatewayCurrencyForRegion,
  regionalizeMoney,
  regionalizeUsd,
  usdMoney,
  type ModelPriceQuote,
  type ModelPricingCatalog,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
import { buildTurnUsageDetails, type TurnUsageDetails } from '../../shared/turnUsageDetails.js';
import { isSubscriptionDirectModel } from '../../shared/subscriptionModels.js';
import type { ModelUsageDeltaEntry } from './modelUsageDelta.js';

export interface TurnTokenDeltas {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export type BillingRoute = 'xd-gateway' | 'provider-api' | 'subscription' | 'unknown';

export interface TurnPricingContext {
  providerId: string | null;
  billingRoute: BillingRoute;
  region: CindyRegion;
}


export type TurnCostSource = 'sdk' | 'gateway' | 'sdk-fallback' | 'subscription';

export interface TurnCostResolution {
  model: string;
  money: RegionalMoney | null;
  source: TurnCostSource;
}

export function normalizeModelIdForPricing(model: string | null | undefined): string {
  const trimmed = (model ?? '').trim();
  if (!trimmed) return 'unknown';
  const stripped = trimmed.replace(/\[[^\]]*\]\s*$/, '').trim();
  return stripped || 'unknown';
}

export function isAnthropicModel(normalizedModel: string): boolean {
  return (
    normalizedModel.startsWith('claude-') ||
    normalizedModel === 'sonnet' ||
    normalizedModel === 'haiku' ||
    normalizedModel === 'opus'
  );
}

/**
 * token × quote → quote 币种金额。cache 价缺失时按输入价计，和详情文案一致。
 */
export function computeGatewayTurnCost(
  tokens: TurnTokenDeltas,
  price: ModelPriceQuote | undefined,
): number | null {
  if (!price) return null;
  const cacheReadPrice = price.cacheReadPerMtok ?? price.inputPerMtok;
  const cacheCreatePrice = price.cacheCreatePerMtok ?? price.inputPerMtok;
  return (
    (tokens.inputTokens * price.inputPerMtok +
      tokens.outputTokens * price.outputPerMtok +
      tokens.cacheReadTokens * cacheReadPrice +
      tokens.cacheCreateTokens * cacheCreatePrice) /
    1_000_000
  );
}

export function computePriceQuoteTurnMoney(
  tokens: TurnTokenDeltas,
  price: ModelPriceQuote | undefined,
  region: CindyRegion,
): RegionalMoney | null {
  if (!price) return null;
  const standardAmount = computeGatewayTurnCost(tokens, price);
  if (standardAmount == null) return null;
  const discount =
    price.source === 'gateway' &&
    typeof price.costDiscount === 'number' &&
    Number.isFinite(price.costDiscount) &&
    price.costDiscount > 0 &&
    price.costDiscount <= 1
      ? price.costDiscount
      : 0;
  const amount = standardAmount * (1 - discount);
  const valueEstimate = price.source === 'subscription-reference';
  const money: RegionalMoney = {
    amount: Math.max(0, amount),
    currency: price.currency,
    approximate: price.approximate || valueEstimate,
    kind: valueEstimate ? 'value-estimate' : 'actual-cost',
    ...(valueEstimate
      ? { estimateReasons: ['subscription-value', 'reference-price'] }
      : price.approximate
        ? { estimateReasons: ['reference-price'] }
        : {}),
  };
  // Gateway 报价的币种就是该账号的实际结算币种,必须原样记账才能与账单对账。
  // 它不保证等于客户端发行区域:多数账号跟随区域(cn=CNY / global=USD),但也存在以 USD
  // 结算的账号运行在 CN 构建上的正常情形。
  //
  // 所以 gateway 来源一律不做区域换算 —— 否则这类账号的 turn 会被 USD_TO_CNY_FIXED_RATE
  // 折成 CNY,而同一界面的账号配额(走 gatewayMoney,不换算)仍是 USD 原值,造成同一行
  // $ / ¥ 混排且金额差一个汇率倍数、无法与服务端账单核对。
  // 其余来源(第三方参考价、订阅价值估算)本就是 USD 口径,继续按区域投影到本地账本。
  return price.source === 'gateway' ? money : regionalizeMoney(money, region);
}

export function resolveTurnCost(args: {
  rawModel: string;
  tokens: TurnTokenDeltas;
  sdkCostDelta?: number;
  pricing: ModelPricingCatalog | null | undefined;
  context: TurnPricingContext;
}): TurnCostResolution {
  const { rawModel, tokens, sdkCostDelta, pricing, context } = args;
  const model = normalizeModelIdForPricing(rawModel);

  if (context.billingRoute === 'subscription' || isSubscriptionDirectModel(model)) {
    return { model, money: null, source: 'subscription' };
  }

  if (context.billingRoute === 'xd-gateway') {
    const quote = getModelPriceQuote(pricing, 'xd', model);
    if (!quote) {
      // 该模型没有报价(上游未登记,或目录还没同步下来)。SDK 的 costDelta 是 USD,
      // 只有当本账号的 Gateway 结算币种同为 USD 时才能直接兜底记账。
      //
      // 判据取自同一目录里其它 xd 报价声明的币种 —— 服务端按账号所属租户下发，不保证
      // 等于客户端发行区域。因此这里既不看构建区域,也不需要知道是哪类账号,
      // USD 结算的账号自然被覆盖到、不会漏记。
      // 目录整体为空(真冷启动)时退回按区域推断,保持原有行为。
      //
      // 币种不同(如 CN 个人租户的 CNY 账本)仍然不兜底:SDK 值既不是该账号的报价口径、
      // 也不含 costDiscount,折算进去只会误记,宁可这一轮不记。
      const ledgerCurrency =
        gatewayLedgerCurrency(pricing) ?? gatewayCurrencyForRegion(context.region);
      const fallbackUsd = Math.max(0, sdkCostDelta ?? 0);
      return {
        model,
        money: ledgerCurrency === 'USD' && fallbackUsd > 0 ? usdMoney(fallbackUsd) : null,
        source: 'sdk-fallback',
      };
    }
    return {
      model,
      money: computePriceQuoteTurnMoney(tokens, quote, context.region),
      source: 'gateway',
    };
  }

  const sdkAmount = Math.max(0, sdkCostDelta ?? 0);
  const money = sdkAmount > 0 ? regionalizeUsd(sdkAmount, context.region) : null;
  return {
    model,
    money,
    source: context.billingRoute === 'provider-api' ? 'sdk' : 'sdk-fallback',
  };
}

export interface ResolvedModelCost {
  model: string;
  money: RegionalMoney | null;
  source: TurnCostSource;
  deltas: TurnTokenDeltas;
}

export interface ClaudeTurnCostResolution {
  turnMoney: RegionalMoney | null;
  perModel: ResolvedModelCost[];
}

export function resolveClaudeTurnCostSinks(
  modelDeltas: ModelUsageDeltaEntry[],
  pricing: ModelPricingCatalog | null | undefined,
  context: TurnPricingContext,
): ClaudeTurnCostResolution {
  const perModel: ResolvedModelCost[] = [];
  const money: RegionalMoney[] = [];
  for (const delta of modelDeltas) {
    const tokens: TurnTokenDeltas = {
      inputTokens: delta.inputTokensDelta,
      outputTokens: delta.outputTokensDelta,
      cacheReadTokens: delta.cacheReadTokensDelta,
      cacheCreateTokens: delta.cacheCreateTokensDelta,
    };
    const resolved = resolveTurnCost({
      rawModel: delta.model,
      tokens,
      sdkCostDelta: delta.costUsdDelta,
      pricing,
      context,
    });
    perModel.push({
      model: resolved.model,
      money: resolved.money,
      source: resolved.source,
      deltas: tokens,
    });
    if (resolved.money && resolved.money.amount > 0) money.push(resolved.money);
  }
  if (money.length === 0) return { turnMoney: null, perModel };
  return {
    turnMoney: addRegionalMoney(money),
    perModel,
  };
}

export function estimateClaudeSubscriptionTurnValue(
  perModel: ResolvedModelCost[],
  region: CindyRegion,
): RegionalMoney | null {
  const values: RegionalMoney[] = [];
  for (const item of perModel) {
    if (!isAnthropicModel(item.model) || item.money?.amount) continue;
    const quote = providerReferencePriceQuote('anthropic', item.model);
    if (!quote) continue;
    const value = computePriceQuoteTurnMoney(item.deltas, quote, region);
    if (value && value.amount > 0) values.push(value);
  }
  return values.length > 0 ? addRegionalMoney(values) : null;
}

export function buildClaudeTurnUsageDetails(
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined,
  deltas: ModelUsageDeltaEntry[] | undefined,
  fallbackModel: string,
  perModel?: ResolvedModelCost[],
): TurnUsageDetails | null {
  const hasModelUsageDeltas = Boolean(deltas && deltas.length > 0);
  const perModelCost = perModel
    ?.filter((item) => item.money && item.money.amount > 0)
    .map((item) => ({ model: item.model, money: item.money! }));
  return buildTurnUsageDetails({
    inputTokens: hasModelUsageDeltas
      ? deltas?.reduce((sum, delta) => sum + delta.inputTokensDelta, 0)
      : usage?.input_tokens,
    outputTokens: hasModelUsageDeltas
      ? deltas?.reduce((sum, delta) => sum + delta.outputTokensDelta, 0)
      : usage?.output_tokens,
    cacheReadTokens: hasModelUsageDeltas
      ? deltas?.reduce((sum, delta) => sum + delta.cacheReadTokensDelta, 0)
      : usage?.cache_read_input_tokens,
    cacheCreateTokens: hasModelUsageDeltas
      ? deltas?.reduce((sum, delta) => sum + delta.cacheCreateTokensDelta, 0)
      : usage?.cache_creation_input_tokens,
    model: deltas?.length === 1 ? deltas[0].model : hasModelUsageDeltas ? undefined : fallbackModel,
    models: hasModelUsageDeltas ? deltas?.map((delta) => delta.model) : undefined,
    perModelCost: perModelCost && perModelCost.length > 0 ? perModelCost : undefined,
  });
}
