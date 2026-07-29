/**
 * 会话金额的统一展示投影。
 *
 * actual-cost 由 sessions 账本持有，value-estimate 由消息明细重建。二者是不同
 * 的事实源，但“本对话”展示需要稳定地汇总两者，不能由当前模型/provider 决定
 * 只读取其中一条链路。
 */

import { useMemo } from 'react';

import {
  addCompatibleRegionalMoney,
  DEFAULT_USAGE_CURRENCY,
  regionalizeMoney,
  type RegionalMoney,
} from '../../shared/regionalMoney';
import { useSessionEstimatedValue } from './useSessionEstimatedValue';
import { useSessionSpend } from './useSessionSpend';

export interface SessionUsageMoney {
  actualMoney: RegionalMoney | null;
  estimatedValueMoney: RegionalMoney | null;
  totalMoney: RegionalMoney | null;
}

export function combineSessionUsageMoney(
  actualMoney: RegionalMoney | null,
  estimatedValueMoney: RegionalMoney | null,
): SessionUsageMoney {
  // 旧 turnCostUsd 只在读侧投影：活跃账本已是 CNY 时按固定汇率纳入会话合计；
  // 仍为 USD 的历史会话保持同单位，不猜测或改写历史脏数据。
  const preferredCurrency = actualMoney?.currency ?? DEFAULT_USAGE_CURRENCY;
  const displayedEstimatedValueMoney =
    preferredCurrency === 'CNY' &&
    estimatedValueMoney?.currency === 'USD' &&
    estimatedValueMoney.estimateReasons?.includes('legacy-usd')
      ? regionalizeMoney(estimatedValueMoney, 'cn')
      : estimatedValueMoney;
  const values = [actualMoney, displayedEstimatedValueMoney].filter(
    (money): money is RegionalMoney => Boolean(money && money.amount > 0),
  );
  return {
    actualMoney,
    estimatedValueMoney: displayedEstimatedValueMoney,
    totalMoney: values.length > 0 ? addCompatibleRegionalMoney(values) : null,
  };
}

export function useSessionUsageMoney(
  sessionId: string | undefined,
  initialMoney: RegionalMoney | null | undefined,
  initialCostUsd: number | null | undefined,
): SessionUsageMoney {
  const actualMoney = useSessionSpend(sessionId, initialMoney, initialCostUsd);
  const estimatedValueMoney = useSessionEstimatedValue(sessionId, Boolean(sessionId));

  return useMemo(
    () => combineSessionUsageMoney(actualMoney, estimatedValueMoney),
    [actualMoney, estimatedValueMoney],
  );
}
