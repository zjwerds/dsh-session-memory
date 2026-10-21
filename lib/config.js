/**
 * config.js — 插件配置的默认值与合并（全部字段可缺省）。
 *
 * 语料口径见 spec-impl.md §2。这里不引入任何 schema 库：cordis 把 patch 行里的
 * `config:` 原样传给 apply(ctx, config)，本模块只做防御性归一化。
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** 默认配置（spec-impl.md §2）。 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 空 = $DSH_HOME/memory；非空按绝对/相对路径解析。 */
  dataDir: '',
  /** 空 = 用会话自己的路由（session.requestHeader()?.config），再缺省默认值。 */
  provider: '',
  model: '',
  /** 单对话项目记忆总上限（码点）。 */
  projectMaxChars: 300,
  /** 单条项目记忆上限（码点）。 */
  entryMaxChars: 30,
  /** 长期记忆「用户身份」段上限（码点，v0.2）。 */
  identityMaxChars: 60,
  /** 长期记忆「账号密码」段上限（码点，v0.2）。 */
  credentialsMaxChars: 60,
  /** @deprecated credentialsMaxChars 的兼容别名（仍然生效）。 */
  longtermMaxChars: 60,
  /**
   * 防泄漏 guard 分级（v0.2）：
   *  - 'balanced'（默认）：只拦「网络/对外」工具（web_fetch/web_search/subagent/workflow/
   *    a2a_send/mcp* 等）；本地工具（pwsh/write/edit/...）一律放行——用户可能正需要密码；
   *  - 'strict'：任何非自有工具参数含秘密即拒（v0.1 旧行为）；
   *  - 'off'：不拦。
   */
  guardMode: 'balanced',
  /** web_fetch 白名单域名（balanced 下 URL 域名全部命中才放行）。 */
  trustedDomains: [],
  /** @deprecated 兼容旧配置：false → guardMode 'off'；建议直接用 guardMode。 */
  guardEnabled: true,
  /** 后台分析 LLM 调用超时（毫秒）。 */
  timeoutMs: 25000,
  /** 喂给分析模型的回合文本上限（码点）。 */
  maxInputChars: 4000,
  /**
   * 后台分析的推理强度（GenerateOptions.reasoningEffort）。
   * 默认 'off'：deepseek-flash 默认 effort=high（thinking 开启），400 maxTokens
   * 会被 thinking_delta 吃光、textChars=0 + stop=max_tokens → 解析失败。
   * null / '' 表示不传该字段（换用其它模型的逃生口）；非空字符串原样透传。
   */
  analysisReasoningEffort: 'off',
  /**
   * 通用凭据形态检测（task-10 R1 边界）：密码出现在对话里但本回合没进 vault 时，
   * 写 project memory / 注入前用它按「关键词上下文 + 高熵 token」兜底过滤。
   */
  credentialPatternGuard: true,
  /** 高熵 token（字母+数字混合）视为凭据的最小码点长度。 */
  credentialTokenMinChars: 8,
  /** 只允许打印长度/耗时/错误码；debug=false 时 debug 行全部静默。 */
  debug: false,
});

/** 会话路由的最终缺省值（spec-impl.md §2）。 */
export const DEFAULT_ROUTE = Object.freeze({ provider: 'deepseek-official', model: 'deepseek-flash' });

/**
 * 解析 $DSH_HOME：未设置/空白 → ~/.dsh；相对路径按进程 cwd 解析（与 DSH 一致）。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [fallbackHome]
 */
export function resolveDshHome(env = process.env, fallbackHome = homedir()) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (configured === '') return join(fallbackHome, '.dsh');
  return isAbsolute(configured) ? configured : resolve(configured);
}

/**
 * 数据目录：config.dataDir 优先；空则 $DSH_HOME/memory（spec-impl.md §2/§3）。
 * @param {object} config - 已归一化或原始配置
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveDataDir(config = {}, env = process.env) {
  const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : '';
  if (configured !== '') return isAbsolute(configured) ? configured : resolve(configured);
  return join(resolveDshHome(env), 'memory');
}

/**
 * 归一化用户配置：未知字段丢弃，数值做上下界收敛，字符串 trim。
 * @param {unknown} raw
 * @returns {typeof DEFAULT_CONFIG & {trustedDomains: string[]}}
 */
export function resolveConfig(raw) {
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const credentialsMaxChars = intAtLeast(
    value.credentialsMaxChars ?? value.longtermMaxChars,
    DEFAULT_CONFIG.credentialsMaxChars,
    1,
  );
  const guardMode = normalizeGuardMode(value.guardMode, value.guardEnabled);
  return {
    dataDir: stringOr(value.dataDir, ''),
    provider: stringOr(value.provider, ''),
    model: stringOr(value.model, ''),
    projectMaxChars: intAtLeast(value.projectMaxChars, DEFAULT_CONFIG.projectMaxChars, 1),
    entryMaxChars: intAtLeast(value.entryMaxChars, DEFAULT_CONFIG.entryMaxChars, 1),
    identityMaxChars: intAtLeast(value.identityMaxChars, DEFAULT_CONFIG.identityMaxChars, 1),
    credentialsMaxChars,
    longtermMaxChars: credentialsMaxChars,
    guardMode,
    trustedDomains: normalizeTrustedDomains(value.trustedDomains),
    guardEnabled: guardMode !== 'off',
    timeoutMs: intAtLeast(value.timeoutMs, DEFAULT_CONFIG.timeoutMs, 1000),
    maxInputChars: intAtLeast(value.maxInputChars, DEFAULT_CONFIG.maxInputChars, 200),
    analysisReasoningEffort: normalizeReasoningEffort(value.analysisReasoningEffort),
    credentialPatternGuard: value.credentialPatternGuard === undefined
      ? DEFAULT_CONFIG.credentialPatternGuard
      : value.credentialPatternGuard !== false,
    credentialTokenMinChars: intAtLeast(
      value.credentialTokenMinChars,
      DEFAULT_CONFIG.credentialTokenMinChars,
      4,
    ),
    debug: value.debug === true,
  };
}

/**
 * 归一化 guardMode；兼容旧 guardEnabled:false（→ off）与旧 guardTools（忽略）。
 * @param {unknown} mode
 * @param {unknown} guardEnabled
 * @returns {'balanced'|'strict'|'off'}
 */
function normalizeGuardMode(mode, guardEnabled) {
  if (mode === 'strict' || mode === 'off') return mode;
  if (mode === 'balanced') return 'balanced';
  if (guardEnabled === false) return 'off';
  return DEFAULT_CONFIG.guardMode;
}

/**
 * 归一化 trustedDomains：接受 `example.com`、`https://example.com:8443/path` 等，
 * 统一成小写 hostname；非法项丢弃、去重。
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeTrustedDomains(value) {
  if (!Array.isArray(value)) return [];
  const domains = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    let hostname = '';
    try {
      const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
      hostname = url.hostname;
    } catch {
      continue;
    }
    hostname = hostname.toLowerCase().replace(/^\.+|\.+$/gu, '');
    if (hostname !== '') domains.add(hostname);
  }
  return [...domains];
}

/**
 * 选择后台分析调用的路由：config 显式 > 会话 request header > 默认。
 * @param {object} config - 归一化配置
 * @param {{provider?:string,model?:string}|undefined|null} headerConfig - session.requestHeader()?.config
 * @returns {{provider:string, model:string}}
 */
export function pickRoute(config, headerConfig) {
  const provider = nonEmptyString(config?.provider) ?? nonEmptyString(headerConfig?.provider) ?? DEFAULT_ROUTE.provider;
  const model = nonEmptyString(config?.model) ?? nonEmptyString(headerConfig?.model) ?? DEFAULT_ROUTE.model;
  return { provider, model };
}

/**
 * 归一化 analysisReasoningEffort：
 *  - 未提供（undefined）→ 默认 'off'；
 *  - null / ''（或纯空白）→ null（不传该字段）；
 *  - 其它字符串 → trim 后原样返回（off/low/high/max 或模型自定义 id）；
 *  - 非法类型 → 默认 'off'。
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeReasoningEffort(value) {
  if (value === undefined) return DEFAULT_CONFIG.analysisReasoningEffort;
  if (value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return DEFAULT_CONFIG.analysisReasoningEffort;
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function intAtLeast(value, fallback, minimum) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
