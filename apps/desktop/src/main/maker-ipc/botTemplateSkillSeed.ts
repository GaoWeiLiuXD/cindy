import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { BotTemplatePresetId } from '../../shared/botTemplatePreset.js';
import {
  botSkillRootDir,
  listBotSkills,
  seedBotSkillIfMissing,
  type BotSkillRecord,
} from './botSkillStore.js';

type TemplateSkillSeed = {
  slug: string;
  name: string;
  description: string;
  body: string;
};

export interface BotTemplateSkillSeedResult {
  /** 本次是否刚把整套模板安装推进到“完成”；用于刷新已经存在的运行时。 */
  completedNow: boolean;
  skills: Array<{ record: BotSkillRecord; created: boolean }>;
}

const TEMPLATE_SKILLS: Record<BotTemplatePresetId, readonly TemplateSkillSeed[]> = {
  cindy: [
    {
      slug: 'help-with-cindy',
      name: '使用 Cindy 完成工作',
      description: '用户需要调整 Cindy、连接工具、找到合适的伙伴或完成具体工作时使用。',
      body: [
        '# 使用 Cindy 完成工作',
        '',
        '- 从用户眼前想完成的事情开始；先使用实际可用的 Cindy 能力查询入口核对功能与操作，不凭记忆编造菜单。',
        '- 需要插件时发现已安装、已启用的插件，读取对应说明再调用；已有连接直接复用，缺少连接时使用现有连接入口。',
        '- 需要专门方法或工具时，按需发现并加入已有 Skill 或 MCP，不复制整套能力库，不把能力发现当作外部操作授权。',
        '- 简单工作自己完成；编码实施和中大型工作交给独立 Cindy 任务，带上目标、材料、约束和验收要求。',
        '- 需要其他伙伴时按实际阵容与能力选择，不假定任何预设伙伴存在。结果返回后核对成果，再向用户交付。',
      ].join('\n'),
    },
  ],
  dash: [
    {
      slug: 'make-executive-decisions',
      name: '高管决策',
      description: '用户要求定方向、选方案、排优先级或审批重要事项时使用。',
      body: [
        '# 高管决策',
        '',
        '- 用一句话定义真正要决定的问题、截止点和不决定的代价。',
        '- 分开列出事实、假设、约束和信息缺口，只保留真正不同的少量方案。',
        '- 从长期目标、用户价值、投入产出、组织能力和风险承受度比较方案。',
        '- 必须给出一个明确结论：通过、补充信息或暂缓；随后写理由、主要风险、负责人和下一步。',
        '- 重要决定使用文档工具形成一页决策纪要，记录背景、选择、被放弃方案和复盘时间点。',
      ].join('\n'),
    },
    {
      slug: 'review-business-cases',
      name: '经营方案审查',
      description: '用户讨论预算、定价、商业模式、投入产出、招聘或资源配置时使用。',
      body: [
        '# 经营方案审查',
        '',
        '- 先明确目标指标、时间跨度、资源上限和决策门槛。',
        '- 把收入、成本、现金、机会成本和关键依赖分开；没有数据时列出所需数据，不编造精确数字。',
        '- 对关键变量至少做基准、乐观、保守三种情景，并指出结论在哪个假设下会反转。',
        '- 同时检查执行负责人、组织负荷、合规或声誉风险以及退出成本。',
        '- 需要计算或审批时，用文档工具制作可复核的测算表和简短审批建议，公式与假设必须可见。',
      ].join('\n'),
    },
    {
      slug: 'review-product-proposals',
      name: '产品方案审批',
      description: '用户评审产品方向、路线图、体验、品牌表达或上线方案时使用。',
      body: [
        '# 产品方案审批',
        '',
        '- 先说明目标用户、真实问题、使用场景和成功标准，再看具体功能或视觉方案。',
        '- 检查价值是否清楚、范围是否完整、体验是否一致克制、品牌表达是否适合办公场景。',
        '- 区分必须解决的问题与个人偏好；不给只靠形容词的审美结论。',
        '- 涉及技术可行性、安全或交付成本时请 LiZi 给出证据，最终产品取舍仍由 Dash 收口。',
        '- 输出通过、要求修改或暂缓，并列出上线前必须满足的少量条件；需要汇报时用文档工具形成评审纪要或汇报稿。',
      ].join('\n'),
    },
  ],
  lizi: [
    {
      slug: 'deliver-engineering-changes',
      name: '开发交付',
      description: '用户要求开发、修复、重构、补测试或完成工程改动时使用。',
      body: [
        '# 开发交付',
        '',
        '- 先检查真实工作区、规则、现有实现和未提交改动，明确可见结果与边界。',
        '- 选择最小但完整的实现；保护用户已有工作，不顺手扩大需求。',
        '- 修改代码时同步处理必要测试、错误路径、兼容性和用户可见文案。',
        '- 按风险运行定向测试、类型检查和必要的更广验证，并检查真实产物，不把“代码路径跑过”当成交付完成。',
        '- 最终交付实际改动、验证证据、未验证项和剩余风险。涉及提交、发布或不可逆操作时遵守项目规则并取得所需授权。',
      ].join('\n'),
    },
    {
      slug: 'diagnose-technical-incidents',
      name: '技术故障诊断',
      description: '遇到报错、日志异常、崩溃、性能下降或线上事故，需要定位根因时使用。',
      body: [
        '# 技术故障诊断',
        '',
        '- 先保存症状、时间线、影响范围和环境差异；能复现就给出最小复现。',
        '- 用代码、日志、配置和运行状态建立证据链，区分症状、直接原因、根因与尚未验证的假设。',
        '- 先给安全的止血方案，再给根治方案和回归范围；用户只要求诊断时不要擅自实施修复。',
        '- 验证修复既消除原问题，也没有破坏相邻路径；无法验证的部分明确列出。',
        '- 重大事故用文档工具形成复盘：影响、时间线、根因、处理、预防措施、负责人和完成时间。',
      ].join('\n'),
    },
    {
      slug: 'review-architecture-and-release',
      name: '架构与上线评审',
      description: '用户要求评审架构、API、数据迁移、安全边界或发布方案时使用。',
      body: [
        '# 架构与上线评审',
        '',
        '- 先画清组件边界、数据流、状态归属、信任边界和失败路径，再判断方案。',
        '- 检查兼容性、迁移、并发、幂等、权限、隐私、性能、可观测性和恢复能力；只报告有证据的风险。',
        '- Findings 按严重度排序，写清触发条件、影响和建议；不要用风格偏好冒充阻塞问题。',
        '- 发布前必须覆盖迁移顺序、灰度或开关、监控信号、回滚条件、数据恢复和负责人。',
        '- 需要长期使用时，用文档工具形成 ADR 或技术方案，并附上线检查表；结论明确为可上线、有条件上线或不可上线。',
      ].join('\n'),
    },
  ],
};

const LEGACY_V1_SLUGS: Record<BotTemplatePresetId, readonly string[]> = {
  cindy: ['everyday-work-coordination'],
  dash: ['executive-decision-review'],
  lizi: ['technical-delivery'],
};

function legacyCompletionMarkerPath(
  userDataDir: string,
  botId: string,
  templateId: BotTemplatePresetId,
): string {
  return path.join(botSkillRootDir(userDataDir, botId), `.template-skills-${templateId}.seeded`);
}

function manifestPath(userDataDir: string, botId: string, templateId: BotTemplatePresetId): string {
  return path.join(botSkillRootDir(userDataDir, botId), `.template-skills-${templateId}.json`);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function readOfferedSlugs(
  userDataDir: string,
  botId: string,
  templateId: BotTemplatePresetId,
): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(manifestPath(userDataDir, botId, templateId), 'utf8'),
    ) as {
      offeredSlugs?: unknown;
    };
    if (Array.isArray(parsed.offeredSlugs)) {
      return new Set(
        parsed.offeredSlugs.filter((item): item is string => typeof item === 'string'),
      );
    }
  } catch {
    // 缺失或损坏的 manifest 走旧标记迁移；绝不因为元数据损坏覆盖现有 Skill。
  }
  return (await fileExists(legacyCompletionMarkerPath(userDataDir, botId, templateId)))
    ? new Set(LEGACY_V1_SLUGS[templateId])
    : new Set();
}

async function writeOfferedSlugs(
  userDataDir: string,
  botId: string,
  templateId: BotTemplatePresetId,
  offeredSlugs: Set<string>,
): Promise<void> {
  const target = manifestPath(userDataDir, botId, templateId);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(
    temporary,
    `${JSON.stringify({ version: 2, offeredSlugs: [...offeredSlugs].sort() }, null, 2)}\n`,
    'utf8',
  );
  await fs.rename(temporary, target);
}

/**
 * 创建预设伙伴时安装真实 Skill；同 slug 已存在则完整保留用户版本。
 *
 * manifest 记录的是“曾经提供过”，而不是“当前存在”。这样模板升级只补新能力，
 * 用户主动删除过的内置 Skill 不会在下次任务中被擅自装回来。
 */
export async function seedBotTemplateSkills(
  userDataDir: string,
  botId: string,
  templateId: BotTemplatePresetId,
): Promise<BotTemplateSkillSeedResult> {
  // list 同时完成旧 Cindy frontmatter 的无损标准化，确保已经装过的模板 Skill
  // 也能被所有 harness 识别，而不是只修以后新写的文件。
  await listBotSkills(userDataDir, botId);
  const offeredSlugs = await readOfferedSlugs(userDataDir, botId, templateId);
  const pending = TEMPLATE_SKILLS[templateId].filter((skill) => !offeredSlugs.has(skill.slug));
  if (pending.length === 0) return { completedNow: false, skills: [] };

  const skills = await Promise.all(
    pending.map((skill) => seedBotSkillIfMissing(userDataDir, botId, skill)),
  );
  for (const skill of pending) offeredSlugs.add(skill.slug);
  await writeOfferedSlugs(userDataDir, botId, templateId, offeredSlugs);
  return { completedNow: true, skills };
}
