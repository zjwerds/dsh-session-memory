/**
 * secrets-patterns.js — 通用凭据形态检测（task-10，R1 最后边界）。
 *
 * 背景：vault 片段过滤只能拦住"真正进过 vault"的密码。若模型把对话里的密码写进
 * project memory 而本回合 `longterm.action === 'none'`（密码从未进 vault），就无片段可过滤。
 * 这里用确定性的形态规则兜底（纯函数、零依赖、可单测）：
 *
 *  A. 关键词上下文：`密码|口令|password|passwd|pwd|secret|token|api[_-]?key|账号密码|用户名密码`
 *     后跟 `[:：=]`（可带空白）或空白，且值 ≥4 码点 → 视为凭据。
 *     例：`密码：abc12345`、`password=xyz12345`、`密码 TestPass123`。
 *  B. 高熵 token：ASCII 字母+数字混合、码点长度 ≥ credentialTokenMinChars（默认 8）的连续
 *     字母数字串（在 `_`、`-`、`.`、中文、空白等非 ASCII 字母数字处分词）→ 视为凭据。
 *     例：`TestPass123`、`NewPass456`、`abc12345`。
 *
 * 保护性排除（不误伤常见项目记忆）：
 *  - 纯数字：`12345678`（无字母 → 高熵不成立；无关键词上下文）；
 *  - 版本号：`v3.2` / `0.2.1-rc.2`（ASCII 词长 <8）；
 *  - 带下划线/中划线标识符：`task_261020_001`、`deepseek-flash`（按 `_`/`-` 分词后各段 <8）；
 *  - 纯中文文本：`验收先跑probe两回合e2e`（中文不是 ASCII token；`probe`/`e2e` 长度不足）；
 *  - 常见英文词：`DeepSeek`(8 字母无数字)、`Harness`(7)、`README.md`(README=6)。
 *
 * 已知误伤边界（见 README）：≥8 位且字母+数字混合的十六进制 hash/提交短号、被关键词
 * 上下文误挂的普通英文值（如 `token: invalid`）会被当作凭据丢弃——安全优先。
 *
 * 本模块零依赖，可被单测直接 import。
 */

/** 高熵 token 的默认最小码点长度。 */
export const DEFAULT_CREDENTIAL_TOKEN_MIN_CHARS = 8;

/** 关键词上下文中的值：至少 4 个非空白/非中文标点码点。 */
const KEYWORD_VALUE = '[^\\s，。；;、,]{4,}';

/** 关键词词表（中英混合；`api key`/`api_key`/`api-key` 都覆盖）。 */
const CREDENTIAL_KEYWORDS = '密码|口令|password|passwd|pwd|secret|token|api[_-]?key|账号密码|用户名密码';

/** 关键词 + `:`/`：`/`=` + 值。 */
const KEYWORD_WITH_SEPARATOR = new RegExp(`(?:${CREDENTIAL_KEYWORDS})\\s*[:：=]\\s*(${KEYWORD_VALUE})`, 'iu');

/** 关键词 + 空白 + 值。 */
const KEYWORD_WITH_SPACE = new RegExp(`(?:${CREDENTIAL_KEYWORDS})\\s+(${KEYWORD_VALUE})`, 'iu');

/** ASCII 字母数字连续串（中文/标点/下划线/中划线/点号都是分词边界）。 */
const ASCII_TOKEN = /[A-Za-z0-9]+/g;

/**
 * 判断一段文本是否"看起来像凭据"。
 *
 * @param {unknown} text
 * @param {{tokenMinChars?:number, keywords?:boolean, highEntropy?:boolean}} [options]
 *   keywords=false 关闭关键词规则；highEntropy=false 关闭高熵 token 规则。
 * @returns {boolean}
 */
export function looksLikeCredential(text, options = {}) {
  if (typeof text !== 'string' || text === '') return false;
  const minChars = positiveInt(options.tokenMinChars, DEFAULT_CREDENTIAL_TOKEN_MIN_CHARS);
  if (options.keywords !== false) {
    KEYWORD_WITH_SEPARATOR.lastIndex = 0;
    KEYWORD_WITH_SPACE.lastIndex = 0;
    if (KEYWORD_WITH_SEPARATOR.test(text)) return true;
    if (KEYWORD_WITH_SPACE.test(text)) return true;
  }
  if (options.highEntropy !== false) {
    ASCII_TOKEN.lastIndex = 0;
    let match;
    while ((match = ASCII_TOKEN.exec(text)) !== null) {
      const token = match[0];
      if (token.length < minChars) continue;
      if (/[A-Za-z]/.test(token) && /[0-9]/.test(token)) return true;
    }
    ASCII_TOKEN.lastIndex = 0;
  }
  return false;
}

/**
 * 过滤凭据形态条目：命中 `looksLikeCredential` 的丢弃。
 * 条目可以是字符串，也可以是 `{ text }` 对象；保留原始形状。
 *
 * @param {unknown[]} entries
 * @param {{enabled?:boolean, tokenMinChars?:number}} [options]
 * @returns {{entries: unknown[], removed: number}}
 */
export function filterEntriesByCredentialPatterns(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (options.enabled === false) return { entries: [...list], removed: 0 };
  const tokenMinChars = positiveInt(options.tokenMinChars, DEFAULT_CREDENTIAL_TOKEN_MIN_CHARS);
  const kept = [];
  let removed = 0;
  for (const entry of list) {
    let text = null;
    if (typeof entry === 'string') text = entry;
    else if (entry !== null && typeof entry === 'object' && typeof entry.text === 'string') text = entry.text;
    if (text === null) continue;
    if (looksLikeCredential(text, { tokenMinChars })) {
      removed += 1;
      continue;
    }
    kept.push(entry);
  }
  return { entries: kept, removed };
}

function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
