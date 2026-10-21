/**
 * turn.js — 从 Session 事件里收集「某个回合」的用户/助手文本，以及回合筛选纯函数。
 *
 * Session 事件形态以 dsh-session d.ts / e2e 实测为准（spec-impl.md §4）：
 *  - `turn/start` 的 data 为 `{ turn }`；`turn/end` 的 data 为 `{ turn, reason }`；
 *  - `assistant/message` 的 data 是 `{ turn, step, message: AssistantMessage, ... }`；
 *  - **`user/message` 的 data 是 UserMessage（`{ role, content, source, id }`），
 *    没有 `data.turn` / `data.step`**（e2e 实测 dataKeys=content,source,role,id）；
 *  - `tool/call` / `tool/result` 不含模型可见文本，全部跳过；只取 content 里的 text block。
 *
 * 因此回合归属必须按事件顺序推导：`turn/start` 更新 currentTurn、`turn/end` 清空；
 * 有 `data.turn` 的事件用它自己的，`user/message` 没有时用 currentTurn。否则真人
 * 用户输入会被 100% 跳过（e2e bug #2：分析输入只剩「助手：」）。
 *
 * 本模块零依赖、纯函数；`collectTurnText` 只读取 session 的公开方法。
 */
import {
  DEFAULT_HEAD_CHARS,
  codePointLength,
  truncateMiddle,
} from './text.js';

/** 一条消息 content 里的纯文本（跳过 tool-call / reasoning / image 等块）。 */
export function messageText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/**
 * 收集某回合的 user / assistant 文本。
 * user 优先只取真人直接输入（`source.kind === 'user'`）；若该回合没有真人消息
 * （goal 续跑等），回退到该回合全部 user-role 消息，避免整回合丢失。
 *
 * @param {readonly object[]} events - session.snapshotEvents() 结果
 * @param {number} turn
 * @returns {{user:string[], assistant:string[]}}
 */
export function collectTurnParts(events, turn) {
  const user = [];
  const injectedUser = [];
  const assistant = [];
  if (!Array.isArray(events)) return { user, assistant };
  /** 当前所处回合：turn/start 写入、turn/end 清空；仅用于没有 data.turn 的事件。 */
  let currentTurn;
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    const type = event.type;
    const data = event.data;
    if (data === null || typeof data !== 'object') continue;

    if (type === 'turn/start') {
      if (typeof data.turn === 'number' && Number.isFinite(data.turn)) currentTurn = data.turn;
      continue;
    }
    if (type === 'turn/end') {
      // 回合边界：其后的无 turn 事件不再归属刚才那个回合。
      currentTurn = undefined;
      continue;
    }

    // 有 data.turn 的事件（assistant/message、tool/call、tool/result…）优先用它自己的；
    // user/message 在 0.2.1-rc.2 没有 data.turn，用最近的 turn/start 推导出的 currentTurn。
    const eventTurn = typeof data.turn === 'number' && Number.isFinite(data.turn) ? data.turn : currentTurn;
    if (eventTurn !== turn) continue;

    if (type === 'assistant/message') {
      const text = messageText(data.message?.content);
      if (text.trim() !== '') assistant.push(text);
      continue;
    }
    if (type === 'user/message') {
      const text = messageText(data.content);
      if (text.trim() === '') continue;
      if (data.source?.kind === 'user') user.push(text);
      else injectedUser.push(text);
    }
  }
  return { user: user.length > 0 ? user : injectedUser, assistant };
}

/** 把 user/assistant 文本拼成注入分析提示词的「最新对话」正文。 */
export function composeTurnText(userTexts, assistantTexts) {
  const parts = [];
  if (Array.isArray(userTexts) && userTexts.length > 0) {
    parts.push('用户：' + userTexts.join('\n'));
  }
  if (Array.isArray(assistantTexts) && assistantTexts.length > 0) {
    parts.push('助手：' + assistantTexts.join('\n'));
  }
  return parts.join('\n\n');
}

/**
 * 判断一个 session/event 是否应触发后台分析（spec-impl.md §4）：
 * `turn/end` + reason.kind === 'completed' + 非 subagent。
 * @param {{type?:string, data?:object}|null|undefined} event
 * @param {{origin?:string, delegationDepth?:number}|null|undefined} header - session.header
 */
export function shouldAnalyzeEvent(event, header) {
  if (event === null || typeof event !== 'object' || event.type !== 'turn/end') return false;
  const data = event.data;
  if (data === null || typeof data !== 'object') return false;
  if (data.reason?.kind !== 'completed') return false;
  if (typeof data.turn !== 'number' || !Number.isFinite(data.turn)) return false;
  if (header !== null && typeof header === 'object') {
    if (header.origin === 'subagent') return false;
    if ((header.delegationDepth ?? 0) > 0) return false;
  }
  return true;
}

/**
 * 从 Session 快照收集某回合文本并按 maxInputChars 做「头 + 尾」截断。
 * 读事件失败时返回空串（绝不阻塞/抛给事件的其它监听者）。
 *
 * @param {object} session - Session 实例（需有 snapshotEvents()）
 * @param {number} turn
 * @param {{maxInputChars?:number, headChars?:number}} [options]
 * @returns {string}
 */
export function collectTurnText(session, turn, options = {}) {
  let events = [];
  try {
    if (session !== null && typeof session === 'object' && typeof session.snapshotEvents === 'function') {
      events = session.snapshotEvents() ?? [];
    }
  } catch {
    events = [];
  }
  const parts = collectTurnParts(events, turn);
  const raw = composeTurnText(parts.user, parts.assistant);
  const maxInputChars = typeof options.maxInputChars === 'number' ? options.maxInputChars : 4000;
  return truncateMiddle(raw, maxInputChars, options.headChars ?? DEFAULT_HEAD_CHARS);
}

/** 回合文本的码点长度（日志用，不打印内容）。 */
export function turnTextLength(text) {
  return codePointLength(text);
}
