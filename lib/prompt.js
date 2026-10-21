/**
 * prompt.js — 构造一次后台分析提示词，并程序化解析/校验模型的 JSON 输出。
 *
 * v0.2（task-11 需求 A）：一次调用同时产出三件事 ——
 *  1) project_memory 全量条目（≤30/条、≤300 总）；
 *  2) identity 用户身份（称呼/姓名、职业/角色、语言、邮箱/手机，≤60 码点，
 *     只记用户明确说过的，禁止推断健康/政治/宗教等敏感属性）；
 *  3) credentials 账号密码/令牌（≤60 码点，格式「服务:账号/密码；…」）。
 *
 * 核心信任边界：模型输出一律当不可信数据处理 ——
 *  - 去代码围栏、取第一个 `{` 到最后一个 `}`，JSON.parse 失败即整回合放弃；
 *  - project_memory 必须是数组；逐条 trim/去换行/去空；单条超长截断；总量超限丢条目；
 *  - identity/credentials 的 `action === 'set'` 时 text 必须非空、无换行、≤ 各自预算，
 *    否则视为「无变化」；`none`/缺失/非法一律不写。
 *
 * 本模块零依赖、纯函数，可被单测直接 import。
 */
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

/** 长期记忆每段（identity / credentials）的默认预算（码点）。 */
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
 * 构造分析提示词（v0.2 三段输出）。
 *
 * @param {object} input
 * @param {string[]} [input.projectEntries] - 当前项目记忆条目
 * @param {string} [input.identityText] - 当前用户身份明文（可能为空）
 * @param {string} [input.credentialsText] - 当前账号密码明文（可能为空）
 * @param {string} [input.longtermText] - credentialsText 的兼容别名
 * @param {string} [input.turnText] - 本回合「用户/助手」文本（已截断）
 * @param {number} [input.entryMaxChars]
 * @param {number} [input.projectMaxChars]
 * @param {number} [input.identityMaxChars]
 * @param {number} [input.credentialsMaxChars] - longtermMaxChars 亦兼容
 * @returns {string}
 */
export function buildAnalysisPrompt(input = {}) {
  const entryMaxChars = numberOr(input.entryMaxChars, DEFAULT_ENTRY_MAX_CHARS);
  const projectMaxChars = numberOr(input.projectMaxChars, DEFAULT_PROJECT_MAX_CHARS);
  const identityMaxChars = numberOr(input.identityMaxChars, DEFAULT_VAULT_SECTION_MAX_CHARS);
  const credentialsMaxChars = numberOr(
    input.credentialsMaxChars ?? input.longtermMaxChars,
    DEFAULT_VAULT_SECTION_MAX_CHARS,
  );
  const entries = Array.isArray(input.projectEntries) ? input.projectEntries.filter((text) => typeof text === 'string' && text !== '') : [];
  const projectBlock = entries.length > 0 ? entries.map((text) => '- ' + text).join('\n') : '（空）';
  const identity = nonEmptyText(input.identityText) ?? '（空）';
  const credentials = nonEmptyText(input.credentialsText ?? input.longtermText) ?? '（空）';
  const turnText = typeof input.turnText === 'string' ? input.turnText : '';
  return [
    '你是记忆整理员。下面是「当前项目记忆」「当前用户身份」「当前账号密码」和「本回合最新对话」。',
    '任务一（项目记忆）：结合最新对话决定是否新增/修改/合并/删除条目，输出更新后的全量条目列表：',
    `  - 每条 ≤${entryMaxChars} 个字符（按 Unicode 码点计），总数 ≤${projectMaxChars} 个字符；`,
    '  - 只写高信号：决定/约定/待办/红线/关键事实；不写过程、寒暄、工具日志；',
    '  - 按重要性从高到低排列。',
    '任务二（用户身份长期记忆）：只记录用户在最新对话中「明确说过」的信息：称呼/姓名、职业/角色、常用语言、邮箱/手机（若给出）：',
    '  - 无变化 → {"action":"none"}；有新增/更正 → {"action":"set","text":"…","reason":"…"}；',
    `  - text 是更新后的全量用户身份，≤${identityMaxChars} 个字符；禁止推断健康/政治/宗教等敏感属性；不得包含账号密码。`,
    '任务三（账号密码长期记忆）：判断最新对话是否包含用户账号/密码/令牌等需要长期保存的信息：',
    '  - 无变化 → {"action":"none"}；有新增/更正 → {"action":"set","text":"…","reason":"…"}；',
    `  - text 是更新后的全量账号密码，≤${credentialsMaxChars} 个字符，格式「服务:账号/密码」多条用「；」分隔；不得包含其它内容。`,
    '只输出一行 JSON，不要解释、不要代码围栏：',
    '{"project_memory":["…"],"identity":{"action":"none"},"credentials":{"action":"none"}}',
    '当前项目记忆：',
    projectBlock,
    '当前用户身份：',
    identity,
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
 *          credentialsMaxChars?:number, longtermMaxChars?:number, drop?:'head'|'tail'}} [limits]
 * @returns {{ok:true, project:{entries:string[], chars:number, dropped:number, truncated:number},
 *            identity:{text:string, reason:string}|null,
 *            credentials:{text:string, reason:string}|null}
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
      numberOr(limits.identityMaxChars, DEFAULT_VAULT_SECTION_MAX_CHARS),
    ),
    credentials: parseVaultSection(
      parsed.credentials ?? parsed.longterm,
      numberOr(
        limits.credentialsMaxChars ?? limits.longtermMaxChars,
        DEFAULT_VAULT_SECTION_MAX_CHARS,
      ),
    ),
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
 * @deprecated v0.1 名称；等价于 parseVaultSection（credentials 段）。
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
