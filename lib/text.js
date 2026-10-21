/**
 * text.js — 码点长度、校验、安全截断。
 *
 * 全部按 Unicode 码点计（`Array.from(str).length`），与「每条 ≤30 字 / 总 ≤300 字」
 * 的产品口径一致；避免 JS `.length`（UTF-16 code unit）把 emoji 算成 2。
 *
 * 本模块零依赖、纯函数，可被单测直接 import。
 */

/** 一条项目记忆条目的硬上限（码点），见 config.entryMaxChars。 */
export const DEFAULT_ENTRY_MAX_CHARS = 30;
/** 一个会话项目记忆总量的硬上限（码点），见 config.projectMaxChars。 */
export const DEFAULT_PROJECT_MAX_CHARS = 300;
/** 长期记忆（账号密码明文）总量硬上限（码点），见 config.longtermMaxChars。 */
export const DEFAULT_LONGTERM_MAX_CHARS = 60;
/** 截断时保留的头部码点数（spec §4：头 1500 + 尾部分）。 */
export const DEFAULT_HEAD_CHARS = 1500;

/** 一个字符串的 Unicode 码点长度；非字符串返回 0。 */
export function codePointLength(value) {
  if (typeof value !== 'string' || value === '') return 0;
  return Array.from(value).length;
}

/** 安全截断：最多保留前 max 个码点，绝不断开代理对（surrogate pair）。 */
export function truncateCodePoints(value, max) {
  if (typeof value !== 'string') return '';
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  const points = Array.from(value);
  if (points.length <= limit) return value;
  return points.slice(0, limit).join('');
}

/** 安全截断：最多保留后 max 个码点。 */
export function truncateCodePointsEnd(value, max) {
  if (typeof value !== 'string') return '';
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  const points = Array.from(value);
  if (points.length <= limit) return value;
  return points.slice(points.length - limit).join('');
}

/**
 * 规范化一条项目记忆条目：trim、把任意换行/连续空白折叠为单个空格、去空。
 * 返回 null 表示该条不可用（非字符串或规范化后为空）。
 */
export function normalizeEntryText(value) {
  if (typeof value !== 'string') return null;
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  return collapsed === '' ? null : collapsed;
}

/**
 * 把模型给的项目记忆条目列表变成满足硬约束的条目列表：
 *  - 逐条 trim/去换行/去空/去重，单条截断到 entryMaxChars；
 *  - 合计码点超过 projectMaxChars 时，按 drop 策略丢条目直到不超限
 *    （默认从尾部丢：提示词要求「按重要性从高到低排列」，尾部即最不重要；
 *      spec §4 字面写「从头部丢」但与本条提示词约束矛盾，故做成参数并默认尾部）。
 *
 * @param {unknown[]} entries - 模型输出的原始数组（非字符串项会被跳过）。
 * @param {{entryMaxChars?:number, projectMaxChars?:number, drop?:'head'|'tail'}} [options]
 * @returns {{entries:string[], chars:number, dropped:number, truncated:number}}
 */
export function fitEntries(entries, options = {}) {
  const entryMaxChars = positiveInt(options.entryMaxChars, DEFAULT_ENTRY_MAX_CHARS);
  const projectMaxChars = positiveInt(options.projectMaxChars, DEFAULT_PROJECT_MAX_CHARS);
  const drop = options.drop === 'head' ? 'head' : 'tail';
  const out = [];
  const seen = new Set();
  let truncated = 0;
  if (Array.isArray(entries)) {
    for (const raw of entries) {
      const normalized = normalizeEntryText(raw);
      if (normalized === null) continue;
      const fitted = truncateCodePoints(normalized, entryMaxChars);
      if (codePointLength(fitted) < codePointLength(normalized)) truncated += 1;
      if (seen.has(fitted)) continue;
      seen.add(fitted);
      out.push(fitted);
    }
  }
  let chars = sumEntriesChars(out);
  let dropped = 0;
  while (out.length > 0 && chars > projectMaxChars) {
    if (drop === 'head') out.shift();
    else out.pop();
    dropped += 1;
    chars = sumEntriesChars(out);
  }
  return { entries: out, chars, dropped, truncated };
}

/** 条目数组的码点总量。 */
export function sumEntriesChars(entries) {
  if (!Array.isArray(entries)) return 0;
  let total = 0;
  for (const entry of entries) {
    if (typeof entry === 'string') total += codePointLength(entry);
    else if (entry && typeof entry.text === 'string') total += codePointLength(entry.text);
  }
  return total;
}

/**
 * 校验（不截断）长期记忆明文：必须是非空字符串、无换行/控制字符、码点 ≤ max。
 * 不合法返回 null（调用方视为「无变化」）。明文绝不写日志。
 */
export function sanitizeVaultText(value, max = DEFAULT_LONGTERM_MAX_CHARS) {
  if (typeof value !== 'string') return null;
  if (/[\r\n\t]/u.test(value)) return null;
  // 其余 C0 控制字符同样拒绝。
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return null;
  const text = value.trim();
  if (text === '') return null;
  if (codePointLength(text) > positiveInt(max, DEFAULT_LONGTERM_MAX_CHARS)) return null;
  return text;
}

/**
 * 中间截断：保留头部 headChars + 尾部，总长不超过 maxChars。
 * 用于喂给分析模型的回合文本（spec §4：保留头 1500 + 尾部分）。
 */
export function truncateMiddle(value, maxChars, headChars = DEFAULT_HEAD_CHARS) {
  if (typeof value !== 'string') return '';
  const max = positiveInt(maxChars, 4000);
  if (codePointLength(value) <= max) return value;
  const marker = '\n…（中间内容已截断）…\n';
  const markerLen = codePointLength(marker);
  const head = Math.min(positiveInt(headChars, DEFAULT_HEAD_CHARS), Math.max(0, max - markerLen - 1));
  const tail = max - head - markerLen;
  if (tail <= 0) return truncateCodePoints(value, max);
  return truncateCodePoints(value, head) + marker + truncateCodePointsEnd(value, tail);
}

/** 去掉 Markdown 代码围栏标记（模型偶尔会加 ```json）。 */
export function stripCodeFences(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/```[^\n]*\n?/gu, '');
}

/** 从任意文本里取第一个 `{` 到最后一个 `}`；找不到返回 null。 */
export function extractJsonObject(value) {
  if (typeof value !== 'string') return null;
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return value.slice(start, end + 1);
}

function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
