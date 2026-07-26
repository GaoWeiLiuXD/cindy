/**
 * 「订阅直连」模型前缀 —— re-export shim(P2):正本已下沉
 * `@cindy/model-providers` classification(P1,与分类/徽章共用一份前缀,
 * 防路由 / 记账 gate / 分组展示三方漂移)。本文件保留原路径,main / renderer
 * 既有消费方 import 不变;新代码请直接从包引入。
 */

export {
  CHATGPT_MODEL_PREFIX,
  XAI_MODEL_PREFIX,
  SUBSCRIPTION_DIRECT_MODEL_PREFIXES,
  isSubscriptionDirectModel,
} from '@cindy/model-providers';
