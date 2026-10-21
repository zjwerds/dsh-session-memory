/**
 * index.test.mjs — apply() 的接线级冒烟测试（不需要真实 DSH）：
 * 用最小 fake ctx 验证注册面（sections/tools/guard/skills/listener）、
 * turn/end → 一次 LLM 调用 → 项目记忆 + 长期记忆落盘 → 注入/护栏/工具生效。
 *
 * 目的：在不装 probe/桌面的前提下，把「规格 §4-§8 的链路」整条走一遍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GUARD_DENY_REASON, GUARD_DENY_REASON_NETWORK } from '../lib/guard.js';
import { apply, inject, name } from '../lib/index.js';
import { codePointLength } from '../lib/text.js';

const FAKE_SECRET = 'svc:alice/Pa55w0rd';
const FAKE_IDENTITY = '称呼：小王；职业：前端工程师';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-session-memory-index-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createFakeCtx() {
  const state = {
    sections: [],
    tools: new Map(),
    guards: [],
    skills: new Map(),
    skillRegistrations: 0,
    listeners: new Map(),
    llmCalls: [],
    llmResponse: '{"project_memory":[],"identity":{"action":"none"},"credentials":{"action":"none"}}',
    /** 每次 stream 调用的脚本：{ text?, finish?, error? }；耗尽后回退 llmResponse。 */
    llmPlan: [],
  };
  const ctx = {
    effect(fn) {
      const dispose = fn();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    on(event, handler) {
      const list = state.listeners.get(event) ?? [];
      list.push(handler);
      state.listeners.set(event, list);
      return () => {};
    },
    systemPrompt: {
      section(section) {
        state.sections.push(section);
        return () => {};
      },
    },
    tools: {
      register(definition) {
        state.tools.set(definition.name, definition);
        return () => state.tools.delete(definition.name);
      },
      guard(guard) {
        state.guards.push(guard);
        return () => {};
      },
    },
    skills: {
      register(skill) {
        state.skillRegistrations += 1;
        state.skills.set(skill.name, skill);
        return () => state.skills.delete(skill.name);
      },
    },
    llm: {
      stream(options) {
        state.llmCalls.push(options);
        const plan = state.llmPlan.length > 0 ? state.llmPlan.shift() : { text: state.llmResponse };
        return (async function* fakeStream() {
          if (plan.error) throw plan.error;
          if (typeof plan.text === 'string' && plan.text !== '') {
            yield { type: 'text-delta', index: 0, text: plan.text };
          }
          yield { type: 'finish', reason: { kind: plan.finish ?? 'stop' } };
        })();
      },
    },
  };
  return { ctx, state };
}

function emit(state, session, event) {
  for (const handler of state.listeners.get('session/event') ?? []) handler(session, event);
}

function completedEvent(turn) {
  return { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } };
}

function makeSession({ id = 'sess-1', turn = 1, text = '记住：先做 MVP，账号 alice，密码 Pa55w0rd' } = {}) {
  return {
    id,
    header: { cwd: 'C:/work' },
    requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }),
    // 真实 rc.2 形状：user/message 没有 data.turn；回合归属靠 turn/start～turn/end。
    snapshotEvents: () => [
      { type: 'turn/start', seq: 0, time: 0, data: { turn } },
      {
        type: 'user/message',
        seq: 1,
        time: 0,
        data: { role: 'user', id: 'msg-1', content: [{ type: 'text', text }], source: { kind: 'user' } },
      },
      {
        type: 'assistant/message',
        seq: 2,
        time: 0,
        data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] }, stream: [] },
      },
      { type: 'turn/end', seq: 3, time: 0, data: { turn, reason: { kind: 'completed' } } },
    ],
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timeout');
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

test('apply: 注册 4 个 section（156/157/160/161）、两个工具、guard、user-profile skill，注入初始为空', (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  apply(ctx, { dataDir: dir });

  assert.equal(name, 'dsh-session-memory');
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'llm', 'skills']);

  assert.equal(state.sections.length, 4);
  assert.deepEqual(state.sections.map((section) => section.order), [156, 157, 160, 161]);
  const [identitySection, habitsSection, projectSection, rulesSection] = state.sections;
  assert.equal(identitySection.name, 'plugin:session-memory-identity');
  assert.equal(habitsSection.name, 'plugin:session-memory-habits');
  assert.equal(projectSection.name, 'plugin:session-memory');
  assert.equal(projectSection.order, 160);
  assert.equal(projectSection.interpolate, false);
  assert.equal(typeof projectSection.text, 'function');
  assert.equal(rulesSection.name, 'plugin:session-memory-rules');
  assert.equal(rulesSection.order, 161);
  assert.equal(rulesSection.interpolate, false);
  assert.ok(rulesSection.text.includes('vault_read'));
  assert.ok(rulesSection.text.includes('允许在本机使用'));
  assert.ok(rulesSection.text.includes('账号密码等隐私信息不自动注入'));

  assert.deepEqual([...state.tools.keys()].sort(), ['session_memory_read', 'vault_read']);
  assert.equal(state.guards.length, 1);
  assert.ok(state.skills.has('user-profile'), 'skill 名 user-profile');
  assert.equal(state.skillRegistrations, 1, 'apply 时只注册一次 skill');
  assert.ok(state.listeners.get('session/event').length >= 1);

  // 空 vault：身份/习惯/项目记忆 section 都返回 ''（不产生空注入段）
  assert.equal(identitySection.text(), '');
  assert.equal(habitsSection.text(), '');
  assert.equal(projectSection.text({ agent: { session: { id: 'sess-1' } } }), '');
  assert.equal(projectSection.text({}), '');
});

test('apply: 一个 completed 回合 → 一次 LLM 调用 → 身份/习惯/项目记忆注入 + vault v3 落盘 + guard/工具生效', async (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  state.llmResponse = JSON.stringify({
    project_memory: ['决定：先做 MVP', '待办：验证 e2e'],
    identity: { action: 'set', text: FAKE_IDENTITY, reason: '从对话推断身份' },
    habits: { action: 'set', items: ['偏好中文', '先方案后动手'], reason: '用户偏好' },
    credentials: { action: 'set', text: FAKE_SECRET, reason: '用户提供了账号密码' },
  });
  apply(ctx, { dataDir: dir });
  const sectionByName = (sectionName) => state.sections.find((section) => section.name === sectionName);
  const identitySection = sectionByName('plugin:session-memory-identity');
  const habitsSection = sectionByName('plugin:session-memory-habits');
  const projectSection = sectionByName('plugin:session-memory');
  const rulesSection = sectionByName('plugin:session-memory-rules');
  assert.deepEqual([identitySection.order, habitsSection.order, projectSection.order, rulesSection.order], [156, 157, 160, 161]);

  emit(state, makeSession(), completedEvent(1));
  await waitFor(() => projectSection.text({ agent: { session: { id: 'sess-1' } } }).includes('决定：先做 MVP'));
  await waitFor(() => readJson(join(dir, 'vault.json'))?.credentials === FAKE_SECRET);

  assert.equal(state.llmCalls.length, 1);
  const call = state.llmCalls[0];
  assert.equal(call.provider, 'test-provider');
  assert.equal(call.model, 'test-model');
  assert.equal(call.maxTokens, 400);
  assert.equal(call.reasoningEffort, 'off', '默认必须关 thinking，否则 400 token 被 thinking_delta 吃光');
  assert.ok(call.signal instanceof AbortSignal);
  assert.equal(call.messages.length, 1);
  assert.equal(call.messages[0].role, 'user');
  const promptText = call.messages[0].content[0].text;
  assert.ok(promptText.includes('当前项目记忆'));
  assert.ok(promptText.includes('当前用户身份'));
  assert.ok(promptText.includes('当前用户习惯'));
  assert.ok(promptText.includes('当前账号密码'));
  assert.ok(promptText.includes('最新对话'));
  assert.ok(promptText.includes('divergence'));

  const sessionFile = readJson(join(dir, 'session-memory.json'));
  assert.equal(sessionFile.sessions['sess-1'].cwd, 'C:/work');
  assert.equal(
    sessionFile.sessions['sess-1'].chars,
    codePointLength('决定：先做 MVP') + codePointLength('待办：验证 e2e'),
  );
  assert.equal(sessionFile.sessions['sess-1'].divergence, null, 'status 缺失 → none → 无标签');
  const vaultFile = readJson(join(dir, 'vault.json'));
  assert.equal(vaultFile.version, 3);
  assert.equal(vaultFile.identity, FAKE_IDENTITY);
  assert.deepEqual(vaultFile.habits, ['偏好中文', '先方案后动手']);
  assert.equal(vaultFile.credentials, FAKE_SECRET);
  assert.equal(vaultFile.history.length, 1);
  assert.deepEqual(vaultFile.history[0].prev, { identity: '', habits: [], credentials: '' });
  assert.deepEqual(vaultFile.history[0].next, {
    identity: FAKE_IDENTITY,
    habits: ['偏好中文', '先方案后动手'],
    credentials: FAKE_SECRET,
  });
  assert.equal(vaultFile.history[0].reason, '从对话推断身份');
  assert.equal(vaultFile.history[0].sessionId, 'sess-1');
  assert.equal(vaultFile.history[0].turn, 1);

  // 注入顺序：身份 156 → 习惯 157 → 项目记忆 160 → 规则 161；credentials 绝不注入。
  const identityText = identitySection.text();
  const habitsText = habitsSection.text();
  const sectionText = projectSection.text({ agent: { session: { id: 'sess-1' } } });
  const rulesText = rulesSection.text;
  assert.ok(identityText.startsWith('## 用户身份（自动注入）'));
  assert.ok(identityText.includes(FAKE_IDENTITY));
  assert.ok(habitsText.startsWith('## 用户习惯（自动注入）'));
  assert.ok(habitsText.includes('- 偏好中文'));
  assert.ok(sectionText.startsWith('## 本对话项目记忆'));
  assert.ok(sectionText.includes('- 决定：先做 MVP'));
  for (const injected of [identityText, habitsText, sectionText, rulesText]) {
    assert.equal(injected.includes(FAKE_SECRET), false, 'credentials 绝不注入');
  }
  // 身份/习惯本身会注入，但不了泄露到项目记忆注入段。
  assert.equal(sectionText.includes(FAKE_IDENTITY), false);

  assert.equal(state.skills.get('user-profile').content.includes(FAKE_SECRET), false);
  // R3：skill 只在 apply 时注册一次、正文静态；vault 写入后不再 dispose+register。
  assert.equal(state.skillRegistrations, 1, 'vault 写入后不得重注册 skill');
  assert.ok(state.skills.get('user-profile').content.includes('vault_read'));
  assert.ok(state.skills.get('user-profile').content.includes('scope'));
  assert.equal(state.skills.get('user-profile').content.includes('非空'), false, 'skill 正文不含运行期状态');

  // guard balanced：本地工具放行（用户可能正需要密码）；网络/对外工具拦。
  assert.equal(
    state.guards[0]({ name: 'pwsh', arguments: { command: `echo ${FAKE_SECRET}` } }),
    undefined,
    'balanced 下本地工具放行',
  );
  const denyReason = state.guards[0]({ name: 'web_search', arguments: { query: FAKE_SECRET } });
  assert.equal(denyReason, GUARD_DENY_REASON_NETWORK);
  assert.equal(denyReason.includes(FAKE_SECRET), false);
  assert.equal(state.guards[0]({ name: 'web_search', arguments: { query: 'git status' } }), undefined);

  // vault_read：scope all/identity/habits/credentials，各字段 <vault_secret> 包裹。
  const vaultValue = await state.tools.get('vault_read').execute({ query: '小王' }, {});
  assert.deepEqual(vaultValue, {
    scope: 'all',
    identity: `<vault_secret>${FAKE_IDENTITY}</vault_secret>`,
    habits: '<vault_secret>偏好中文；先方案后动手</vault_secret>',
    credentials: `<vault_secret>${FAKE_SECRET}</vault_secret>`,
    matched: true,
  });
  const identityValue = await state.tools.get('vault_read').execute({ scope: 'identity' }, {});
  assert.deepEqual(identityValue, { scope: 'identity', identity: `<vault_secret>${FAKE_IDENTITY}</vault_secret>` });
  const habitsValue = await state.tools.get('vault_read').execute({ scope: 'habits' }, {});
  assert.deepEqual(habitsValue, { scope: 'habits', habits: '<vault_secret>偏好中文；先方案后动手</vault_secret>' });
  const credentialsValue = await state.tools.get('vault_read').execute({ scope: 'credentials' }, {});
  assert.deepEqual(credentialsValue, { scope: 'credentials', credentials: `<vault_secret>${FAKE_SECRET}</vault_secret>` });

  const sessionValue = await state.tools.get('session_memory_read').execute({}, { agent: { session: { id: 'sess-1' } } });
  assert.deepEqual(sessionValue.entries, ['决定：先做 MVP', '待办：验证 e2e']);
  const allValue = await state.tools.get('session_memory_read').execute({ all: true }, {});
  assert.equal(allValue.count, 1);
});

test('apply: analysisReasoningEffort 默认 off；null/空串不传该字段；显式值透传', async (t) => {
  const cases = [
    { name: 'default', config: {}, expected: 'off' },
    { name: 'null', config: { analysisReasoningEffort: null }, expected: undefined },
    { name: 'empty', config: { analysisReasoningEffort: '' }, expected: undefined },
    { name: 'high', config: { analysisReasoningEffort: 'high' }, expected: 'high' },
  ];
  for (const item of cases) {
    const dir = tempDir(t);
    const { ctx, state } = createFakeCtx();
    state.llmResponse = JSON.stringify({ project_memory: ['条目'], longterm: { action: 'none' } });
    apply(ctx, { dataDir: dir, ...item.config });
    emit(state, makeSession({ id: `sess-${item.name}`, turn: 1 }), completedEvent(1));
    await waitFor(() => state.llmCalls.length === 1);
    const call = state.llmCalls[0];
    if (item.expected === undefined) {
      assert.equal(Object.hasOwn(call, 'reasoningEffort'), false, `${item.name}: 不应带 reasoningEffort`);
    } else {
      assert.equal(call.reasoningEffort, item.expected, `${item.name}: reasoningEffort 透传`);
    }
  }
});

test('apply: reasoningEffort 被适配器拒绝（INVALID_REASONING_EFFORT）→ 去掉该字段重试一次并成功', async (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  const rejection = Object.assign(new Error('provider "test-provider" model "test-model" does not support reasoning effort "off"'), {
    code: 'INVALID_REASONING_EFFORT',
  });
  state.llmPlan.push(
    { error: rejection },
    { text: JSON.stringify({ project_memory: ['重试后的条目'], longterm: { action: 'none' } }) },
  );
  apply(ctx, { dataDir: dir });
  const projectSection = state.sections.find((section) => section.name === 'plugin:session-memory');

  emit(state, makeSession({ turn: 1, text: '记住：重试后条目' }), completedEvent(1));
  await waitFor(() => projectSection.text({ agent: { session: { id: 'sess-1' } } }).includes('重试后的条目'));

  assert.equal(state.llmCalls.length, 2, '只重试一次');
  assert.equal(state.llmCalls[0].reasoningEffort, 'off');
  assert.equal(Object.hasOwn(state.llmCalls[1], 'reasoningEffort'), false, '第二次不带 reasoningEffort');
  const file = readJson(join(dir, 'session-memory.json'));
  assert.deepEqual(file.sessions['sess-1'].entries.map((entry) => entry.text), ['重试后的条目']);
});

test('apply: 首轮无文本且 finish=max-tokens → 放大 maxTokens 重试一次（保留 effort）', async (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  state.llmPlan.push(
    { text: '', finish: 'max-tokens' },
    { text: JSON.stringify({ project_memory: ['放大预算后的条目'], longterm: { action: 'none' } }) },
  );
  apply(ctx, { dataDir: dir });
  const projectSection = state.sections.find((section) => section.name === 'plugin:session-memory');

  emit(state, makeSession({ turn: 1, text: '记住：放大预算' }), completedEvent(1));
  await waitFor(() => projectSection.text({ agent: { session: { id: 'sess-1' } } }).includes('放大预算后的条目'));

  assert.equal(state.llmCalls.length, 2, '只重试一次');
  assert.equal(state.llmCalls[0].maxTokens, 400);
  assert.equal(state.llmCalls[1].maxTokens, 2000);
  assert.equal(state.llmCalls[1].reasoningEffort, 'off', '重试仍保持关闭 thinking');
  const file = readJson(join(dir, 'session-memory.json'));
  assert.deepEqual(file.sessions['sess-1'].entries.map((entry) => entry.text), ['放大预算后的条目']);
});

test('apply: 非 completed / subagent / 空回合不发起 LLM 调用', async (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  apply(ctx, { dataDir: dir });

  emit(state, makeSession(), { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } });
  emit(state, { ...makeSession(), id: 'sub-1', header: { origin: 'subagent', cwd: 'C:/w' } }, completedEvent(1));
  emit(state, { ...makeSession(), id: 'sess-empty', snapshotEvents: () => [] }, completedEvent(1));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(state.llmCalls.length, 0);
  assert.equal(existsSync(join(dir, 'session-memory.json')), false);
  assert.equal(existsSync(join(dir, 'vault.json')), false);
});

test('apply: 同一 turn 的重复事件不会重复调用模型（每回合最多一次）', async (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  state.llmResponse = JSON.stringify({ project_memory: ['条目'], longterm: { action: 'none' } });
  apply(ctx, { dataDir: dir });
  const session = makeSession({ turn: 1 });
  emit(state, session, completedEvent(1));
  emit(state, session, completedEvent(1));
  await waitFor(() => state.llmCalls.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(state.llmCalls.length, 1);
});

test('apply: 模型输出坏 JSON → 放弃本回合、旧记忆不被破坏、vault 不变', async (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  state.llmResponse = JSON.stringify({
    project_memory: ['决定：保留的旧条目'],
    longterm: { action: 'none' },
  });
  apply(ctx, { dataDir: dir });
  const projectSection = state.sections.find((section) => section.name === 'plugin:session-memory');

  emit(state, makeSession({ turn: 1, text: '记住：保留的旧条目' }), completedEvent(1));
  await waitFor(() => projectSection.text({ agent: { session: { id: 'sess-1' } } }).includes('决定：保留的旧条目'));
  const firstFile = readJson(join(dir, 'session-memory.json'));
  assert.equal(firstFile.sessions['sess-1'].entries[0].text, '决定：保留的旧条目');

  state.llmResponse = '这不是 JSON';
  emit(state, makeSession({ turn: 2, text: '第二个回合' }), completedEvent(2));
  await waitFor(() => state.llmCalls.length >= 2);
  await new Promise((resolve) => setTimeout(resolve, 120));

  // R5：坏 JSON 会用同 prompt 追加提示重试一次；两次都失败才放弃。
  assert.equal(state.llmCalls.length, 3, '首轮 + 一次解析重试');
  assert.ok(state.llmCalls[2].messages[0].content[0].text.includes('只输出一行 JSON，不要解释'));

  const secondFile = readJson(join(dir, 'session-memory.json'));
  assert.deepEqual(secondFile.sessions['sess-1'].entries.map((entry) => entry.text), ['决定：保留的旧条目']);
  assert.equal(existsSync(join(dir, 'vault.json')), false);
});

test('apply: 模型给空项目记忆数组 → 保留旧记忆不动；longterm none 不写 vault', async (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  state.llmResponse = JSON.stringify({
    project_memory: ['条目甲'],
    longterm: { action: 'none' },
  });
  apply(ctx, { dataDir: dir });
  const projectSection = state.sections.find((section) => section.name === 'plugin:session-memory');

  emit(state, makeSession({ turn: 1, text: '第一回合' }), completedEvent(1));
  await waitFor(() => projectSection.text({ agent: { session: { id: 'sess-1' } } }).includes('条目甲'));

  state.llmResponse = JSON.stringify({ project_memory: [], longterm: { action: 'none' } });
  emit(state, makeSession({ turn: 2, text: '第二回合' }), completedEvent(2));
  await waitFor(() => state.llmCalls.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const file = readJson(join(dir, 'session-memory.json'));
  assert.deepEqual(file.sessions['sess-1'].entries.map((entry) => entry.text), ['条目甲']);
  assert.equal(existsSync(join(dir, 'vault.json')), false);
});

test('apply: R1 密码/账号写进 project memory → 条目被丢弃；全被过滤时保留旧记忆', async (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  state.llmResponse = JSON.stringify({
    project_memory: ['旧条目：先做 MVP'],
    longterm: { action: 'set', text: '测试账号:testuser/TestPass123', reason: '用户提供' },
  });
  apply(ctx, { dataDir: dir });
  const projectSection = state.sections.find((section) => section.name === 'plugin:session-memory');

  emit(state, makeSession({ turn: 1, text: '账号 testuser 密码 TestPass123，记到长期记忆' }), completedEvent(1));
  await waitFor(() => projectSection.text({ agent: { session: { id: 'sess-1' } } }).includes('旧条目'));
  await waitFor(() => readJson(join(dir, 'vault.json'))?.credentials === '测试账号:testuser/TestPass123');

  // 第 2 回合：模型把密码/账号写进 project_memory → 全部被过滤 → 保留旧记忆，不覆盖为空。
  state.llmResponse = JSON.stringify({
    project_memory: ['TestPass123 已泄露，建议轮换密码', '账号 testuser 已验证'],
    longterm: { action: 'none' },
  });
  emit(state, makeSession({ turn: 2, text: '第二回合' }), completedEvent(2));
  await waitFor(() => state.llmCalls.length >= 2);
  await new Promise((resolve) => setTimeout(resolve, 120));

  const afterSecond = readJson(join(dir, 'session-memory.json'));
  assert.deepEqual(
    afterSecond.sessions['sess-1'].entries.map((entry) => entry.text),
    ['旧条目：先做 MVP'],
    '过滤后为空 → 保留旧记忆',
  );
  const sectionAfterSecond = projectSection.text({ agent: { session: { id: 'sess-1' } } });
  assert.equal(sectionAfterSecond.includes('TestPass123'), false, '注入段不得出现密码片段');

  // 第 3 回合：混合列表 → 只保留正常条目，含密码的条目被丢弃。
  state.llmResponse = JSON.stringify({
    project_memory: ['正常待办：写 README', '密码 TestPass123'],
    longterm: { action: 'none' },
  });
  emit(state, makeSession({ turn: 3, text: '第三回合' }), completedEvent(3));
  await waitFor(() => projectSection.text({ agent: { session: { id: 'sess-1' } } }).includes('正常待办：写 README'));
  const afterThird = readJson(join(dir, 'session-memory.json'));
  assert.deepEqual(afterThird.sessions['sess-1'].entries.map((entry) => entry.text), ['正常待办：写 README']);
  assert.equal(projectSection.text({ agent: { session: { id: 'sess-1' } } }).includes('TestPass123'), false);
});

test('apply: R5 解析失败 → 同 prompt 追加指令重试一次并成功落盘', async (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  state.llmPlan.push(
    { text: '这不是 JSON，只是解释' },
    { text: JSON.stringify({ project_memory: ['解析重试成功条目'], longterm: { action: 'none' } }) },
  );
  apply(ctx, { dataDir: dir });
  const projectSection = state.sections.find((section) => section.name === 'plugin:session-memory');

  emit(state, makeSession({ turn: 1, text: '第一回合' }), completedEvent(1));
  await waitFor(() => projectSection.text({ agent: { session: { id: 'sess-1' } } }).includes('解析重试成功条目'));

  assert.equal(state.llmCalls.length, 2, '首轮 + 一次解析重试');
  const retryPrompt = state.llmCalls[1].messages[0].content[0].text;
  assert.ok(retryPrompt.includes('只输出一行 JSON，不要解释'));
  assert.ok(retryPrompt.includes('最新对话'), '原 prompt 内容保留');
  const file = readJson(join(dir, 'session-memory.json'));
  assert.deepEqual(file.sessions['sess-1'].entries.map((entry) => entry.text), ['解析重试成功条目']);
});

test('apply: task-10 密码从未进 vault（longterm.action=none）→ 凭据形态检测仍拦下 project memory', async (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  // 本回合 longterm=none：vault 为空，vault 片段过滤没有可过滤片段（R1 最后边界）。
  state.llmResponse = JSON.stringify({
    project_memory: ['密码：TestPass123 已泄露，建议轮换', '决定：先做 MVP', 'NewPass456'],
    longterm: { action: 'none' },
  });
  apply(ctx, { dataDir: dir });
  const projectSection = state.sections.find((section) => section.name === 'plugin:session-memory');

  emit(state, makeSession({ turn: 1, text: '我的密码是 TestPass123' }), completedEvent(1));
  await waitFor(() => projectSection.text({ agent: { session: { id: 'sess-1' } } }).includes('决定：先做 MVP'));

  const file = readJson(join(dir, 'session-memory.json'));
  assert.deepEqual(
    file.sessions['sess-1'].entries.map((entry) => entry.text),
    ['决定：先做 MVP'],
    '凭据形态条目被丢弃',
  );
  assert.equal(existsSync(join(dir, 'vault.json')), false, 'longterm=none 不写 vault');
  const section = projectSection.text({ agent: { session: { id: 'sess-1' } } });
  assert.equal(section.includes('TestPass123'), false);
  assert.equal(section.includes('NewPass456'), false);
});

test('apply: credentialPatternGuard:false 时凭据形态过滤关闭（配置可关）', async (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  state.llmResponse = JSON.stringify({
    project_memory: ['TestPass123'],
    longterm: { action: 'none' },
  });
  apply(ctx, { dataDir: dir, credentialPatternGuard: false });
  const projectSection = state.sections.find((section) => section.name === 'plugin:session-memory');

  emit(state, makeSession({ turn: 1, text: '第一回合' }), completedEvent(1));
  await waitFor(() => projectSection.text({ agent: { session: { id: 'sess-1' } } }).includes('TestPass123'));

  const file = readJson(join(dir, 'session-memory.json'));
  assert.deepEqual(file.sessions['sess-1'].entries.map((entry) => entry.text), ['TestPass123']);
  assert.ok(projectSection.text({ agent: { session: { id: 'sess-1' } } }).includes('TestPass123'));
});

test('apply: v0.2 identity/credentials 分段落库；只更新一段时另一段保留', async (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  state.llmResponse = JSON.stringify({
    project_memory: ['条目一'],
    identity: { action: 'set', text: '称呼：小王', reason: '自我介绍' },
    credentials: { action: 'set', text: '测试账号:testuser/TestPass123', reason: '用户提供' },
  });
  apply(ctx, { dataDir: dir });
  const projectSection = state.sections.find((section) => section.name === 'plugin:session-memory');

  emit(state, makeSession({ turn: 1, text: '叫我小王，账号 testuser 密码 TestPass123' }), completedEvent(1));
  await waitFor(() => readJson(join(dir, 'vault.json'))?.identity === '称呼：小王');
  await waitFor(() => readJson(join(dir, 'vault.json'))?.credentials === '测试账号:testuser/TestPass123');

  // 第 2 回合：只更新 identity（credentials 返回 none）→ credentials 保持
  state.llmResponse = JSON.stringify({
    project_memory: ['条目一'],
    identity: { action: 'set', text: '称呼：王工', reason: '更正称呼' },
    credentials: { action: 'none' },
  });
  emit(state, makeSession({ turn: 2, text: '以后叫我王工' }), completedEvent(2));
  await waitFor(() => readJson(join(dir, 'vault.json'))?.identity === '称呼：王工');
  await new Promise((resolve) => setTimeout(resolve, 120));

  const vaultFile = readJson(join(dir, 'vault.json'));
  assert.equal(vaultFile.version, 3);
  assert.equal(vaultFile.credentials, '测试账号:testuser/TestPass123', '未给出的段保持当前值');
  assert.equal(vaultFile.history.length, 2);
  assert.deepEqual(vaultFile.history[1].prev, {
    identity: '称呼：小王',
    habits: [],
    credentials: '测试账号:testuser/TestPass123',
  });
  assert.deepEqual(vaultFile.history[1].next, {
    identity: '称呼：王工',
    habits: [],
    credentials: '测试账号:testuser/TestPass123',
  });

  // 注入段绝不出现 identity/credentials 片段
  const section = projectSection.text({ agent: { session: { id: 'sess-1' } } });
  assert.equal(section.includes('称呼：王工'), false);
  assert.equal(section.includes('TestPass123'), false);
});

test('apply: A.6 项目记忆过滤 identity 片段（用户身份不得进项目记忆/注入）', async (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  state.llmResponse = JSON.stringify({
    project_memory: [],
    identity: { action: 'set', text: '称呼：小王', reason: '自我介绍' },
    credentials: { action: 'none' },
  });
  apply(ctx, { dataDir: dir });
  const projectSection = state.sections.find((section) => section.name === 'plugin:session-memory');

  emit(state, makeSession({ turn: 1, text: '叫我小王' }), completedEvent(1));
  await waitFor(() => readJson(join(dir, 'vault.json'))?.identity === '称呼：小王');

  // 第 2 回合：模型把称呼写进 project_memory + 正常条目 → identity 片段条目被剔除
  state.llmResponse = JSON.stringify({
    project_memory: ['称呼：小王 是前端工程师', '正常待办：写 README'],
    identity: { action: 'none' },
    credentials: { action: 'none' },
  });
  emit(state, makeSession({ turn: 2, text: '第二回合' }), completedEvent(2));
  await waitFor(() => projectSection.text({ agent: { session: { id: 'sess-1' } } }).includes('正常待办：写 README'));

  const file = readJson(join(dir, 'session-memory.json'));
  assert.deepEqual(file.sessions['sess-1'].entries.map((entry) => entry.text), ['正常待办：写 README']);
  const section = projectSection.text({ agent: { session: { id: 'sess-1' } } });
  assert.equal(section.includes('称呼：小王'), false);
});

test('apply: task-12 短 identity 片段（王工/小王/前端工程师）在写侧与注入侧都被过滤', async (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  state.llmResponse = JSON.stringify({
    project_memory: [],
    identity: { action: 'set', text: '称呼：王工；职业：前端工程师', reason: '自我介绍' },
    credentials: { action: 'none' },
  });
  apply(ctx, { dataDir: dir });
  const projectSection = state.sections.find((section) => section.name === 'plugin:session-memory');

  emit(state, makeSession({ turn: 1, text: '叫我王工，职业前端工程师' }), completedEvent(1));
  await waitFor(() => readJson(join(dir, 'vault.json'))?.identity === '称呼：王工；职业：前端工程师');

  // 第 2 回合：模型自然写出含短称呼的条目（e2e FAIL-1 场景）→ 写侧必须 dropped
  state.llmResponse = JSON.stringify({
    project_memory: ['vault记忆可用，含王工称呼，仅显式索要时注入', '正常待办：写 README'],
    identity: { action: 'none' },
    credentials: { action: 'none' },
  });
  emit(state, makeSession({ turn: 2, text: '第二回合' }), completedEvent(2));
  await waitFor(() => projectSection.text({ agent: { session: { id: 'sess-1' } } }).includes('正常待办：写 README'));

  const file = readJson(join(dir, 'session-memory.json'));
  assert.deepEqual(
    file.sessions['sess-1'].entries.map((entry) => entry.text),
    ['正常待办：写 README'],
    '含短 identity 片段的条目被写侧丢弃',
  );
  // 注入侧：直接种一条旧毒条目后渲染也必须 0 命中
  const section = projectSection.text({ agent: { session: { id: 'sess-1' } } });
  assert.equal(section.includes('王工'), false, '注入侧 identity 片段 0 命中');

  // 手工把毒条目写进 store 再渲染（模拟旧版本数据）→ 注入兜底过滤
  const storeLike = {
    projectEntries: () => ['vault记忆可用，含王工称呼', '正常待办：写 README'],
    vaultIdentityTexts: () => ['称呼：王工；职业：前端工程师'],
    vaultCredentialTexts: () => [],
  };
  const { renderProjectSection } = await import('../lib/inject.js');
  const { collectCombinedSecretFragments } = await import('../lib/guard.js');
  const fragments = collectCombinedSecretFragments(storeLike.vaultIdentityTexts(), storeLike.vaultCredentialTexts());
  const rendered = renderProjectSection(storeLike.projectEntries(), 300, fragments);
  assert.ok(rendered.includes('- 正常待办：写 README'));
  assert.equal(rendered.includes('王工'), false, '旧毒数据注入 0 命中');
});

test('apply: guardMode 接线 —— off 不注册 guard；strict 本地也拒；balanced+trustedDomains 按域名放行', async (t) => {
  // off：不注册 guard
  const offCtx = createFakeCtx();
  apply(offCtx.ctx, { dataDir: tempDir(t), guardMode: 'off' });
  assert.equal(offCtx.state.guards.length, 0, 'off 模式不注册 guard');

  // strict：vault 落盘后本地工具也拒
  const strictDir = tempDir(t);
  const strictCtx = createFakeCtx();
  strictCtx.state.llmResponse = JSON.stringify({
    project_memory: [],
    identity: { action: 'set', text: '称呼：小王', reason: 'x' },
    credentials: { action: 'set', text: FAKE_SECRET, reason: 'x' },
  });
  apply(strictCtx.ctx, { dataDir: strictDir, guardMode: 'strict' });
  emit(strictCtx.state, makeSession({ id: 'sess-strict', turn: 1, text: '账号密码' }), completedEvent(1));
  await waitFor(() => readJson(join(strictDir, 'vault.json'))?.credentials === FAKE_SECRET);
  assert.equal(
    strictCtx.state.guards[0]({ name: 'pwsh', arguments: { command: FAKE_SECRET } }),
    GUARD_DENY_REASON,
    'strict 下本地工具也拒',
  );

  // balanced + trustedDomains：只放行白名单域名的 web_fetch
  const balancedDir = tempDir(t);
  const balancedCtx = createFakeCtx();
  balancedCtx.state.llmResponse = JSON.stringify({
    project_memory: [],
    identity: { action: 'none' },
    credentials: { action: 'set', text: FAKE_SECRET, reason: 'x' },
  });
  apply(balancedCtx.ctx, { dataDir: balancedDir, trustedDomains: ['example.com'] });
  emit(balancedCtx.state, makeSession({ id: 'sess-balanced', turn: 1, text: '账号密码' }), completedEvent(1));
  await waitFor(() => readJson(join(balancedDir, 'vault.json'))?.credentials === FAKE_SECRET);
  const guard = balancedCtx.state.guards[0];
  assert.equal(guard({ name: 'pwsh', arguments: { command: FAKE_SECRET } }), undefined, '本地工具放行');
  assert.equal(
    guard({ name: 'web_fetch', arguments: { url: 'https://api.example.com/x', note: FAKE_SECRET } }),
    undefined,
    'trustedDomains 内放行',
  );
  assert.equal(
    guard({ name: 'web_fetch', arguments: { url: 'https://evil.com/x', note: FAKE_SECRET } }),
    GUARD_DENY_REASON_NETWORK,
    '未授权域名拒绝',
  );
});

test('apply: divergence 三次 —— new/第2次冻结，第3次 commit 接受并清空；冻结期身份/习惯仍更新', async (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  const record = () => readJson(join(dir, 'session-memory.json'))?.sessions['sess-1'];
  const identitySection = () => state.sections.find((section) => section.name === 'plugin:session-memory-identity');
  const habitsSection = () => state.sections.find((section) => section.name === 'plugin:session-memory-habits');
  const projectText = () => state.sections
    .find((section) => section.name === 'plugin:session-memory')
    .text({ agent: { session: { id: 'sess-1' } } });

  // 第 1 回合：全新话题 → new，冻结项目记忆；但身份/习惯/凭据允许更新
  state.llmResponse = JSON.stringify({
    project_memory: ['新话题：先做插件'],
    identity: { action: 'set', text: '职业：开发人员', reason: '从对话推断' },
    habits: { action: 'set', items: ['偏好中文'], reason: '习惯' },
    credentials: { action: 'set', text: FAKE_SECRET, reason: '凭据' },
    divergence: { status: 'new', tag: '插件', same: true },
  });
  apply(ctx, { dataDir: dir });
  emit(state, makeSession({ turn: 1, text: '我现在在开发插件' }), completedEvent(1));
  await waitFor(() => record()?.divergence?.strikes === 1);
  assert.deepEqual(record().divergence, { tag: '插件', strikes: 1, lastTurn: 1 });
  assert.deepEqual(record().entries, [], 'new 冻结：项目记忆不写入');
  assert.equal(identitySection().text(), '## 用户身份（自动注入）\n职业：开发人员\n');
  assert.ok(habitsSection().text().includes('- 偏好中文'));
  assert.equal(readJson(join(dir, 'vault.json')).credentials, FAKE_SECRET, '冻结不影响凭据写入');

  // 第 2 回合：同话题 continuing → strikes=2，仍冻结
  state.llmResponse = JSON.stringify({
    project_memory: ['新话题：先做插件'],
    identity: { action: 'none' },
    habits: { action: 'none' },
    credentials: { action: 'none' },
    divergence: { status: 'continuing', tag: '插件', same: true },
  });
  emit(state, makeSession({ turn: 2, text: '继续聊插件' }), completedEvent(2));
  await waitFor(() => record()?.divergence?.strikes === 2);
  assert.deepEqual(record().entries, [], '第 2 次仍冻结');

  // 第 3 回合：同话题第 3 次 → 等同 commit：接受本轮项目记忆并清空标签
  state.llmResponse = JSON.stringify({
    project_memory: ['新话题：先做插件'],
    identity: { action: 'none' },
    habits: { action: 'none' },
    credentials: { action: 'none' },
    divergence: { status: 'continuing', tag: '插件', same: true },
  });
  emit(state, makeSession({ turn: 3, text: '还是插件' }), completedEvent(3));
  await waitFor(() => record()?.divergence === null && record()?.entries?.length === 1);
  assert.deepEqual(record().entries.map((entry) => entry.text), ['新话题：先做插件']);
  assert.equal(record().divergence, null, 'commit 后标签清空（不注入、不残留）');
  assert.ok(projectText().includes('新话题：先做插件'));
});

test('apply: divergence none/无关话题清空旧标签并正常写入项目记忆', async (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  const record = () => readJson(join(dir, 'session-memory.json'))?.sessions['sess-1'];

  state.llmResponse = JSON.stringify({
    project_memory: ['旧话题条目'],
    divergence: { status: 'new', tag: 'AB', same: true },
  });
  apply(ctx, { dataDir: dir });
  emit(state, makeSession({ turn: 1, text: '新话题' }), completedEvent(1));
  await waitFor(() => record()?.divergence?.strikes === 1);
  state.llmResponse = JSON.stringify({
    project_memory: ['旧话题条目'],
    divergence: { status: 'continuing', tag: 'AB', same: true },
  });
  emit(state, makeSession({ turn: 2, text: '继续' }), completedEvent(2));
  await waitFor(() => record()?.divergence?.strikes === 2);

  state.llmResponse = JSON.stringify({
    project_memory: ['正常项目条目'],
    divergence: { status: 'none', tag: '', same: false },
  });
  emit(state, makeSession({ turn: 3, text: '回到项目本身' }), completedEvent(3));
  await waitFor(() => record()?.divergence === null && record()?.entries?.length === 1);
  assert.equal(record().divergence, null);
  assert.deepEqual(record().entries.map((entry) => entry.text), ['正常项目条目']);
});

test('apply: divergence same=false（无关延续）重置标签并接受项目记忆', async (t) => {
  const dir = tempDir(t);
  const { ctx, state } = createFakeCtx();
  const record = () => readJson(join(dir, 'session-memory.json'))?.sessions['sess-1'];
  state.llmResponse = JSON.stringify({
    project_memory: ['话题 A'],
    divergence: { status: 'new', tag: 'A', same: true },
  });
  apply(ctx, { dataDir: dir });
  emit(state, makeSession({ turn: 1, text: '话题 A' }), completedEvent(1));
  await waitFor(() => record()?.divergence?.strikes === 1);

  state.llmResponse = JSON.stringify({
    project_memory: ['话题 B'],
    divergence: { status: 'continuing', tag: 'A', same: false },
  });
  emit(state, makeSession({ turn: 2, text: '其实是别的话题' }), completedEvent(2));
  await waitFor(() => record()?.divergence === null && record()?.entries?.length === 1);
  assert.equal(record().divergence, null);
  assert.deepEqual(record().entries.map((entry) => entry.text), ['话题 B']);
});
