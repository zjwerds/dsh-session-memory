/**
 * dsh-session-memory — host-only DSH 插件 v0.3（task-16）。
 *
 * 每个用户回合结束（`turn/end` + reason.kind==='completed' + 非 subagent）后，异步发起一次
 * `ctx.llm.stream` 调用，一次产出：
 *   1. 本对话「项目记忆」全量条目（≤40/条、≤600 总，注入当前会话 order 160）；
 *   2. 长期记忆「用户身份 identity」（≤60，**从对话判断/推断**稳定身份；注入 order 156）；
 *   3. 长期记忆「用户习惯 habits」（每条 ≤20、总 ≤120；注入 order 157）；
 *   4. 长期记忆「账号密码 credentials」（≤60；**绝不注入**，只经 vault_read 按需读取）；
 *   5. 「话题差异标签 divergence」：程序强制的三次计数状态机（见 lib/divergence.js）。
 *
 * 注入顺序（必须）：用户身份 156 → 用户习惯 157 → 项目记忆 160 → 固定规则 161。
 * 项目记忆 / identity / habits 都在写侧与注入侧过滤秘密片段与凭据形态，credentials 永不注入。
 *
 * 长期记忆明文只存 vault.json（v3；0600 best-effort、原子写、history），通过
 * `ctx.skills.register` 的 `user-profile` skill（正文不含明文）+ `vault_read` 工具按需读取；
 * `ctx.tools.guard` 分级（balanced/strict/off）只拦危险外发。
 *
 * 零运行时依赖：只用 node: 内置模块；工具定义按 dsh-tools d.ts 的 ToolDefinition 形状手写。
 * 日志纪律：只打印错误码/长度/耗时/布尔，绝不打印任何记忆内容（含 divergence 标签内容）。
 */
import { pickRoute, resolveConfig, resolveDataDir } from './config.js';
import { applyDivergence, divergenceTagLength } from './divergence.js';
import { collectCombinedSecretFragments, filterEntriesBySecrets, makeGuard } from './guard.js';
import {
  RULES_TEXT,
  SKILL_DESCRIPTION,
  SKILL_NAME,
  allSessionsToolValue,
  renderHabitsSection,
  renderIdentitySection,
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

/** 用户身份注入段 order（v0.3）。 */
export const IDENTITY_SECTION_ORDER = 156;
/** 用户习惯注入段 order（v0.3）。 */
export const HABITS_SECTION_ORDER = 157;
/** 项目记忆注入段 order。 */
export const PROJECT_SECTION_ORDER = 160;
/** 固定规则段 order。 */
export const RULES_SECTION_ORDER = 161;
/** 用户身份注入段 name。 */
export const IDENTITY_SECTION_NAME = 'plugin:session-memory-identity';
/** 用户习惯注入段 name。 */
export const HABITS_SECTION_NAME = 'plugin:session-memory-habits';
/** 项目记忆注入段 name。 */
export const PROJECT_SECTION_NAME = 'plugin:session-memory';
/** 固定规则段 name。 */
export const RULES_SECTION_NAME = 'plugin:session-memory-rules';

/** 后台分析的 maxTokens。 */
const ANALYSIS_MAX_TOKENS = 400;
/** 推理吃光 token 时的兜底放大值。 */
const ANALYSIS_RETRY_MAX_TOKENS = 2000;
/** R5：解析失败后追加的重试提示。 */
const PARSE_RETRY_HINT = '\n\n只输出一行 JSON，不要解释、不要代码围栏。';

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
  'strikes',
  'tagLen',
  'frozen',
  'divergenceChanged',
  'habits',
]);

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
      habitsMaxChars: config.habitsMaxChars,
      habitEntryMaxChars: config.habitEntryMaxChars,
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

  // ── 注入段 order 156：用户身份（v0.3）──────────────────────────────────
  effect(() => ctx.systemPrompt.section({
    name: IDENTITY_SECTION_NAME,
    order: IDENTITY_SECTION_ORDER,
    interpolate: false,
    text: () => {
      try {
        return renderIdentitySection(store.vaultIdentity());
      } catch {
        return '';
      }
    },
  }), 'dsh-session-memory: identity section');

  // ── 注入段 order 157：用户习惯（v0.3）──────────────────────────────────
  effect(() => ctx.systemPrompt.section({
    name: HABITS_SECTION_NAME,
    order: HABITS_SECTION_ORDER,
    interpolate: false,
    text: () => {
      try {
        return renderHabitsSection(store.vaultHabits());
      } catch {
        return '';
      }
    },
  }), 'dsh-session-memory: habits section');

  // ── 注入段 order 160：当前会话项目记忆（绝不注入 vault 明文）────────────
  effect(() => ctx.systemPrompt.section({
    name: PROJECT_SECTION_NAME,
    order: PROJECT_SECTION_ORDER,
    interpolate: false,
    text: (context) => {
      try {
        const sessionId = contextSessionId(context);
        if (sessionId === null) return '';
        // R1 兜底（写侧之后的最后一道）：vault 片段 + 凭据形态过滤，旧数据也不会进 system prompt。
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

  // ── 注入段 order 161：固定规则（v0.3 文案）─────────────────────────────
  effect(() => ctx.systemPrompt.section({
    name: RULES_SECTION_NAME,
    order: RULES_SECTION_ORDER,
    interpolate: false,
    text: RULES_TEXT,
  }), 'dsh-session-memory: rules section');

  // ── 工具：session_memory_read / vault_read（scope 含 habits）────────────
  const tools = createToolDefinitions(store);
  for (const definition of tools) {
    effect(() => ctx.tools.register(definition), `dsh-session-memory: tool ${definition.name}`);
  }

  // ── 程序化护栏：只拦危险外发，本地工具放行 ──────────────────────────────
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
 * habits 是自动注入的普通偏好，不作为秘密片段。
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

function divergenceStatusCode(status) {
  if (status === 'new') return 'NEW';
  if (status === 'continuing') return 'CONTINUING';
  if (status === 'commit') return 'COMMIT';
  if (status === 'reset') return 'RESET';
  return 'NONE';
}

/**
 * 一次后台分析：读快照 → 取回合文本 → LLM 调用（解析失败重试一次）→ 程序化校验
 * （秘密片段过滤 + divergence 状态机）→ 落盘。任何失败只记错误码，不影响回合本身。
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
  const currentDivergence = projectBefore.record?.divergence ?? null;
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
    habits: vaultBefore.habits,
    credentialsText: vaultBefore.credentials,
    turnText,
    entryMaxChars: config.entryMaxChars,
    projectMaxChars: config.projectMaxChars,
    identityMaxChars: config.identityMaxChars,
    habitsMaxChars: config.habitsMaxChars,
    habitEntryMaxChars: config.habitEntryMaxChars,
    credentialsMaxChars: config.credentialsMaxChars,
  });
  logger.debug('ANALYSIS_START', {
    chars: inputChars,
    entries: currentEntries.length,
    habits: vaultBefore.habits.length,
    rev: projectBefore.rev,
  });

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
    habitsMaxChars: config.habitsMaxChars,
    habitEntryMaxChars: config.habitEntryMaxChars,
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

  // 1) 项目记忆候选（R1 + task-10 + task-12）：两道过滤叠加；过滤后为空而模型给了
  //    非空列表 → 保留旧记忆（不覆盖为空）。
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
  let projectCandidate = null;
  if (!(modelEntries.length > 0 && filteredProject.entries.length === 0)) {
    projectCandidate = resolveProjectEntries(currentEntries, { entries: filteredProject.entries });
  }
  if (filteredProject.removed > 0) {
    logger.warn('ANALYSIS_PROJECT_ENTRIES_REDACTED', {
      removed: filteredProject.removed,
      entries: filteredProject.entries.length,
    });
  }

  // 2) divergence 状态机（程序强制）：决定本轮是否允许写项目记忆。
  const divergenceResult = applyDivergence(currentDivergence, parsed.divergence, turn);
  const nextDivergence = divergenceResult.divergence;
  const acceptProjectMemory = divergenceResult.acceptProjectMemory;
  const nextEntries = acceptProjectMemory ? projectCandidate : null;
  const divergenceChanged = JSON.stringify(normalizeJson(currentDivergence)) !== JSON.stringify(normalizeJson(nextDivergence));
  const tagLen = divergenceTagLength(nextDivergence !== null ? nextDivergence : currentDivergence);
  logger.debug('ANALYSIS_DIVERGENCE', {
    code: divergenceStatusCode(divergenceResult.status),
    strikes: nextDivergence?.strikes ?? currentDivergence?.strikes ?? 0,
    tagLen,
    frozen: !acceptProjectMemory,
    divergenceChanged,
  });

  // 3) 落盘项目记忆 / divergence（冻结时 entries 保持旧值，但 divergence 状态要写）。
  let projectChanged = false;
  if (nextEntries !== null || divergenceChanged) {
    try {
      const now = Date.now();
      const result = await store.updateProjectMemory(sessionId, (record) => {
        const baseEntries = Array.isArray(record?.entries) ? record.entries : [];
        const entries = nextEntries === null
          ? baseEntries
          : mergeProjectEntries(baseEntries, nextEntries, turn, now);
        return {
          cwd: typeof session?.header?.cwd === 'string' ? session.header.cwd : '',
          updatedAt: now,
          entries,
          divergence: nextDivergence,
        };
      }, { expectedRev: projectBefore.rev });
      projectChanged = result.changed && nextEntries !== null;
    } catch (error) {
      logger.warn('ANALYSIS_PROJECT_WRITE_FAILED', { code: errorCode(error) });
    }
  }

  // 4) 长期记忆（identity / habits / credentials）：与 divergence 冻结无关，始终允许更新。
  let vaultChanged = false;
  const vaultUpdate = {};
  if (parsed.identity !== null) vaultUpdate.identity = parsed.identity.text;
  if (parsed.habits !== null) vaultUpdate.habits = parsed.habits.items;
  if (parsed.credentials !== null) vaultUpdate.credentials = parsed.credentials.text;
  if (Object.keys(vaultUpdate).length > 0) {
    try {
      const result = await store.updateVault(vaultUpdate, {
        reason: parsed.identity?.reason ?? parsed.habits?.reason ?? parsed.credentials?.reason ?? '',
        sessionId,
        turn,
      }, { expectedRev: vaultBefore.rev });
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

/** JSON 归一（用于比较 divergence 是否变化；null 安全）。 */
function normalizeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return value;
  return {
    tag: typeof value.tag === 'string' ? value.tag : null,
    strikes: typeof value.strikes === 'number' ? value.strikes : 0,
    lastTurn: typeof value.lastTurn === 'number' ? value.lastTurn : 0,
  };
}

/**
 * 发起一次分析 LLM 调用并收集文本（`ctx.llm.stream` 的 StreamChunk 以 llm d.ts 为准：
 * `{ type:'text-delta', text }`）。
 *
 * 默认带 `reasoningEffort: config.analysisReasoningEffort`（默认 'off'）：e2e 实测
 * deepseek-flash 默认 effort=high（thinking 开启），400 maxTokens 会全被 thinking_delta
 * 吃光 → textChars=0 / stop=max_tokens → EMPTY_OUTPUT，记忆永不落盘。
 *
 * 兜底（各最多一次，仍失败走原失败路径）：
 *  1) 适配器拒绝/不支持该 effort → 去掉 reasoningEffort 重试一次；
 *  2) 首轮 text 为空且 finish=max-tokens → maxTokens 放大重试一次。
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
 * 超时用 AbortController + Promise.race 双保险；error 上附 chunksReceived（非枚举）。
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
      description: '读取长期记忆（用户身份/习惯/账号密码明文）。仅当用户明确索要身份、习惯、账号或密码时调用；允许在本机使用或告知用户本人，但禁止发往未经授权的外部网站/子代理/工作流/其它 agent。',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['all', 'identity', 'habits', 'credentials'],
            description: 'all（默认）= 身份+习惯+账号密码；identity/habits/credentials = 只读对应段',
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
        const scope = value.scope === 'identity' || value.scope === 'habits' || value.scope === 'credentials'
          ? value.scope
          : 'all';
        return vaultToolValue({
          identity: store.vaultIdentity(),
          habits: store.vaultHabits(),
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
