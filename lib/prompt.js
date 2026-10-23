/**
 * prompt.js — 构造一次后台分析提示词，并程序化解析/校验模型的 JSON 输出。
 *
 * v0.3（task-16）：一次调用同时产出五件事 ——
 *  1) project_memory 全量条目（≤40/条、≤600 总）；
 *  2) identity 用户身份（**从对话判断/推断**稳定身份：职业/角色、语言、专业领域等，
 *     如「在开发插件」→「职业：开发人员」；≤60 码点，禁止推断健康/政治/宗教等敏感属性）；
 *  3) habits 用户习惯（长期稳定偏好，每条 ≤20、总 ≤120、去重；不记一次性要求）；
 *  4) credentials 账号密码/令牌（≤60 码点，格式「服务:账号/密码；…」）；
 *  5) divergence 话题差异标签：`{status:none|new|continuing|commit, tag:≤6码点, same:boolean}`。
 *
 * 核心信任边界：模型输出一律当不可信数据处理 ——
 *  - 去代码围栏、取第一个 `{` 到最后一个 `}`，JSON.parse 失败即整回合放弃；
 *  - project_memory 必须是数组；逐条 trim/去换行/去空；单条超长截断；总量超限丢条目；
 *  - identity/credentials：`action === 'set'` 时 text 非空、无换行、≤ 预算，否则视为无变化；
 *  - habits：`action === 'set'` 时 items 必须数组；逐条规范化/≤20/去重；总量超 120 整段拒绝；
 *  - divergence：仅接受 none/new/continuing/commit，tag 截断 ≤6；非法状态按 none（清空）处理。
 *
 * 本模块零依赖、纯函数，可被单测直接 import。
 */
import { parseDivergence } from './divergence.js';
import {
  DEFAULT_ENTRY_MAX_CHARS,
  DEFAULT_PROJECT_MAX_CHARS,
  codePointLength,
  extractJsonObject,
  fitEntries,
  sanitizeVaultText,
  stripCodeFences,
  truncateCodePoints,
} from './text.js';

/** 长期记忆各段默认预算（码点）。 */
export const DEFAULT_IDENTITY_MAX_CHARS = 60;
export const DEFAULT_HABITS_MAX_CHARS = 120;
export const DEFAULT_HABIT_ENTRY_MAX_CHARS = 20;
export const DEFAULT_CREDENTIALS_MAX_CHARS = 60;
/** @deprecated v0.2 名称（= identity/credentials 默认预算）。 */
export const DEFAULT_VAULT_SECTION_MAX_CHARS = 60;

/** JSON 输出解析失败的错误码（写日志用，不含模型原文）。 */
export const PARSE_ERROR = Object.freeze({
  NO_JSON: 'NO_JSON',
  BAD_JSON: 'BAD_JSON',
  BAD_SHAPE: 'BAD_SHAPE',
  BAD_PROJECT_MEMORY: 'BAD_PROJECT_MEMORY',
  EMPTY_OUTPUT: 'EMPTY_OUTPUT',
});

/**
 * 构造分析提示词（v0.3 五段输出）。
 *
 * @param {object} input
 * @param {string[]} [input.projectEntries] - 当前项目记忆条目
 * @param {string} [input.identityText] - 当前用户身份明文（可能为空）
 * @param {string[]} [input.habits] - 当前用户习惯
 * @param {string} [input.credentialsText] - 当前账号密码明文（可能为空）
 * @param {string} [input.turnText] - 本回合「用户/助手」文本（已截断）
 * @param {number} [input.entryMaxChars]
 * @param {number} [input.projectMaxChars]
 * @param {number} [input.identityMaxChars]
 * @param {number} [input.habitsMaxChars]
 * @param {number} [input.habitEntryMaxChars]
 * @param {number} [input.credentialsMaxChars] - longtermMaxChars 亦兼容
 * @returns {string}
 */
export function buildAnalysisPrompt(input = {}) {
  const entryMaxChars = numberOr(input.entryMaxChars, DEFAULT_ENTRY_MAX_CHARS);
  const projectMaxChars = numberOr(input.projectMaxChars, DEFAULT_PROJECT_MAX_CHARS);
  const identityMaxChars = numberOr(input.identityMaxChars, DEFAULT_IDENTITY_MAX_CHARS);
  const habitsMaxChars = numberOr(input.habitsMaxChars, DEFAULT_HABITS_MAX_CHARS);
  const habitEntryMaxChars = numberOr(input.habitEntryMaxChars, DEFAULT_HABIT_ENTRY_MAX_CHARS);
  const credentialsMaxChars = numberOr(
    input.credentialsMaxChars ?? input.longtermMaxChars,
    DEFAULT_CREDENTIALS_MAX_CHARS,
  );
  const entries = Array.isArray(input.projectEntries)
    ? input.projectEntries.filter((text) => typeof text === 'string' && text !== '')
    : [];
  const projectBlock = entries.length > 0 ? entries.map((text) => '- ' + text).join('\n') : '（空）';
  const identity = nonEmptyText(input.identityText) ?? '（空）';
  const habits = Array.isArray(input.habits)
    ? input.habits.filter((text) => typeof text === 'string' && text !== '')
    : [];
  const habitsBlock = habits.length > 0 ? habits.map((text) => '- ' + text).join('\n') : '（空）';
  const credentials = nonEmptyText(input.credentialsText ?? input.longtermText) ?? '（空）';
  const turnText = typeof input.turnText === 'string' ? input.turnText : '';
  return [
    '你是记忆整理员。下面是「当前项目记忆」「当前用户身份」「当前用户习惯」「当前账号密码」和「本回合最新对话」。',
    '任务一（项目记忆）：结合最新对话决定是否新增/修改/合并/删除条目，输出更新后的全量条目列表：',
    `  - 每条 ≤${entryMaxChars} 个字符（按 Unicode 码点计），总数 ≤${projectMaxChars} 个字符；`,
    '  - 只写高信号：决定/约定/待办/红线/关键事实；不写过程、寒暄、工具日志；',
    '  - 按重要性从高到低排列。',
    '任务二（用户身份长期记忆，需要判断/推断）：从最新对话中判断用户稳定的身份信息（职业/角色、常用语言、专业领域等）。例如用户说「我现在在开发插件」，可推断「职业：开发人员」：',
    '  - 只记高置信、长期稳定的信息；不要记录一次性任务或临时状态（例如本轮正在做什么）；',
    '  - 禁止推断健康/政治/宗教等敏感属性；不得包含账号密码；',
    '  - 无变化 → {"action":"none"}；有新增/更正 → {"action":"set","text":"…","reason":"…"}；',
    `  - text 是更新后的全量用户身份，≤${identityMaxChars} 个字符。`,
    '任务三（用户习惯长期记忆）：只记录长期稳定的习惯/偏好（如「要求快、不弹窗」「偏好中文」「先方案后动手」）：',
    '  - 不记一次性要求；',
    `  - 每条 ≤${habitEntryMaxChars} 个字符，总数 ≤${habitsMaxChars} 个字符，去重；`,
    '  - 无变化 → {"action":"none"}；有新增/更正 → {"action":"set","items":["…","…"],"reason":"…"}；items 为更新后的全量习惯列表。',
    '任务四（账号密码长期记忆）：判断最新对话是否包含用户账号/密码/令牌等需要长期保存的信息：',
    '  - 无变化 → {"action":"none"}；有新增/更正 → {"action":"set","text":"…","reason":"…"}；',
    `  - text 是更新后的全量账号密码，≤${credentialsMaxChars} 个字符，格式「服务:账号/密码」多条用「；」分隔；不得包含其它内容。`,
    '任务五（话题差异标记 divergence）：判断本回合最新对话与「当前项目记忆」的关系：',
    '  - 与项目记忆无关的全新话题 → {"status":"new","tag":"≤6个字符的小标签","same":true}；',
    '  - 仍是已标记同一话题的延续 → {"status":"continuing","tag":"同一标签","same":true}；若延续的其实是不同话题 → {"status":"continuing","tag":"","same":false}；',
    '  - 该话题已连续出现三次、可以安心写入项目记忆 → {"status":"commit","tag":"同一标签","same":true}；',
    '  - 对话正常属于项目记忆范围（没有话题差异）→ {"status":"none","tag":"","same":false}。',
    '只输出一行 JSON，不要解释、不要代码围栏：',
    '{"project_memory":["…"],"identity":{"action":"none"},"habits":{"action":"none"},"credentials":{"action":"none"},"divergence":{"status":"none","tag":"","same":false}}',
    '当前项目记忆：',
    projectBlock,
    '当前用户身份：',
    identity,
    '当前用户习惯：',
    habitsBlock,
    '当前账号密码：',
    credentials,
    '最新对话：',
    turnText,
  ].join('\n');
}

/**
 * 解析并校验模型输出。
 *
 * @param {unknown} raw - 模型返回的文本
 * @param {{entryMaxChars?:number, projectMaxChars?:number, identityMaxChars?:number,
 *          habitsMaxChars?:number, habitEntryMaxChars?:number, credentialsMaxChars?:number,
 *          longtermMaxChars?:number, drop?:'head'|'tail'}} [limits]
 * @returns {{ok:true,
 *            project:{entries:string[], chars:number, dropped:number, truncated:number},
 *            identity:{text:string, reason:string}|null,
 *            habits:{items:string[], reason:string}|null,
 *            credentials:{text:string, reason:string}|null,
 *            divergence:{status:'none'|'new'|'continuing'|'commit', tag:string, same:boolean}}
 *          |{ok:false, code:string}}
 */
export function parseAnalysisOutput(raw, limits = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, code: PARSE_ERROR.EMPTY_OUTPUT };
  const jsonText = extractJsonObject(stripCodeFences(raw));
  if (jsonText === null) return { ok: false, code: PARSE_ERROR.NO_JSON };
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, code: PARSE_ERROR.BAD_JSON };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: PARSE_ERROR.BAD_SHAPE };
  }
  if (!Array.isArray(parsed.project_memory)) {
    return { ok: false, code: PARSE_ERROR.BAD_PROJECT_MEMORY };
  }
  const fitted = fitEntries(parsed.project_memory, {
    entryMaxChars: numberOr(limits.entryMaxChars, DEFAULT_ENTRY_MAX_CHARS),
    projectMaxChars: numberOr(limits.projectMaxChars, DEFAULT_PROJECT_MAX_CHARS),
    drop: limits.drop === 'head' ? 'head' : 'tail',
  });
  const habitLimits = {
    habitsMaxChars: numberOr(limits.habitsMaxChars, DEFAULT_HABITS_MAX_CHARS),
    habitEntryMaxChars: numberOr(limits.habitEntryMaxChars, DEFAULT_HABIT_ENTRY_MAX_CHARS),
  };
  return {
    ok: true,
    project: {
      entries: fitted.entries,
      chars: fitted.chars,
      dropped: fitted.dropped,
      truncated: fitted.truncated,
    },
    identity: parseVaultSection(
      parsed.identity,
      numberOr(limits.identityMaxChars, DEFAULT_IDENTITY_MAX_CHARS),
    ),
    habits: parseHabits(parsed.habits, habitLimits),
    credentials: parseVaultSection(
      parsed.credentials ?? parsed.longterm,
      numberOr(
        limits.credentialsMaxChars ?? limits.longtermMaxChars,
        DEFAULT_CREDENTIALS_MAX_CHARS,
      ),
    ),
    divergence: parseDivergence(parsed.divergence),
  };
}

/**
 * 解析长期记忆的一段（identity 或 credentials）：只有合法 set 才返回对象；
 * `none`/缺失/非法一律 null（不写）。text 非空、无换行、≤ max；超限不截断而是拒绝。
 * @param {unknown} value
 * @param {number} [maxChars]
 * @returns {{text:string, reason:string}|null}
 */
export function parseVaultSection(value, maxChars = DEFAULT_VAULT_SECTION_MAX_CHARS) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.action !== 'set') return null;
  const text = sanitizeVaultText(value.text, maxChars);
  if (text === null) return null;
  const reason = typeof value.reason === 'string'
    ? truncateCodePoints(value.reason.replace(/\s+/gu, ' ').trim(), 120)
    : '';
  return { text, reason };
}

/**
 * 解析用户习惯段：只有合法 set 才返回对象；`none`/缺失/非法一律 null（不写）。
 * 逐条 trim/折叠空白、单条截断到 habitEntryMaxChars、去重；总量超 habitsMaxChars 时
 * **整段拒绝**（返回 null，保留旧习惯，避免把列表截断成误导性状态）。
 * @param {unknown} value
 * @param {{habitsMaxChars?:number, habitEntryMaxChars?:number}} [limits]
 * @returns {{items:string[], reason:string}|null}
 */
export function parseHabits(value, limits = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.action !== 'set') return null;
  if (!Array.isArray(value.items)) return null;
  const habitsMaxChars = numberOr(limits.habitsMaxChars, DEFAULT_HABITS_MAX_CHARS);
  const habitEntryMaxChars = numberOr(limits.habitEntryMaxChars, DEFAULT_HABIT_ENTRY_MAX_CHARS);
  const items = [];
  const seen = new Set();
  let total = 0;
  for (const raw of value.items) {
    if (typeof raw !== 'string') continue;
    const normalized = raw.replace(/\s+/gu, ' ').trim();
    if (normalized === '') continue;
    const item = truncateCodePoints(normalized, habitEntryMaxChars);
    if (seen.has(item)) continue;
    seen.add(item);
    items.push(item);
    total += codePointLength(item);
  }
  if (items.length === 0) return null;
  if (total > habitsMaxChars) return null; // 整段拒绝，保留旧习惯
  const reason = typeof value.reason === 'string'
    ? truncateCodePoints(value.reason.replace(/\s+/gu, ' ').trim(), 120)
    : '';
  return { items, reason };
}

/**
 * @deprecated v0.1/v0.2 名称；等价于 parseVaultSection（credentials 段）。
 */
export function parseLongterm(value, maxChars = DEFAULT_VAULT_SECTION_MAX_CHARS) {
  return parseVaultSection(value, maxChars);
}

/**
 * 决定这次是否要更新项目记忆（纯函数，「若模型给空数组且原文非空，保留旧记忆不动」）。
 *
 * @param {string[]} currentEntries - 当前条目文本
 * @param {{entries:string[]}|null|undefined} projectDecision - parseAnalysisOutput().project
 * @returns {string[]|null} null = 不写；数组 = 新的全量条目
 */
export function resolveProjectEntries(currentEntries, projectDecision) {
  const current = Array.isArray(currentEntries) ? currentEntries.filter((text) => typeof text === 'string') : [];
  const next = Array.isArray(projectDecision?.entries) ? projectDecision.entries : [];
  if (next.length === 0) return null; // 空数组（或没有 decision）= 保留旧记忆
  if (next.length === current.length && next.every((text, index) => text === current[index])) return null;
  return next;
}

/** 日志辅助：条目总码点数（不打印内容）。 */
export function entriesLength(entries) {
  if (!Array.isArray(entries)) return 0;
  let total = 0;
  for (const entry of entries) total += codePointLength(entry);
  return total;
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
