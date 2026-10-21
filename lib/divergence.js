/**
 * divergence.js — 「话题差异标签」状态机（v0.3，程序强制，不依赖模型自律）。
 *
 * 用户需求：当本回合话题与当前项目记忆差距很大时，先打一个很小的标签；后续同话题延续
 * 继续计数；到第三次仍是同一话题的延续，才认为「可以安心存储」，清掉标签并允许写项目记忆。
 *
 * 模型每回合输出：
 *   {"status":"none|new|continuing|commit","tag":"≤6码点","same":true|false}
 * 程序维护 per-session 状态 `{tag, strikes, lastTurn}`（只落盘、不注入 system prompt）：
 *  - none：清空标签，正常接受 project_memory；
 *  - new：打标签 strikes=1，冻结 project_memory；若已存在同 tag 的标签，按 continuing 处理
 *    （避免模型重复给 new 导致计数丢失）；
 *  - continuing + same=true：strikes++；<3 冻结，>=3 等同 commit（接受并清空）；
 *  - continuing + same=false / 无标签：视为无关话题，清空标签并正常接受；
 *  - commit：strikes+1>=3 → 接受本轮 project_memory 并清空；否则按 continuing 继续冻结计数。
 *
 * 标签规则：trim、折叠空白、码点 ≤6（超长截断）；非法/空则用 `?<turn>` 兜底。
 *
 * 本模块零依赖、纯函数，可被单测直接 import。
 */
import { codePointLength, truncateCodePoints } from './text.js';

/** 标签最大码点数（「很小」的标签）。 */
export const DIVERGENCE_TAG_MAX_CHARS = 6;
/** 需要连续第几次同话题延续才允许存储（第三次）。 */
export const DIVERGENCE_STRIKES_REQUIRED = 3;

/**
 * 规范化标签：trim、把换行/连续空白折成单空格、码点 ≤6（超长截断）。
 * 非字符串/空白 → null。
 * @param {unknown} value
 * @returns {string|null}
 */
export function sanitizeDivergenceTag(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized === '') return null;
  return truncateCodePoints(normalized, DIVERGENCE_TAG_MAX_CHARS);
}

/**
 * 规范化落盘/内存里的 divergence 状态；非法 → null。
 * @param {unknown} value
 * @returns {{tag:string, strikes:number, lastTurn:number}|null}
 */
export function normalizeDivergenceState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const tag = sanitizeDivergenceTag(value.tag);
  if (tag === null) return null;
  const strikes = Number.isInteger(value.strikes) && value.strikes >= 1 ? value.strikes : 1;
  const lastTurn = typeof value.lastTurn === 'number' && Number.isFinite(value.lastTurn) ? value.lastTurn : 0;
  return { tag, strikes, lastTurn };
}

/**
 * 解析模型输出的 divergence 段（缺失/非法 → status none，安全清空）。
 * @param {unknown} value
 * @returns {{status:'none'|'new'|'continuing'|'commit', tag:string, same:boolean}}
 */
export function parseDivergence(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'none', tag: '', same: false };
  }
  const status = value.status === 'new' || value.status === 'continuing' || value.status === 'commit'
    ? value.status
    : 'none';
  return {
    status,
    tag: sanitizeDivergenceTag(value.tag) ?? '',
    same: value.same === true,
  };
}

function fallbackTag(turn) {
  return truncateCodePoints(`?${String(turn)}`, DIVERGENCE_TAG_MAX_CHARS);
}

function commitResult(status) {
  return { status, divergence: null, acceptProjectMemory: true, cleared: true };
}

function freezeResult(divergence, status) {
  return { status, divergence, acceptProjectMemory: false, cleared: false };
}

/** continuing/new-same-tag：strikes++；到 3 等同 commit（接受 + 清空），否则冻结。 */
function advance(current, tag, turn, status) {
  const strikes = current.strikes + 1;
  if (strikes >= DIVERGENCE_STRIKES_REQUIRED) return commitResult(status);
  return freezeResult({ tag, strikes, lastTurn: turn }, status);
}

/**
 * 应用一次 divergence 决策。
 *
 * @param {{tag:string, strikes:number, lastTurn:number}|null|undefined} current - 当前 session 的标签
 * @param {unknown} modelInput - 模型输出的 divergence 段
 * @param {number} turn
 * @returns {{status:string, divergence:{tag:string,strikes:number,lastTurn:number}|null,
 *            acceptProjectMemory:boolean, cleared:boolean}}
 */
export function applyDivergence(current, modelInput, turn) {
  const state = normalizeDivergenceState(current);
  const input = parseDivergence(modelInput);
  const turnValue = typeof turn === 'number' && Number.isFinite(turn) ? turn : 0;

  if (input.status === 'new') {
    const tag = input.tag !== '' ? input.tag : fallbackTag(turnValue);
    // 已存在同 tag 的标签时模型给 new → 按 continuing 处理，避免计数丢失。
    if (state !== null && state.tag === tag) return advance(state, tag, turnValue, 'continuing');
    // 新标签（或已有不同标签）：重置 strikes=1 并冻结。
    return freezeResult({ tag, strikes: 1, lastTurn: turnValue }, 'new');
  }

  if (input.status === 'continuing') {
    if (state !== null && input.same) return advance(state, state.tag, turnValue, 'continuing');
    // same=false 或没有已标记话题 → 无关话题：清空标签并正常接受。
    return commitResult('reset');
  }

  if (input.status === 'commit') {
    if (state !== null) {
      if (state.strikes + 1 >= DIVERGENCE_STRIKES_REQUIRED) return commitResult('commit');
      return freezeResult({ tag: state.tag, strikes: state.strikes + 1, lastTurn: turnValue }, 'continuing');
    }
    // 没有已标记话题却要 commit：按 new 处理（打标签、冻结，等待后续计数）。
    const tag = input.tag !== '' ? input.tag : fallbackTag(turnValue);
    return freezeResult({ tag, strikes: 1, lastTurn: turnValue }, 'new');
  }

  // none / 未知 → 清空标签，正常接受 project_memory。
  return commitResult('none');
}

/** 日志辅助：标签长度（不打印标签内容）。 */
export function divergenceTagLength(divergence) {
  return divergence !== null && typeof divergence === 'object' && typeof divergence.tag === 'string'
    ? codePointLength(divergence.tag)
    : 0;
}
