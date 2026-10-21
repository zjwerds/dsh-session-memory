/**
 * dsh-session-memory — host-only DSH 插件 v0.2（spec-impl.md §1-§9；task-11 需求 A/B）。
 *
 * 每个用户回合结束（`turn/end` + reason.kind==='completed' + 非 subagent）后，
 * 异步发起一次 `ctx.llm.stream` 调用，一次产出三件事：
 *   1. 本对话「项目记忆」全量条目（每条 ≤30 码点，总 ≤300 码点）；
 *   2. `$DSH_HOME/memory/vault.json` 的长期记忆「用户身份 identity」（≤60 码点）：
 *      称呼/姓名、职业/角色、语言、邮箱/手机（只记用户明确说过的）；
 *   3. 长期记忆「账号密码 credentials」（≤60 码点）。
 * 模型输出一律程序化校验/截断/失败放弃（见 prompt.js）。
 *
 * 注入：`ctx.systemPrompt.section({ name:'plugin:session-memory', order:160,
 * interpolate:false, text })` 只注入当前 session 的项目记忆；**vault 永远不进
 * system prompt / skill catalog**。另注册 order 161 固定规则段。
 *
 * 长期记忆：明文只存 vault.json（v2；0600 best-effort、原子写、history），通过
 * `ctx.skills.register` 的 `user-profile` skill（正文不含明文）+ `vault_read`
 * 工具按需读取；`ctx.tools.guard` 分级（balanced/strict/off）只拦危险外发。
 *
 * 零运行时依赖：只用 node: 内置模块；工具定义按 dsh-tools d.ts 的 ToolDefinition
 * 形状手写（不 import @deepseek-ai/dsh-tools，避免插件安装时解析不到 peer 包）。
 *
 * 日志纪律：只打印错误码/长度/耗时/布尔，绝不打印任何记忆内容。
 */
import { pickRoute, resolveConfig, resolveDataDir } from './config.js';
import { collectCombinedSecretFragments, filterEntriesBySecrets, makeGuard } from './guard.js';
import {
  RULES_TEXT,
  SKILL_DESCRIPTION,
  SKILL_NAME,
  allSessionsToolValue,
  renderProjectSection,
  renderSkillBody,
  sessionMemoryToolValue,
  vaultToolValue,
} from './inject.js';
import {
  buildAnalysisPrompt,
  parseAnalysisOutput,
  resolveProjectEntries,
} from './prompt.js';
import { filterEntriesByCredentialPatterns } from './secrets-patterns.js';
import { MemoryStore } from './store.js';
import { codePointLength } from './text.js';
import { collectTurnText, shouldAnalyzeEvent } from './turn.js';

/** cordis 插件名。 */
export const name = 'dsh-session-memory';

/** 依赖的 host 服务；缺任意一个时插件不 apply。 */
export const inject = ['tools', 'systemPrompt', 'llm', 'skills'];


/** 项目记忆注入段 order（spec §5）。 */
export const PROJECT_SECTION_ORDER = 160;
/** 固定规则段 order（spec §5）。 */
export const RULES_SECTION_ORDER = 161;
/** 项目记忆注入段 name。 */
export const PROJECT_SECTION_NAME = 'plugin:session-memory';
/** 固定规则段 name。 */
export const RULES_SECTION_NAME = 'plugin:session-memory-rules';
/** 后台分析的 maxTokens（spec §4：约 400）。 */
const ANALYSIS_MAX_TOKENS = 400;
/**
 * 兜底重试时的 maxTokens：首轮文本为空且 finish=max-tokens（thinking 把 token
 * 预算吃光）时放大一次（e2e 证据：deepseek-flash 默认 effort=high + 400 tokens
 * 会 textChars=0 / stop=max_tokens）。
 */
const ANALYSIS_RETRY_MAX_TOKENS = 2000;
/** 日志里允许出现的数值/布尔字段白名单（绝不含记忆内容）。 */
const SAFE_LOG_FIELDS = new Set([
  'code',
  'ms',
  'chars',
  'entries',
  'rev',
  'count',
  'truncated',
  'dropped',
  'backup',
  'changed',
  'projectChanged',
  'longtermChanged',
  'vaultChanged',
  'removed',
  'retried',
]);

/** R5：解析失败后用同一 prompt 追加这句再试一次（仍失败则按设计放弃）。 */
const PARSE_RETRY_HINT = '\n\n只输出一行 JSON，不要解释、不要代码围栏。';

/**
 * 插件入口（cordis apply）。
 * @param {object} ctx - cordis 插件上下文
 * @param {object} [rawConfig] - patch 行 config
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const logger = createLogger(config);
  let store;
  try {
    store = new MemoryStore({
      dataDir: resolveDataDir(config),
      entryMaxChars: config.entryMaxChars,
      projectMaxChars: config.projectMaxChars,
      identityMaxChars: config.identityMaxChars,
      credentialsMaxChars: config.credentialsMaxChars,
      onWarn: (code, info) => logger.warn(code, info),
    });
  } catch (error) {
    logger.warn('STORE_INIT_FAILED', { code: errorCode(error) });
    return;
  }

  const effect = (fn, label) => {
    try {
      return ctx.effect(fn, label);
    } catch (error) {
      logger.warn('EFFECT_REGISTER_FAILED', { code: errorCode(error) });
      return () => {};
    }
  };

  // ── 长期记忆 skill（apply 时注册一次，正文静态、不含明文）──────────────
  // R3：不再在 vault 变化后 dispose+register。运行期重注册在 cordis 里可能被拒绝
  // （e2e 实测 SKILL_REGISTER_FAILED）；是否为空交给 vault_read 的返回说明。
  let disposeSkill = null;
  effect(() => {
    try {
      disposeSkill = ctx.skills.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        source: 'dsh-session-memory',
        content: renderSkillBody(),
      });
    } catch (error) {
      logger.warn('SKILL_REGISTER_FAILED', { code: errorCode(error) });
    }
    return () => {
      try {
        if (typeof disposeSkill === 'function') disposeSkill();
      } catch {
        // 忽略。
      }
      disposeSkill = null;
    };
  }, 'dsh-session-memory: skill');

  // ── 注入段：只注入当前会话项目记忆（绝不注入 vault 明文）────────────────
  effect(() => ctx.systemPrompt.section({
    name: PROJECT_SECTION_NAME,
    order: PROJECT_SECTION_ORDER,
    interpolate: false,
    text: (context) => {
      try {
        const sessionId = contextSessionId(context);
        if (sessionId === null) return '';
        // R1 兜底（写侧之后的最后一道）：渲染前叠加 vault 片段过滤 + 凭据形态过滤，
        // 旧版本写入的历史数据也不会进 system prompt。
        // task-12：identity 段用更短阈值（≥2 码点），短称呼/职业也能被过滤。
        const secretFragments = collectStoreSecretFragments(store);
        return renderProjectSection(
          store.projectEntries(sessionId),
          config.projectMaxChars,
          secretFragments,
          { enabled: config.credentialPatternGuard, tokenMinChars: config.credentialTokenMinChars },
        );
      } catch {
        return '';
      }
    },
  }), 'dsh-session-memory: project section');

  // ── 固定规则段（order 161）──────────────────────────────────────────────
  effect(() => ctx.systemPrompt.section({
    name: RULES_SECTION_NAME,
    order: RULES_SECTION_ORDER,
    interpolate: false,
    text: RULES_TEXT,
  }), 'dsh-session-memory: rules section');

  // ── 工具：session_memory_read / vault_read ──────────────────────────────
  const tools = createToolDefinitions(store);
  for (const definition of tools) {
    effect(() => ctx.tools.register(definition), `dsh-session-memory: tool ${definition.name}`);
  }

  // ── 程序化护栏（v0.2 分级）：只拦危险外发，本地工具放行 ─────────────────
  effect(() => {
    if (config.guardMode === 'off') return () => {};
    return ctx.tools.guard(makeGuard({
      // 秘密片段 = identity（≥2 码点，去字段标签）+ credentials（≥6 码点）+ history 旧值。
      getVaultFragments: () => collectStoreSecretFragments(store),
      guardMode: config.guardMode,
      trustedDomains: config.trustedDomains,
      allowTools: ['vault_read', 'session_memory_read'],
    }));
  }, 'dsh-session-memory: vault guard');

  // ── 回合结束：异步后台分析（同一 session 串行，fire-and-forget）─────────
  /** @type {Map<string, Promise<void>>} */
  const analysisQueue = new Map();
  /** @type {Map<string, number>} 已调度过的最大 turn，避免重复事件重复调用模型。 */
  const lastAnalyzedTurn = new Map();
  const scheduleAnalysis = (key, task) => {
    const previous = analysisQueue.get(key) ?? Promise.resolve();
    const current = previous.then(task, task);
    const guarded = current.catch(() => {});
    analysisQueue.set(key, guarded);
    guarded.then(() => {
      if (analysisQueue.get(key) === guarded) analysisQueue.delete(key);
    });
    return current;
  };
  effect(() => ctx.on('session/event', (session, event) => {
    try {
      if (!shouldAnalyzeEvent(event, session?.header)) return;
      const sessionId = sessionIdOfSession(session);
      if (sessionId === null) return;
      const turn = event.data.turn;
      const previousTurn = lastAnalyzedTurn.get(sessionId);
      if (previousTurn !== undefined && turn <= previousTurn) {
        logger.debug('ANALYSIS_SKIPPED_DUPLICATE', { ms: 0 });
        return;
      }
      lastAnalyzedTurn.delete(sessionId);
      lastAnalyzedTurn.set(sessionId, turn);
      if (lastAnalyzedTurn.size > 1024) {
        lastAnalyzedTurn.delete(lastAnalyzedTurn.keys().next().value);
      }
      scheduleAnalysis(sessionId, () => runAnalysis({
        ctx,
        config,
        store,
        logger,
        session,
        sessionId,
        turn,
      })).catch((error) => logger.warn('ANALYSIS_UNEXPECTED', { code: errorCode(error) }));
    } catch (error) {
      logger.warn('SESSION_EVENT_HANDLER_FAILED', { code: errorCode(error) });
    }
  }), 'dsh-session-memory: turn-end analysis');
}

/**
 * 从 MemoryStore 生成合并秘密片段（project memory 写侧 / 注入侧 / guard 共用）：
 *  - identity 段：≥2 码点（去掉「称呼/职业」等字段标签词）；
 *  - credentials 段：≥6 码点（沿用旧阈值防误伤）；
 *  - 可附加"本次即将写入"的两段明文（写侧）。
 * @param {MemoryStore} store
 * @param {string[]} [extraIdentity]
 * @param {string[]} [extraCredentials]
 * @returns {string[]}
 */
function collectStoreSecretFragments(store, extraIdentity = [], extraCredentials = []) {
  return collectCombinedSecretFragments(
    [...store.vaultIdentityTexts(), ...extraIdentity],
    [...store.vaultCredentialTexts(), ...extraCredentials],
  );
}

/**
 * 一次后台分析：读快照 → 取回合文本 → LLM 调用（解析失败重试一次）→ 程序化校验
 * （含 R1 秘密片段过滤）→ 落盘。任何失败只记错误码，不影响回合本身。
 */
async function runAnalysis(deps) {
  const { ctx, config, store, logger, session, sessionId, turn } = deps;
  const startedAt = Date.now();
  let header = null;
  try {
    header = typeof session?.requestHeader === 'function' ? session.requestHeader() : null;
  } catch {
    header = null;
  }
  const route = pickRoute(config, header?.config);
  const projectBefore = store.projectSnapshot(sessionId);
  const currentEntries = Array.isArray(projectBefore.record?.entries)
    ? projectBefore.record.entries.map((entry) => entry.text)
    : [];
  const vaultBefore = store.vaultSnapshot();

  const turnText = collectTurnText(session, turn, { maxInputChars: config.maxInputChars });
  const inputChars = codePointLength(turnText);
  if (inputChars === 0) {
    logger.debug('ANALYSIS_SKIPPED_EMPTY', { chars: 0, ms: Date.now() - startedAt });
    return;
  }
  const prompt = buildAnalysisPrompt({
    projectEntries: currentEntries,
    identityText: vaultBefore.identity,
    credentialsText: vaultBefore.credentials,
    turnText,
    entryMaxChars: config.entryMaxChars,
    projectMaxChars: config.projectMaxChars,
    identityMaxChars: config.identityMaxChars,
    credentialsMaxChars: config.credentialsMaxChars,
  });
  logger.debug('ANALYSIS_START', { chars: inputChars, entries: currentEntries.length, rev: projectBefore.rev });

  let raw;
  try {
    if (ctx.llm === undefined || typeof ctx.llm.stream !== 'function') {
      logger.warn('ANALYSIS_LLM_UNAVAILABLE', { code: 'NO_LLM' });
      return;
    }
    raw = await requestAnalysisText(ctx, config, route, prompt, logger);
  } catch (error) {
    logger.warn('ANALYSIS_LLM_FAILED', { code: errorCode(error), ms: Date.now() - startedAt });
    return;
  }

  const analysisLimits = {
    entryMaxChars: config.entryMaxChars,
    projectMaxChars: config.projectMaxChars,
    identityMaxChars: config.identityMaxChars,
    credentialsMaxChars: config.credentialsMaxChars,
  };
  let parsed = parseAnalysisOutput(raw, analysisLimits);
  if (!parsed.ok) {
    // R5：解析失败（NO_JSON/EMPTY_OUTPUT/BAD_JSON…）用同一 prompt 追加一句再试一次，
    // 仍失败按设计放弃本回合（只记错误码）。
    logger.debug('ANALYSIS_PARSE_RETRY', { code: parsed.code, retried: 1 });
    try {
      raw = await requestAnalysisText(ctx, config, route, prompt + PARSE_RETRY_HINT, logger);
    } catch (error) {
      logger.warn('ANALYSIS_LLM_FAILED', { code: errorCode(error), ms: Date.now() - startedAt });
      return;
    }
    parsed = parseAnalysisOutput(raw, analysisLimits);
  }
  if (!parsed.ok) {
    logger.warn('ANALYSIS_PARSE_FAILED', { code: parsed.code, ms: Date.now() - startedAt });
    return;
  }

  // 1) 项目记忆（R1 + task-10 + task-11 A.6 + task-12）：两道过滤叠加后，过滤后为空而
  //    模型给了非空列表 → 保留旧记忆，不覆盖为空。
  //    ① vault 秘密片段 —— identity 段用 ≥2 码点（短称呼/职业），credentials 段用 ≥6 码点；
  //       来源 = 当前两段 + history 旧值 + 本次即将写入的 identity/credentials。
  //    ② 通用凭据形态 —— 关键词上下文 + 高熵 token；拦住"密码在对话里出现但从未进
  //       vault"的边界（identity/credentials 均为 none 时 ① 无片段可用）。
  const projectedIdentity = parsed.identity !== null ? parsed.identity.text : null;
  const projectedCredentials = parsed.credentials !== null ? parsed.credentials.text : null;
  const secretFragments = collectStoreSecretFragments(
    store,
    projectedIdentity !== null ? [projectedIdentity] : [],
    projectedCredentials !== null ? [projectedCredentials] : [],
  );
  const modelEntries = parsed.project.entries;
  const secretFiltered = filterEntriesBySecrets(modelEntries, secretFragments);
  const credentialFiltered = config.credentialPatternGuard
    ? filterEntriesByCredentialPatterns(secretFiltered.entries, { tokenMinChars: config.credentialTokenMinChars })
    : { entries: secretFiltered.entries, removed: 0 };
  const filteredProject = {
    entries: credentialFiltered.entries,
    removed: secretFiltered.removed + credentialFiltered.removed,
  };
  let nextEntries = null;
  if (filteredProject.removed > 0) {
    logger.warn('ANALYSIS_PROJECT_ENTRIES_REDACTED', {
      removed: filteredProject.removed,
      entries: filteredProject.entries.length,
    });
  }
  if (!(modelEntries.length > 0 && filteredProject.entries.length === 0)) {
    nextEntries = resolveProjectEntries(currentEntries, { entries: filteredProject.entries });
  }

  let projectChanged = false;
  if (nextEntries !== null) {
    try {
      const now = Date.now();
      const merged = mergeProjectEntries(projectBefore.record?.entries ?? [], nextEntries, turn, now);
      const result = await store.updateProjectMemory(sessionId, () => ({
        cwd: typeof session?.header?.cwd === 'string' ? session.header.cwd : '',
        updatedAt: now,
        entries: merged,
      }), { expectedRev: projectBefore.rev });
      projectChanged = result.changed;
    } catch (error) {
      logger.warn('ANALYSIS_PROJECT_WRITE_FAILED', { code: errorCode(error) });
    }
  }

  // 2) 长期记忆（v0.2 identity + credentials 两段）：任一合法 set 即写；两段都不变则 no-op。
  let vaultChanged = false;
  if (parsed.identity !== null || parsed.credentials !== null) {
    try {
      const result = await store.updateVault(
        {
          ...(parsed.identity !== null ? { identity: parsed.identity.text } : {}),
          ...(parsed.credentials !== null ? { credentials: parsed.credentials.text } : {}),
        },
        {
          reason: parsed.identity?.reason ?? parsed.credentials?.reason ?? '',
          sessionId,
          turn,
        },
        { expectedRev: vaultBefore.rev },
      );
      vaultChanged = result.changed;
    } catch (error) {
      logger.warn('ANALYSIS_VAULT_WRITE_FAILED', { code: errorCode(error) });
    }
  }

  logger.debug('ANALYSIS_DONE', {
    ms: Date.now() - startedAt,
    entries: nextEntries === null ? currentEntries.length : nextEntries.length,
    truncated: parsed.project.truncated + parsed.project.dropped,
    removed: filteredProject.removed,
    projectChanged,
    vaultChanged,
  });
}

/**
 * 发起一次分析 LLM 调用并收集文本（`ctx.llm.stream` 的 StreamChunk 以 llm d.ts 为准：
 * `{ type:'text-delta', text }`）。
 *
 * 默认带 `reasoningEffort: config.analysisReasoningEffort`（默认 'off'）：e2e 实测
 * deepseek-flash 默认 effort=high（thinking 开启），400 maxTokens 会全被
 * thinking_delta 吃光 → textChars=0 / stop=max_tokens → EMPTY_OUTPUT，记忆永不落盘。
 *
 * 兜底（各最多一次，仍失败走原失败路径）：
 *  1) 适配器拒绝/不支持该 effort（如 LlmError code UNSUPPORTED_REASONING_EFFORT /
 *     INVALID_REASONING_EFFORT 等）→ 去掉 reasoningEffort 重试一次；
 *  2) 首轮 text 为空且 finish=max-tokens（推理吃光预算）→ maxTokens 放大重试一次。
 *
 * @param {object} ctx
 * @param {object} config
 * @param {{provider:string, model:string}} route
 * @param {string} prompt
 * @param {{debug:(code:string, info?:object)=>void}} logger
 * @returns {Promise<string>}
 */
async function requestAnalysisText(ctx, config, route, prompt, logger) {
  const baseOptions = {
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: ANALYSIS_MAX_TOKENS,
  };
  const effort = normalizeEffortOption(config.analysisReasoningEffort);
  const withEffort = effort === null ? baseOptions : { ...baseOptions, reasoningEffort: effort };
  let lastOptions = withEffort;
  let result;
  try {
    result = await collectStreamText(ctx, config, withEffort);
  } catch (error) {
    if (effort === null || !isReasoningEffortRejection(error)) throw error;
    // 兜底 1：该模型/适配器不接受这个推理强度 → 去掉字段重试一次。
    logger.debug('ANALYSIS_EFFORT_RETRY', { code: errorCode(error) });
    lastOptions = baseOptions;
    result = await collectStreamText(ctx, config, baseOptions);
  }

  // 兜底 2：没有可见文本且 stop=max-tokens（thinking 吃光 400 token）→ 放大预算重试一次。
  if (result.text === '' && result.finishReason === 'max-tokens') {
    logger.debug('ANALYSIS_MAX_TOKENS_RETRY', { chars: 0, ms: 0 });
    result = await collectStreamText(ctx, config, { ...lastOptions, maxTokens: ANALYSIS_RETRY_MAX_TOKENS });
  }
  return result.text;
}

/**
 * 单次 stream 调用：收集 text-delta，返回 { text, finishReason, chunks }。
 * 超时用 AbortController + Promise.race 双保险；error 上附 chunksReceived（非枚举）
 * 供「立即抛错」判断（不去日志、不含内容）。
 * @returns {Promise<{text:string, finishReason:string|undefined, chunks:number}>}
 */
async function collectStreamText(ctx, config, options) {
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        // 忽略取消失败。
      }
      reject(pluginError('LLM_TIMEOUT'));
    }, config.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  const run = (async () => {
    let text = '';
    let finishReason;
    let chunks = 0;
    try {
      const stream = ctx.llm.stream({ ...options, signal: controller.signal });
      for await (const chunk of stream) {
        chunks += 1;
        if (chunk === null || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text;
          continue;
        }
        if (chunk.type === 'finish') {
          finishReason = chunk.reason?.kind;
          if (finishReason === 'error') throw pluginError('LLM_FINISH_ERROR');
          if (finishReason === 'aborted') throw pluginError(timedOut ? 'LLM_TIMEOUT' : 'LLM_ABORTED');
        }
      }
    } catch (error) {
      attachChunkCount(error, chunks);
      throw error;
    }
    return { text, finishReason, chunks };
  })();
  // 防止超时后底层 stream 的 rejection 变成 unhandled。
  run.catch(() => {});
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 在 error 上挂非枚举 chunksReceived（不打印、不改变 message）。 */
function attachChunkCount(error, chunks) {
  if (error === null || typeof error !== 'object') return;
  try {
    if (!Object.hasOwn(error, 'chunksReceived')) {
      Object.defineProperty(error, 'chunksReceived', { value: chunks, enumerable: false, configurable: true });
    }
  } catch {
    // 冻结/代理错误：忽略，不影响错误本身。
  }
}

/** config 归一化后的 effort：非空字符串才透传；null/空串 = 不传该字段。 */
function normalizeEffortOption(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 判断错误是否属于「推理强度不被支持/无效」类，可在去掉 reasoningEffort 后重试。
 * 依据错误链上的 code/name/message（message 只在内存里判断，绝不写日志）。
 * @param {unknown} error
 * @returns {boolean}
 */
function isReasoningEffortRejection(error) {
  const codes = [];
  const messages = [];
  const visit = (value, depth) => {
    if (depth > 4 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      messages.push(value);
      return;
    }
    if (typeof value !== 'object') return;
    if (typeof value.code === 'string') codes.push(value.code);
    if (typeof value.name === 'string') codes.push(value.name);
    if (typeof value.message === 'string') messages.push(value.message);
    const failure = value.failure;
    if (failure !== null && typeof failure === 'object') {
      if (typeof failure.code === 'string') codes.push(failure.code);
      if (typeof failure.message === 'string') messages.push(failure.message);
    }
    visit(value.cause, depth + 1);
  };
  visit(error, 0);
  for (const code of codes) {
    if (/REASONING[_\s-]?EFFORT/i.test(code)) return true;
    if (/UNSUPPORTED_REASONING/i.test(code) || /INVALID_MODEL_REASONING/i.test(code)) return true;
  }
  const joined = messages.join('\n');
  if (!/reasoning[\s_-]*effort/i.test(joined)) return false;
  // 只有「立即抛」才优先归因为推理强度问题；流中途的错误不重试。
  const chunks = typeof error === 'object' && error !== null ? error.chunksReceived : undefined;
  return typeof chunks !== 'number' || chunks === 0;
}

/** 合并条目元数据：文本相同的旧条目保留原 turn/at，新条目用本回合。 */
function mergeProjectEntries(previousEntries, texts, turn, now) {
  const byText = new Map();
  for (const entry of previousEntries) {
    if (entry !== null && typeof entry === 'object' && typeof entry.text === 'string' && !byText.has(entry.text)) {
      byText.set(entry.text, entry);
    }
  }
  return texts.map((text) => {
    const previous = byText.get(text);
    return {
      text,
      turn: previous !== undefined && typeof previous.turn === 'number' ? previous.turn : turn,
      at: previous !== undefined && typeof previous.at === 'number' ? previous.at : now,
    };
  });
}

/**
 * 手写工具定义（形状 = dsh-tools d.ts 的 ToolDefinition：name/description/
 * parameters(JSON Schema)/output{schema,render}/execute）。零依赖，不 import dsh 包。
 */
function createToolDefinitions(store) {
  return [
    {
      name: 'session_memory_read',
      description: '读取本对话或其它会话的项目记忆（只读，不含长期记忆）。默认当前会话；all:true 列出全部会话摘要。',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '目标会话 id；缺省 = 当前会话' },
          all: { type: 'boolean', description: 'true = 列出全部会话的项目记忆摘要' },
        },
      },
      output: {
        schema: {},
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const value = asObject(args);
        if (value.all === true) return allSessionsToolValue(store.listSessions());
        const current = exec?.agent?.session?.id;
        const sessionId = typeof value.session_id === 'string' && value.session_id.trim() !== ''
          ? value.session_id.trim()
          : (typeof current === 'string' ? current : '');
        if (sessionId === '') {
          return { error: 'NO_SESSION', note: '无法确定当前会话；请显式传 session_id 或 all:true' };
        }
        return sessionMemoryToolValue(sessionId, store.projectSnapshot(sessionId));
      },
    },
    {
      name: 'vault_read',
      description: '读取长期记忆（用户身份/账号密码明文）。仅当用户明确索要身份信息/账号/密码时调用；允许在本机使用或告知用户本人，但禁止发往未经授权的外部网站/子代理/工作流/其它 agent。',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['all', 'identity', 'credentials'],
            description: 'all（默认）= 用户身份+账号密码；identity = 只读用户身份；credentials = 只读账号密码',
          },
          reason: { type: 'string', description: '可选：用户明确索要的依据（一句话）' },
          query: { type: 'string', description: '可选关键词（仅做命中提示）' },
        },
      },
      output: {
        schema: {},
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const value = asObject(args);
        const scope = value.scope === 'identity' || value.scope === 'credentials' ? value.scope : 'all';
        return vaultToolValue({
          identity: store.vaultIdentity(),
          credentials: store.vaultCredentials(),
        }, scope, value.query);
      },
    },
  ];
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function contextSessionId(context) {
  const id = context?.agent?.session?.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

function sessionIdOfSession(session) {
  const id = session?.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** 只含错误码的 Error（绝不携带模型/记忆内容）。 */
function pluginError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** 提取可安全写日志的错误码（不打印 message）。 */
function errorCode(error) {
  if (error === null || error === undefined) return 'UNKNOWN';
  const code = typeof error === 'string' ? error : error.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,48}$/u.test(code)) return code;
  const name = typeof error?.name === 'string' ? error.name : '';
  if (/^[A-Za-z0-9_]{1,48}$/u.test(name)) return name;
  return 'UNKNOWN';
}

/**
 * 日志器：只输出白名单内的错误码/数值/布尔（长度、耗时），绝不输出记忆内容。
 * @param {object} config
 */
function createLogger(config) {
  const write = (level, code, info) => {
    if (typeof code !== 'string' || code === '') return;
    if (level === 'debug' && config.debug !== true) return;
    const line = 'dsh-session-memory: ' + code + formatLogInfo(info);
    if (level === 'warn') console.warn(line);
    else if (level === 'debug') console.debug(line);
    else console.info(line);
  };
  return {
    debug: (code, info) => write('debug', code, info),
    info: (code, info) => write('info', code, info),
    warn: (code, info) => write('warn', code, info),
  };
}

function formatLogInfo(info) {
  if (info === null || typeof info !== 'object') return '';
  const parts = [];
  for (const key of SAFE_LOG_FIELDS) {
    if (!Object.hasOwn(info, key)) continue;
    const value = info[key];
    if (typeof value === 'boolean') {
      parts.push(`${key}=${value}`);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      parts.push(`${key}=${Math.round(value)}`);
    } else if (key === 'code' && typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,48}$/u.test(value)) {
      parts.push(`code=${value}`);
    }
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}
