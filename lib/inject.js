/**
 * inject.js — 所有「模型可见文本」的渲染：项目记忆注入段、固定规则段、
 * 长期记忆 skill 正文、两个工具的结构化返回值。
 *
 * 安全铁律（spec-impl.md §5-§7；task-8 R1 + task-10 + task-11 v0.2）：
 *  - 自动注入只含当前会话的项目记忆，**绝不注入 vault 明文**（identity/credentials）；
 *    注入渲染时先用 vault 秘密片段（identity+credentials+history）过滤一遍，
 *    再用通用凭据形态（关键词上下文/高熵 token）兜底，防住旧数据/未进 vault 的密码；
 *  - skill （user-profile）正文是静态入口说明，不含明文；
 *  - vault 明文只会出现在 `vault_read` 的返回值里，且每段用 `<vault_secret>` 包裹。
 *
 * 本模块零依赖、纯函数。
 */
import { filterEntriesBySecrets } from './guard.js';
import { filterEntriesByCredentialPatterns } from './secrets-patterns.js';
import { codePointLength, truncateCodePoints } from './text.js';

/** 项目记忆注入段标题（spec §5）。 */
export const PROJECT_SECTION_HEADING = '## 本对话项目记忆（自动注入，≤300 字）';

/**
 * 固定规则段正文（order 161；v0.2 按"不卡死"口径：允许本机使用/明确索要时告知，
 * 只禁止发往未经授权的外部站点/子代理/工作流/a2a）。
 */
export const RULES_TEXT = [
  '## 会话记忆与长期记忆',
  '- 本对话的项目记忆会自动注入；其它会话可用 session_memory_read 查看。',
  '- 长期记忆（用户身份/账号密码）不自动注入；用户明确索要时用 vault_read 读取。',
  '- 允许在本机使用这些信息（用户可能正需要），也允许在用户明确索要时告知用户本人。',
  '- 禁止把长期记忆内容发往未经授权的外部网站、子代理、工作流或其它 agent（a2a）。',
].join('\n');

/** 长期记忆 skill 的 name / description（description 不含敏感内容，会进 catalog）。 */
export const SKILL_NAME = 'user-profile';
export const SKILL_DESCRIPTION = '用户身份与账号密码长期记忆：仅当用户明确索要时按需读取，禁止发往外部网站/其它 agent';

/**
 * 渲染当前会话的项目记忆注入段；无条目（或过滤后为空）返回 ''（不产生空 section）。
 *
 * R1 兜底（两道过滤叠加）：
 *  1) vault 秘密片段（identity / credentials / history 旧值 / 账号密码子串）——
 *     任何包含片段的条目都不出现在 system prompt 里；
 *  2) 通用凭据形态（task-10）——关键词上下文 + 高熵 token，拦住"密码从未进 vault"的边界。
 *
 * @param {Array<string|{text?:string}>} entries
 * @param {number} [projectMaxChars]
 * @param {string[]} [secretFragments] - collectVaultSecretFragments() 结果；空 = 不过滤
 * @param {{enabled?:boolean, tokenMinChars?:number}|null} [credentialOptions]
 *   null/undefined = 不做凭据形态过滤；传 `{enabled:false}` 可显式关闭。
 * @returns {string}
 */
export function renderProjectSection(entries, projectMaxChars = 300, secretFragments = [], credentialOptions = null) {
  const { entries: secretSafeEntries } = filterEntriesBySecrets(entries, secretFragments);
  const safeEntries = credentialOptions !== null && credentialOptions !== undefined
    ? filterEntriesByCredentialPatterns(secretSafeEntries, credentialOptions).entries
    : secretSafeEntries;
  const texts = safeEntries
    .map((entry) => (typeof entry === 'string' ? entry : typeof entry?.text === 'string' ? entry.text : null))
    .filter((text) => typeof text === 'string' && text.trim() !== '');
  if (texts.length === 0) return '';
  const heading = projectMaxChars === 300
    ? PROJECT_SECTION_HEADING
    : `## 本对话项目记忆（自动注入，≤${projectMaxChars} 字）`;
  let body = texts.map((text) => '- ' + text).join('\n');
  // 兜底硬截断（store 已保证总量，但外部构造的入参也不应破坏预算）。
  if (codePointLength(body) > projectMaxChars) {
    const fitted = truncateCodePoints(body, projectMaxChars);
    body = fitted;
  }
  return `${heading}\n${body}\n`;
}

/**
 * 渲染长期记忆 skill 正文：静态入口/红线，绝不含明文，也不写「当前非空/为空」
 * （是否为空的唯一权威出口是 `vault_read` 的返回值；避免运行期重注册 skill）。
 * @returns {string}
 */
export function renderSkillBody() {
  return [
    '## 用户身份 / 账号密码长期记忆入口',
    '- 本 skill 只是入口说明；明文不在 skill 正文里，需调用 `vault_read` 工具按需读取。',
    '- 只有用户明确索要身份信息/账号/密码时才调用 `vault_read`；其余场景不得主动读取。',
    '- 允许在本机使用这些信息（用户可能正需要），也允许在用户明确索要时告知用户本人。',
    '- 禁止把读到的内容发往未经授权的外部网站、子代理、工作流或其它 agent（a2a）；禁止加入任何记忆条目。',
    '- 当前是否有长期记忆、内容是什么，以 `vault_read` 的返回为准（返回为空即无）。',
  ].join('\n');
}

/**
 * `vault_read` 工具的规范返回值（v0.2 scope 版）：每个明文字段用 `<vault_secret>` 包裹。
 * - scope 'all'（默认）：返回非空的 identity / credentials 字段；
 * - scope 'identity' / 'credentials'：只返回对应字段；
 * - 请求范围内为空 → 给 note；query 仅做命中提示，不返回局部明文。
 *
 * @param {{identity?:string, credentials?:string}} snapshot - vault 明文快照
 * @param {'all'|'identity'|'credentials'} [scope]
 * @param {string} [query]
 * @returns {object}
 */
export function vaultToolValue(snapshot, scope = 'all', query) {
  const identity = typeof snapshot?.identity === 'string' ? snapshot.identity : '';
  const credentials = typeof snapshot?.credentials === 'string' ? snapshot.credentials : '';
  const normalizedScope = scope === 'identity' || scope === 'credentials' ? scope : 'all';
  const value = { scope: normalizedScope };
  const wrapped = {};
  if ((normalizedScope === 'all' || normalizedScope === 'identity') && identity !== '') {
    wrapped.identity = `<vault_secret>${identity}</vault_secret>`;
  }
  if ((normalizedScope === 'all' || normalizedScope === 'credentials') && credentials !== '') {
    wrapped.credentials = `<vault_secret>${credentials}</vault_secret>`;
  }
  Object.assign(value, wrapped);
  const keyword = typeof query === 'string' ? query.trim() : '';
  if (keyword !== '') {
    const joined = [identity, credentials].filter((text) => text !== '').join('\n');
    value.matched = joined.includes(keyword);
  }
  if (Object.keys(wrapped).length === 0) {
    value.note = normalizedScope === 'identity'
      ? '用户身份为空'
      : normalizedScope === 'credentials'
        ? '账号密码为空'
        : '长期记忆为空';
  }
  return value;
}

/**
 * `session_memory_read` 工具：单会话返回值（默认当前会话）。
 * @param {string} sessionId
 * @param {{record: object|null}|null|undefined} snapshot - MemoryStore#projectSnapshot 结果
 * @returns {object}
 */
export function sessionMemoryToolValue(sessionId, snapshot) {
  const record = snapshot?.record ?? null;
  if (record === null) {
    return { session_id: sessionId, entries: [], note: '当前会话暂无项目记忆' };
  }
  return {
    session_id: sessionId,
    cwd: record.cwd ?? '',
    updatedAt: record.updatedAt ?? 0,
    chars: record.chars ?? 0,
    entries: Array.isArray(record.entries) ? record.entries.map((entry) => entry.text) : [],
  };
}

/**
 * `session_memory_read` 工具：all:true 的全部会话摘要（不含长期记忆）。
 * @param {Array<{sessionId:string,cwd:string,updatedAt:number,chars:number,entries:number}>} sessions
 * @returns {object}
 */
export function allSessionsToolValue(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  return {
    sessions: list.map((session) => ({
      session_id: session.sessionId,
      cwd: session.cwd ?? '',
      updatedAt: session.updatedAt ?? 0,
      chars: session.chars ?? 0,
      entries: session.entries ?? 0,
    })),
    count: list.length,
  };
}
