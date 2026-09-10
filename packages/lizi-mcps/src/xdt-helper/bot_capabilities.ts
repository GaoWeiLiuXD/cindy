import { z } from "zod";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import type { ControlResult, LiziMcpSessionContext } from "../types.js";
import { errorPayload, okPayload } from "./_payload.js";

export interface BotCapabilityCallbacks {
  /** Host resolves the caller; tools never accept another Bot's id or raw config. */
  inspect?(params: { callerSessionId: string }): Promise<ControlResult<{ state: BotControlState }, string>>;
  updateProfile?(params: {
    callerSessionId: string;
    expectedVersion: number;
    name?: string;
    description?: string;
    identitySource?: string;
  }): Promise<ControlResult<{ effective: "next-turn" }, string>>;
  list(params: {
    callerSessionId: string;
    kind: "skill" | "mcp" | "toolset";
    query?: string;
  }): Promise<
    ControlResult<
      {
        capabilities: {
          id: string;
          name: string;
          description: string;
          joined: boolean;
          available: boolean;
        }[];
      },
      string
    >
  >;
  select(params: {
    callerSessionId: string;
    kind: "skill" | "mcp" | "toolset";
    id: string;
    joined: boolean;
  }): Promise<
    ControlResult<{ effective: "next-turn"; joined: boolean }, string>
  >;
}

export interface BotControlState {
  profile: { id: string; name: string; description: string; identitySource: string; version: number };
  session: { id: string; workingDir: string | null; remoteHostId: string | null };
  model: { source: "override" | "default"; candidates: { harness: string; providerId?: string | null; model: string }[] };
  memory: { enabled: boolean; scope: "self" };
  references: { skills: string[]; mcpServers: string[]; toolsets: string[] };
}

/** Same instructions in the runtime baseline and tool descriptions. */
export const BOT_CONTROL_GUIDANCE = [
  'Use `get_bot_state` to inspect your current profile, stable chat, configured model candidates, memory switch and capability references. Candidates and selected references are not proof of the model or tools running this turn; the live runtime and registered tools are authoritative.',
  'Use `update_bot_profile` only when the user asks to change your name, introduction or identity; read the current version first and patch only the requested fields. Changes apply next turn without replacing memory, Skills, model settings or chat history.',
  'Use `get_capabilities` for Cindy product features and UI guidance. It describes the product, not a permission grant or proof that every feature is available here. Use the matching live tool to act, and verify its result before claiming success.',
].join('\n');

const FIND_BOT_CAPABILITIES_CORE =
  "按需查找 Cindy 已有的 Skill、MCP 连接或内置工具集，返回可用性和当前伙伴是否已加入。";
const FIND_BOT_CAPABILITIES_PLUGIN_SENTENCE =
  "插件用 cindy 的 ghost_list / ghost_info 发现并直接按现有授权调用。";

/**
 * Local Cindy sessions keep the plugin/`ghost_*` sentence byte-identical.
 * SSH Claude/Codex mount `cindy_helper` but not the `cindy` gateway, so that
 * sentence must be omitted or the model is told to call unreachable tools.
 */
export function buildFindBotCapabilitiesDescription(cindyAvailable = true): string {
  return cindyAvailable
    ? `${FIND_BOT_CAPABILITIES_CORE}${FIND_BOT_CAPABILITIES_PLUGIN_SENTENCE}`
    : FIND_BOT_CAPABILITIES_CORE;
}

export function withCindyGatedBotToolDescriptions<T extends { name: string; description?: string }>(
  tools: readonly T[],
  cindyAvailable: boolean,
): T[] {
  if (cindyAvailable) return [...tools];
  return tools.map((tool) =>
    tool.name === "find_bot_capabilities"
      ? { ...tool, description: buildFindBotCapabilitiesDescription(false) }
      : tool,
  );
}

/** Shared capability discovery keeps schemas out of the companion's initial context. */
export function registerBotCapabilityTools(
  registry: XdtHelperToolRegistry,
  deps: {
    getSessionContext: () => LiziMcpSessionContext;
    callbacks: BotCapabilityCallbacks;
    cindyAvailable?: boolean;
  },
): void {
  if (deps.callbacks.inspect) registry.register({
    name: "get_bot_state",
    category: "bots",
    description: BOT_CONTROL_GUIDANCE,
    inputShape: {},
    handler: async () => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload("NOT_A_BOT_SESSION", "当前调用未绑定伙伴任务");
      const result = await deps.callbacks.inspect!({ callerSessionId });
      return result.ok ? okPayload({ state: result.state }) : errorPayload(result.errorCode, result.message);
    },
  });
  if (deps.callbacks.updateProfile) registry.register({
    name: "update_bot_profile",
    category: "bots",
    description: BOT_CONTROL_GUIDANCE,
    inputShape: {
      expectedVersion: z.number().int().positive(),
      name: z.string().trim().min(1).max(200).optional(),
      description: z.string().max(12000).optional(),
      identitySource: z.string().max(12000).optional(),
    },
    handler: async (input) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload("NOT_A_BOT_SESSION", "当前调用未绑定伙伴任务");
      if (input.name === undefined && input.description === undefined && input.identitySource === undefined)
        return errorPayload("INVALID_PARAMS", "请选择要修改的资料");
      const result = await deps.callbacks.updateProfile!({ ...input, callerSessionId });
      return result.ok ? okPayload({ effective: result.effective }) : errorPayload(result.errorCode, result.message);
    },
  });
  const kind = z.enum(["skill", "mcp", "toolset"]);
  registry.register({
    name: "find_bot_capabilities",
    category: "bots",
    description: buildFindBotCapabilitiesDescription(deps.cindyAvailable !== false),
    inputShape: { kind, query: z.string().max(200).optional() },
    handler: async (input) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId)
        return errorPayload("NOT_A_BOT_SESSION", "当前调用未绑定伙伴任务");
      const result = await deps.callbacks.list({ ...input, callerSessionId });
      return result.ok
        ? okPayload({ capabilities: result.capabilities })
        : errorPayload(result.errorCode, result.message);
    },
  });
  registry.register({
    name: "set_bot_capability",
    category: "bots",
    description:
      "把查到的已有能力加入当前伙伴，或从当前伙伴移除。复用 Cindy 已有安装和连接，不修改共享源、凭证或全局开关。新挂载在下一轮生效；当前轮不要声称已有尚未挂载的工具。",
    inputShape: { kind, id: z.string().min(1).max(512), joined: z.boolean() },
    handler: async (input) => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId)
        return errorPayload("NOT_A_BOT_SESSION", "当前调用未绑定伙伴任务");
      const result = await deps.callbacks.select({ ...input, callerSessionId });
      return result.ok
        ? okPayload({ effective: result.effective, joined: result.joined })
        : errorPayload(result.errorCode, result.message);
    },
  });
}
