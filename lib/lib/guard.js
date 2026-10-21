/**
 * guard.js — 秘密片段切分 + `ctx.tools.guard` 分级外泄拦截 + project memory 过滤
 * （spec-impl.md §8；task-8 R1/R2；task-11 v0.2 分级）。
 *
 * v0.2 分级（不再"卡死"）：
 *  - secret 集合 = vault 的 identity + credentials 片段/整串（含 history 的 prev/next）；
 *  - `guardMode: 'balanced'`（默认）：只有「网络/对外」工具（web_fetch/web_search/
 *    subagent/subagent_fork/workflow/a2a_send/mcp* 前缀…）参数含秘密才拦截；
 *    `web_fetch` 的 URL 域名全部 ∈ trustedDomains 时放行；本地工具（pwsh/write/edit/
 *    read/glob/grep/skill/present/todo/ask_user…）一律放行（用户可能正需要密码）；
 *  - `guardMode: 'strict'`：v0.1 旧行为 —— 任何非自有工具参数含秘密即拒；
 *  - `guardMode: 'off'`：不拦；
 *  - 拒绝理由永不包含秘密；`vault_read` / `session_memory_read` 永远放行。
 *
 * 片段规则（task-8 R2）：
 *  - 整串永远保留；其余按 `[:/\\；;，,、=|\s]+` 切分，码点 <6 的短段丢弃
 *    （避免 `admin`、`C:\Users\...` 这类路径词误伤）；`testuser`/`TestPass123`
 *    这种单独出现的账号/密码子串也会被匹配。
 *
 * 注意：guard 是同步回调（ToolGuard 返回 string|undefined），vault 明文来自
 * MemoryStore 的内存快照，不能在这里读盘。
 *
 * 本模块零依赖、纯函数（getVaultText(s) 注入），可被单测直接 import。
 */
import { codePointLength } from './text.js';

/** strict 模式拒绝理由（不含任何秘密内容；v0.1 兼容文案）。 */
export const GUARD_DENY_REASON = '拒绝：工具参数包含长期记忆中的敏感内容，禁止外泄';
/** strict 模式拒绝理由别名。 */
export const GUARD_DENY_REASON_STRICT = GUARD_DENY_REASON;
/** balanced 模式拒绝理由（只针对网络/对外工具；不含秘密）。 */
export const GUARD_DENY_REASON_NETWORK = '拒绝：禁止把长期记忆内容发往外部网站/其它 agent';

/**
 * 秘密片段的最小码点长度：
 * task-8 R2 从 4 提到 6 —— `admin`(5)、`root`(4)、`svc` 等路径/服务词不再误伤；
 * `testuser`(8)、`TestPass123`(11) 这类账号/密码子串仍会被拦截。
 */
export const SECRET_FRAGMENT_MIN_CHARS = 6;

/** 片段分隔符：中英文冒号/斜杠/反斜杠/中英文标点/等号/竖线/空白（含全角空格）。 */
const SECRET_FRAGMENT_DELIMITERS = /[:：\\/；;，,、=|\s]+/u;

/** 参数文本收集的遍历预算（防御超大工具参数；不影响正确性）。 */
const SCAN_MAX_DEPTH = 32;
const SCAN_MAX_CHARS = 2_000_000;

/** balanced 模式下视为「网络/对外」的工具名（小写精确匹配）。 */
export const NETWORK_TOOL_NAMES = Object.freeze([
  'web_fetch',
  'web_search',
  'subagent',
  'subagent_fork',
  'workflow',
  'a2a_send',
  'a2a_dispatch',
]);

/** 永远放行的自有工具（只读记忆，不对外发）。 */
export const DEFAULT_ALLOW_TOOLS = Object.freeze(['vault_read', 'session_memory_read']);

/**
 * 把一段 vault 明文拆成候选秘密片段：整串 + 按扩展分隔符切分后的各段。
 * 整串无条件保留；切分片段 trim 后码点 ≥ minChars 才保留。
 * @param {string} vaultText
 * @param {number} [minChars]
 * @returns {string[]}
 */
export function splitSecretFragments(vaultText, minChars = SECRET_FRAGMENT_MIN_CHARS) {
  if (typeof vaultText !== 'string') return [];
  const whole = vaultText.trim();
  if (whole === '') return [];
  const minimum = Number.isFinite(minChars) ? Math.max(1, Math.floor(minChars)) : SECRET_FRAGMENT_MIN_CHARS;
  const fragments = new Set([whole]);
  for (const candidate of whole.split(SECRET_FRAGMENT_DELIMITERS)) {
    const fragment = candidate.trim();
    if (fragment !== '' && codePointLength(fragment) >= minimum) fragments.add(fragment);
  }
  return [...fragments];
}

/**
 * 汇总多段 vault 明文（identity + credentials + history prev/next）的片段并集。
 * @param {string[]|string|null|undefined} vaultTexts
 * @param {{minChars?:number}} [options]
 * @returns {string[]}
 */
export function collectVaultSecretFragments(vaultTexts, options = {}) {
  const list = Array.isArray(vaultTexts) ? vaultTexts : typeof vaultTexts === 'string' ? [vaultTexts] : [];
  const minChars = options.minChars ?? SECRET_FRAGMENT_MIN_CHARS;
  const fragments = new Set();
  for (const text of list) {
    for (const fragment of splitSecretFragments(text, minChars)) fragments.add(fragment);
  }
  return [...fragments];
}

/**
 * identity 片段的最小码点长度（task-12）：身份里的称呼/姓名（`王工`/`小王`）只有 2 码点、
 * 职业（`前端工程师`）5 码点；若沿用 credentials 的 ≥6 阈值，这些片段都进不了秘密集合，
 * identity 一旦被写进 project memory 就会漏过滤/漏注入。故 identity 单独用 ≥2。
 */
export const IDENTITY_FRAGMENT_MIN_CHARS = 2;

/** identity 的字段标签词：不是秘密，避免 2 码点阈值把「称呼/职业」这类普通词当片段。 */
const IDENTITY_LABEL_PATTERN = /^(?:(?:用户|我的|个人)(?:称呼|姓名|名字|昵称|职业|角色|职位|岗位|语言|常用语言|母语|邮箱|电子邮件|手机|手机号|电话|联系方式|身份)|(?:称呼|姓名|名字|昵称|职业|角色|职位|岗位|语言|常用语言|母语|邮箱|电子邮件|手机|手机号|电话|联系方式|身份)|(?:name|nickname|role|job|title|occupation|language|lang|email|mail|phone|tel|mobile|identity))$/iu;

/** identity 片段分隔符：在 credentials 分隔符基础上补括号类，便于拆出「小王（前端工程师）」。 */
const IDENTITY_FRAGMENT_DELIMITERS = /[:：\\/；;，,、=|\s（）()「」【】\[\]{}]+/u;

/**
 * 把一段 identity 明文拆成片段：整串 + 按分隔符切分后 ≥2 码点的子串；字段标签词不参与。
 * 这样 identity=`称呼：王工；职业：前端工程师` 会得到整串 + `王工` + `前端工程师`，
 * 能拦住「王工」这类短条目引用（task-12 e2e FAIL-1）。
 * @param {string} identityText
 * @param {{minChars?:number}} [options]
 * @returns {string[]}
 */
export function splitIdentityFragments(identityText, options = {}) {
  if (typeof identityText !== 'string') return [];
  const whole = identityText.trim();
  if (whole === '') return [];
  const minChars = Number.isFinite(options.minChars)
    ? Math.max(1, Math.floor(options.minChars))
    : IDENTITY_FRAGMENT_MIN_CHARS;
  const fragments = new Set([whole]);
  for (const candidate of whole.split(IDENTITY_FRAGMENT_DELIMITERS)) {
    const fragment = candidate.trim();
    if (fragment === '' || IDENTITY_LABEL_PATTERN.test(fragment)) continue;
    if (codePointLength(fragment) >= minChars) fragments.add(fragment);
  }
  return [...fragments];
}

/** 汇总多段 identity 明文的片段并集（当前 identity + history 旧 identity）。 */
export function collectIdentitySecretFragments(identityTexts, options = {}) {
  const list = Array.isArray(identityTexts) ? identityTexts : typeof identityTexts === 'string' ? [identityTexts] : [];
  const fragments = new Set();
  for (const text of list) {
    for (const fragment of splitIdentityFragments(text, options)) fragments.add(fragment);
  }
  return [...fragments];
}

/**
 * 项目记忆/注入/guard 用的合并秘密片段：
 *  - identity 段：≥2 码点（去掉字段标签词）；
 *  - credentials 段：沿用 ≥6 码点（防路径/admin 等误伤）。
 * @param {string[]|undefined} identityTexts
 * @param {string[]|undefined} credentialTexts
 * @returns {string[]}
 */
export function collectCombinedSecretFragments(identityTexts, credentialTexts) {
  const fragments = new Set();
  for (const fragment of collectIdentitySecretFragments(identityTexts)) fragments.add(fragment);
  for (const fragment of collectVaultSecretFragments(credentialTexts)) fragments.add(fragment);
  return [...fragments];
}

/** 文本是否包含任一秘密片段。 */
export function containsSecretFragment(text, fragments) {
  if (typeof text !== 'string' || !Array.isArray(fragments)) return false;
  for (const fragment of fragments) {
    if (typeof fragment === 'string' && fragment !== '' && text.includes(fragment)) return true;
  }
  return false;
}

/**
 * 过滤含秘密片段的条目（R1）：返回保留下来的条目与丢弃数量。
 * 条目可以是字符串，也可以是 `{ text }` 对象；保留原始形状。
 * @param {unknown[]} entries
 * @param {string[]} fragments
 * @returns {{entries: unknown[], removed: number}}
 */
export function filterEntriesBySecrets(entries, fragments) {
  const list = Array.isArray(entries) ? entries : [];
  const kept = [];
  let removed = 0;
  for (const entry of list) {
    let text = null;
    if (typeof entry === 'string') text = entry;
    else if (entry !== null && typeof entry === 'object' && typeof entry.text === 'string') text = entry.text;
    if (text === null) continue;
    if (containsSecretFragment(text, fragments)) {
      removed += 1;
      continue;
    }
    kept.push(entry);
  }
  return { entries: kept, removed };
}

/**
 * 序列化一次工具调用的参数：优先 `execution.arguments`（ToolExecution.d.ts），
 * 并额外递归收集其中的字符串（避免 JSON 转义让明文匹配失效）。
 * @param {object|null|undefined} execution
 * @returns {string}
 */
export function serializeToolArguments(execution) {
  if (execution === null || typeof execution !== 'object') return '';
  const args = execution.arguments;
  const parts = [];
  if (typeof args === 'string') {
    parts.push(args);
    return args;
  }
  try {
    const serialized = JSON.stringify(args);
    if (typeof serialized === 'string') parts.push(serialized);
  } catch {
    // 参数理论上必可 JSON 序列化；异常时退回字符串遍历。
  }
  const collected = [];
  collectStrings(args, collected, SCAN_MAX_CHARS, 0);
  if (collected.length > 0) parts.push(collected.join('\n'));
  return parts.join('\n');
}

function collectStrings(value, out, budget, depth) {
  if (budget <= 0 || depth > SCAN_MAX_DEPTH) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, budget - 1, depth + 1);
    return;
  }
  if (value !== null && typeof value === 'object') {
    let keys = 0;
    for (const key of Object.keys(value)) {
      if (keys++ > 256) break;
      out.push(key);
      collectStrings(value[key], out, budget - 1, depth + 1);
    }
  }
}

/**
 * 参数文本的"解码后"变体（task-13：防止 percent-encoding / 字面 unicode 转义绕过
 * 字面片段匹配）。覆盖：
 *  - `%E7%8E%8B`（encodeURIComponent / decodeURIComponent；含双编码，最多 3 轮）；
 *  - `%u738B`（旧 unescape 风格）；
 *  - `\u738b`（JSON/JS 字面 unicode 转义）。
 * 返回去重后的变体列表（不含原文）；解码失败时按连续 %XX 段保守解码。
 * @param {string} text
 * @returns {string[]}
 */
export function decodeArgumentEncodingVariants(text) {
  if (typeof text !== 'string' || text === '') return [];
  const variants = new Set();
  let current = text;
  for (let round = 0; round < 3; round += 1) {
    let next = current
      .replace(/%u([0-9A-Fa-f]{4})/gu, (match, hex) => codePointFromHex(hex, match))
      .replace(/\\u([0-9A-Fa-f]{4})/gu, (match, hex) => codePointFromHex(hex, match));
    if (/%[0-9A-Fa-f]{2}/u.test(next)) {
      try {
        next = decodeURIComponent(next);
      } catch {
        next = next.replace(/(?:%[0-9A-Fa-f]{2})+/gu, (run) => {
          try {
            return decodeURIComponent(run);
          } catch {
            return run;
          }
        });
      }
    }
    if (next === current) break;
    variants.add(next);
    current = next;
  }
  // `+` 在 URL query / form 语义里代表空格；补一个把 + 当空格解码的变体（lead task-15）。
  for (const variant of [...variants, text]) {
    if (variant.includes('+')) variants.add(variant.replace(/\+/gu, ' '));
  }
  variants.delete(text);
  return [...variants];
}

function codePointFromHex(hex, fallback) {
  try {
    const codePoint = Number.parseInt(hex, 16);
    if (Number.isNaN(codePoint)) return fallback;
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

/** 用原文 + 解码变体一起扫描片段（原文优先）。 */
function argumentTextsForScan(argumentText) {
  return [argumentText, ...decodeArgumentEncodingVariants(argumentText)];
}

/**
 * 工具是否属于「网络/对外」（balanced 模式下才检查）。
 * - 精确名单：web_fetch/web_search/subagent/subagent_fork/workflow/a2a_send/a2a_dispatch；
 * - 前缀：`mcp`（mcp / mcp__fs / mcp-tool 等 MCP 工具）。
 * @param {unknown} name
 * @returns {boolean}
 */
export function isNetworkTool(name) {
  if (typeof name !== 'string') return false;
  const normalized = name.trim().toLowerCase();
  if (normalized === '') return false;
  if (NETWORK_TOOL_NAMES.includes(normalized)) return true;
  return normalized.startsWith('mcp');
}

/**
 * 归一化 web_fetch 的 URL 文本（task-15）：percent-encoding 解码（最多 2 轮），
 * 避免 `ex%61mple.com` / `example.com%2eevil.com` 这类编码 host 绕过 trustedDomains 判定。
 * @param {unknown} urlValue
 * @returns {string}
 */
export function normalizeUrlForTrust(urlValue) {
  if (typeof urlValue !== 'string') return '';
  let current = urlValue.trim();
  for (let round = 0; round < 2; round += 1) {
    const before = current;
    try {
      current = decodeURIComponent(current);
    } catch {
      // 非法 % 序列：保留原样（不加解码变体），继续用当前串判断。
    }
    if (current === before) break;
  }
  return current;
}

/** 从参数里取出 web_fetch 的目标 URL（支持 url / urls；返回归一后的串）。 */
export function extractFetchUrls(args) {
  const value = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const urls = [];
  const push = (candidate) => {
    if (typeof candidate !== 'string' || candidate.trim() === '') return;
    urls.push(normalizeUrlForTrust(candidate));
  };
  push(value.url);
  if (Array.isArray(value.urls)) {
    for (const item of value.urls) push(item);
  }
  return urls;
}

function normalizeDomains(domains) {
  if (!Array.isArray(domains)) return [];
  const out = new Set();
  for (const raw of domains) {
    if (typeof raw !== 'string') continue;
    const normalized = raw.trim().toLowerCase().replace(/^\.+|\.+$/gu, '');
    if (normalized !== '') out.add(normalized);
  }
  return [...out];
}

/**
 * 判断一个 URL 是否命中白名单域名（精确或子域）。
 * @param {string} urlValue
 * @param {string[]} trustedDomains
 * @returns {boolean}
 */
export function isTrustedUrl(urlValue, trustedDomains) {
  const domains = normalizeDomains(trustedDomains);
  if (domains.length === 0 || typeof urlValue !== 'string' || urlValue.trim() === '') return false;
  const normalized = normalizeUrlForTrust(urlValue);
  const candidate = normalized.includes('://') ? normalized : `https://${normalized}`;
  let hostname;
  try {
    hostname = new URL(candidate).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

/**
 * 构造 ToolGuard。
 *
 * @param {object} options
 * @param {() => string[]} [options.getVaultFragments] - 同步取合并秘密片段（identity ≥2 + credentials ≥6）
 * @param {() => string[]} [options.getVaultTexts] - 兼容：取全部 vault 明文（按 credentials ≥6 阈值切）
 * @param {() => string} [options.getVaultText] - 兼容旧接口：只取一段
 * @param {'balanced'|'strict'|'off'} [options.guardMode] - 默认 balanced
 * @param {string[]} [options.trustedDomains] - balanced 下 web_fetch 白名单
 * @param {string[]} [options.allowTools] - 永远放行的工具名（默认 vault_read/session_memory_read）
 * @returns {(execution: Readonly<object>) => string|undefined}
 */
export function makeGuard(options = {}) {
  const mode = options.guardMode === 'strict' || options.guardMode === 'off' ? options.guardMode : 'balanced';
  const allowTools = new Set(
    Array.isArray(options.allowTools) && options.allowTools.length > 0
      ? options.allowTools
      : DEFAULT_ALLOW_TOOLS,
  );
  const trustedDomains = normalizeDomains(options.trustedDomains);
  const getVaultTexts = typeof options.getVaultTexts === 'function'
    ? options.getVaultTexts
    : typeof options.getVaultText === 'function'
      ? () => [options.getVaultText()]
      : () => [];
  // task-12：优先用调用方注入的合并片段（identity 用 ≥2 阈值）；否则退回旧阈值切分。
  const getVaultFragments = typeof options.getVaultFragments === 'function'
    ? options.getVaultFragments
    : () => collectVaultSecretFragments(getVaultTexts());
  return function guard(execution) {
    try {
      if (mode === 'off') return undefined;
      const name = typeof execution?.name === 'string' ? execution.name : '';
      if (name !== '' && allowTools.has(name)) return undefined;

      // strict：旧行为 —— 任何非自有工具参数含秘密即拒。
      if (mode === 'strict') {
        const fragments = getVaultFragments();
        if (fragments.length === 0) return undefined;
        const argumentText = serializeToolArguments(execution);
        if (argumentText === '') return undefined;
        const scanTexts = argumentTextsForScan(argumentText);
        return fragments.some((fragment) => scanTexts.some((text) => text.includes(fragment)))
          ? GUARD_DENY_REASON_STRICT
          : undefined;
      }

      // balanced：本地工具一律放行；只有网络/对外工具才检查。
      if (!isNetworkTool(name)) return undefined;
      const fragments = getVaultFragments();
      if (fragments.length === 0) return undefined;
      const argumentText = serializeToolArguments(execution);
      if (argumentText === '') return undefined;
      // task-13：原文 + percent-encoding / unicode 转义解码文本一起扫，防编码绕过。
      const scanTexts = argumentTextsForScan(argumentText);
      const hasSecret = fragments.some((fragment) => scanTexts.some((text) => text.includes(fragment)));
      if (!hasSecret) return undefined;

      // web_fetch：域名全部可信才放行，其余网络工具默认拒绝。
      if (name.trim().toLowerCase() === 'web_fetch') {
        const urls = extractFetchUrls(execution?.arguments);
        if (urls.length > 0 && urls.every((url) => isTrustedUrl(url, trustedDomains))) return undefined;
      }
      return GUARD_DENY_REASON_NETWORK;
    } catch {
      // guard 绝不能因为自身异常打断工具流水线；异常按放行处理。
      return undefined;
    }
  };
}
