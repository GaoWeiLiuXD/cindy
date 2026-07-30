/**
 * useModelAccessCreditUsage — 订阅个人租户在 AIGateway 上的额度池账本
 * (plan / purchased / promotional 三池的 remaining / used / total)。
 *
 * 为什么不复用 useClaudeAccountUsage:
 *   两者是**不同租户的不同额度语义**,不是同一份数据的两个入口。
 *     - XD 企业 (Nova 控制面签发 LiteLLM token): 语义是 spend / max_budget,
 *       有月度周期,由 useClaudeAccountUsage 走推理入口的 LiteLLM 管理面接口拿。
 *     - 个人租户 (Server 直连自研 AIGateway /api/v1): 语义是三池账本,买断 + 赠送制,
 *       没有月度周期。推理入口 (laxa) 不提供管理面接口,只能经 Server 的
 *       /api/model-access/credit-usage 拿 —— 即本 hook。
 *   见 model-access-server/src/services/tenants.ts 的租户分流注释。
 *
 * 数据通道: billingApi.getCreditUsage() → IPC billing:get-credit-usage
 *   → main/billing GET /api/model-access/credit-usage (Server 侧带 master key
 *   查 Gateway 账本)。是 invoke 拉取,没有 push 通道。
 *
 * 刷新: mount 拉一次 + enabled 期间定时轮询。额度只在跑 turn 后变化,轮询周期取
 * 得比较松 —— 这是状态栏的辅助信息,不值得为它加高频请求。
 *
 * 失败一律返 null (消费方隐藏该指标,不显示会误导的 0):
 *   - XD 企业身份 → Server 抛 BALANCE_NOT_SUPPORTED (Nova 控制面没有账本 contract)
 *   - 账号未在 Gateway 开户 / Gateway 不可用 / 网络失败
 *
 * module-local cache 让切换会话时 chip 不闪空 (与 useClaudeAccountUsage 同做法)。
 */

import { useEffect, useState } from 'react';

import type { ModelAccessCreditUsage } from '../../shared/modelAccess';
import { billingApi } from '../features/billing/api';

/** 额度变化只跟 turn 走,状态栏辅助信息不值得高频拉取。 */
const REFRESH_INTERVAL_MS = 60_000;

let lastUsage: ModelAccessCreditUsage | null = null;

function isCreditPool(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const pool = v as { remaining?: unknown; used?: unknown; total?: unknown };
  return (
    typeof pool.remaining === 'string' &&
    (typeof pool.used === 'string' || pool.used === null) &&
    (typeof pool.total === 'string' || pool.total === null)
  );
}

function isCreditUsage(v: unknown): v is ModelAccessCreditUsage {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<ModelAccessCreditUsage>;
  return (
    typeof r.available === 'string' &&
    isCreditPool(r.plan) &&
    isCreditPool(r.purchased) &&
    isCreditPool(r.promotional)
  );
}

export function useModelAccessCreditUsage(
  enabled: boolean,
): ModelAccessCreditUsage | null {
  const [usage, setUsage] = useState<ModelAccessCreditUsage | null>(() =>
    enabled ? lastUsage : null,
  );

  useEffect(() => {
    setUsage(enabled ? lastUsage : null);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const load = () => {
      void billingApi
        .getCreditUsage()
        .then((res) => {
          if (cancelled) return;
          if (!isCreditUsage(res)) return;
          lastUsage = res;
          setUsage(res);
        })
        .catch(() => {
          /* 企业身份 NOT_SUPPORTED / 未开户 / 网关不可用 → 保持上一次值, 不清空 */
        });
    };

    load();
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  return usage;
}
