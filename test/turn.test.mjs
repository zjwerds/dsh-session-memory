import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectTurnParts,
  collectTurnText,
  composeTurnText,
  messageText,
  shouldAnalyzeEvent,
  turnTextLength,
} from '../lib/turn.js';
import { codePointLength } from '../lib/text.js';

/**
 * 真实 DSH 0.2.1-rc.2 形状：user/message 的 data 只有 { role, content, source, id }，
 * **没有 turn/step**（e2e 实测 dataKeys=content,source,role,id）。这里默认不写 turn，
 * 需要显式 data.turn 的边缘用例再传 explicitTurn。
 */
function userMessage(blocks, sourceKind = 'user', explicitTurn) {
  const data = { role: 'user', id: `msg-${Math.random().toString(36).slice(2, 8)}`, content: blocks, source: { kind: sourceKind } };
  if (typeof explicitTurn === 'number') data.turn = explicitTurn;
  return { type: 'user/message', seq: 0, time: 0, data };
}

function assistantMessage(turn, blocks) {
  return {
    type: 'assistant/message',
    seq: 0,
    time: 0,
    data: { turn, step: 1, message: { role: 'assistant', content: blocks }, stream: [] },
  };
}

function turnStart(turn) {
  return { type: 'turn/start', data: { turn } };
}

function turnEnd(turn) {
  return { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } };
}

/** 两回合真实形状快照：turn1 普通对话，turn2 带 image/tool/skill-catalog。 */
function turnFixture() {
  return [
    turnStart(1),
    userMessage([{ type: 'text', text: '上一轮的提问' }]),
    assistantMessage(1, [{ type: 'text', text: '上一轮的回答' }]),
    turnEnd(1),
    turnStart(2),
    userMessage([
      { type: 'text', text: '记住：先做 MVP' },
      { type: 'image', attachment: { id: 'img' } },
    ]),
    assistantMessage(2, [
      { type: 'text', text: '好的' },
      { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"x"}' },
    ]),
    { type: 'tool/call', data: { turn: 2, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"x"}' } },
    {
      type: 'tool/result',
      data: {
        turn: 2,
        step: 1,
        message: { role: 'tool', content: [{ type: 'text', text: '工具输出不应进入分析输入' }] },
      },
    },
    userMessage([{ type: 'text', text: '<skill catalog> 不应进入分析输入' }], 'skill-catalog'),
    turnEnd(2),
  ];
}

test('messageText: 只取 text block，跳过 tool-call/reasoning/image', () => {
  assert.equal(messageText([
    { type: 'text', text: 'A' },
    { type: 'reasoning', text: '不该出现' },
    { type: 'tool-call', id: 'x', name: 'y', arguments: '{}' },
    { type: 'text', text: 'B' },
  ]), 'A\nB');
  assert.equal(messageText(null), '');
  assert.equal(messageText([{ type: 'text', text: 42 }]), '');
});

test('collectTurnParts: 真实快照（user/message 无 turn）按 turn/start~turn/end 归属', () => {
  const events = turnFixture();
  // 回归锚点：user/message 的 data 确实没有 turn 字段（e2e 实测形状）。
  assert.equal(Object.hasOwn(events[1].data, 'turn'), false);
  assert.equal(Object.hasOwn(events[5].data, 'turn'), false);

  const parts = collectTurnParts(events, 2);
  assert.deepEqual(parts.user, ['记住：先做 MVP']);
  assert.deepEqual(parts.assistant, ['好的']);
  assert.equal(JSON.stringify(parts).includes('工具输出'), false);
  assert.equal(JSON.stringify(parts).includes('skill catalog'), false);
  assert.equal(JSON.stringify(parts).includes('上一轮的提问'), false);
});

test('collectTurnParts: 两回合连续快照只取目标回合，前回合 user 不混入', () => {
  const events = turnFixture();
  const first = collectTurnParts(events, 1);
  assert.deepEqual(first.user, ['上一轮的提问']);
  assert.deepEqual(first.assistant, ['上一轮的回答']);

  const second = collectTurnParts(events, 2);
  assert.deepEqual(second.user, ['记住：先做 MVP']);
  assert.equal(second.user.includes('上一轮的提问'), false);
  assert.equal(second.assistant.includes('上一轮的回答'), false);
});

test('collectTurnParts: 有 data.turn 的事件优先用它自己的 turn', () => {
  // turn/start(2) 之后出现的 user/message 若自带 data.turn:1，应归到 turn1 而不是 currentTurn=2。
  const events = [
    turnStart(2),
    userMessage([{ type: 'text', text: '显式 turn 优先' }], 'user', 1),
    turnEnd(2),
  ];
  assert.deepEqual(collectTurnParts(events, 1).user, ['显式 turn 优先']);
  assert.deepEqual(collectTurnParts(events, 2).user, []);
});

test('collectTurnParts: turn/end 之后的无 turn user/message 不归属本回合', () => {
  const events = [
    turnStart(1),
    turnEnd(1),
    userMessage([{ type: 'text', text: '回合外的消息' }]),
  ];
  assert.deepEqual(collectTurnParts(events, 1).user, []);
});

test('collectTurnParts: 没有真人消息时回退到该回合全部 user-role 文本', () => {
  const events = [
    turnStart(3),
    userMessage([{ type: 'text', text: '<goal continuation>' }], 'goal'),
    turnEnd(3),
  ];
  assert.deepEqual(collectTurnParts(events, 3).user, ['<goal continuation>']);
});

test('collectTurnParts: 坏输入/无匹配 turn 返回空', () => {
  assert.deepEqual(collectTurnParts(null, 1), { user: [], assistant: [] });
  assert.deepEqual(collectTurnParts([], 1), { user: [], assistant: [] });
  const parts = collectTurnParts(turnFixture(), 99);
  assert.deepEqual(parts, { user: [], assistant: [] });
});

test('composeTurnText: 用户/助手标签与空段省略', () => {
  assert.equal(composeTurnText(['A'], ['B']), '用户：A\n\n助手：B');
  assert.equal(composeTurnText([], ['B']), '助手：B');
  assert.equal(composeTurnText(['A'], []), '用户：A');
  assert.equal(composeTurnText([], []), '');
});

test('shouldAnalyzeEvent: 仅 completed + 非 subagent 的 turn/end 触发', () => {
  const completed = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } };
  assert.equal(shouldAnalyzeEvent(completed, {}), true);
  for (const kind of ['aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']) {
    const event = { type: 'turn/end', data: { turn: 1, reason: { kind } } };
    assert.equal(shouldAnalyzeEvent(event, {}), false, `reason=${kind} 不分析`);
  }
  assert.equal(shouldAnalyzeEvent(completed, { origin: 'subagent' }), false);
  assert.equal(shouldAnalyzeEvent(completed, { delegationDepth: 2 }), false);
  assert.equal(shouldAnalyzeEvent(completed, { delegationDepth: 0, origin: undefined }), true);
  assert.equal(shouldAnalyzeEvent({ type: 'assistant/message', data: { turn: 1 } }, {}), false);
  assert.equal(shouldAnalyzeEvent(null, {}), false);
  assert.equal(shouldAnalyzeEvent(completed, null), true);
});

test('collectTurnText: user/message 无 data.turn 的会话快照必须包含用户文本（e2e bug #2 回归）', () => {
  const events = [
    turnStart(1),
    userMessage([{ type: 'text', text: '账号 alice，密码 Pa55w0rd，记到长期记忆' }]),
    assistantMessage(1, [{ type: 'text', text: '已记录' }]),
    turnEnd(1),
  ];
  const session = { snapshotEvents: () => events };
  const text = collectTurnText(session, 1, { maxInputChars: 4000 });
  assert.ok(text.startsWith('用户：账号 alice'), `期望以「用户：」开头，实际=${text.slice(0, 20)}`);
  assert.ok(text.includes('密码 Pa55w0rd'));
  assert.ok(text.includes('助手：已记录'));
});

test('collectTurnText: 从 session 快照拼文本、坏 session 返回空串', () => {
  const session = { snapshotEvents: () => turnFixture() };
  const text = collectTurnText(session, 2, { maxInputChars: 4000 });
  assert.ok(text.includes('用户：记住：先做 MVP'));
  assert.ok(text.includes('助手：好的'));
  assert.equal(text.includes('工具输出'), false);
  assert.equal(text.includes('上一轮的提问'), false);
  assert.equal(turnTextLength(text), codePointLength(text));

  const broken = {
    snapshotEvents() {
      throw new Error('boom');
    },
  };
  assert.equal(collectTurnText(broken, 2), '');
  assert.equal(collectTurnText(null, 2), '');
});

test('collectTurnText: maxInputChars 截断保留头 1500 + 尾部', () => {
  const longText = '头'.repeat(1500) + '中'.repeat(3000) + '尾'.repeat(800);
  const events = [
    turnStart(9),
    userMessage([{ type: 'text', text: longText }]),
    turnEnd(9),
  ];
  const cut = collectTurnText({ snapshotEvents: () => events }, 9, { maxInputChars: 4000 });
  assert.ok(codePointLength(cut) <= 4000);
  assert.ok(cut.startsWith('用户：头'));
  assert.ok(cut.endsWith('尾'));
  assert.ok(cut.includes('中间内容已截断'));
});
