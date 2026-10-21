import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VAULT_SECTION_MAX_CHARS,
  DEFAULT_HABITS_MAX_CHARS,
  DEFAULT_HABIT_ENTRY_MAX_CHARS,
  buildAnalysisPrompt,
  entriesLength,
  parseAnalysisOutput,
  parseHabits,
  parseLongterm,
  parseVaultSection,
  resolveProjectEntries,
} from '../lib/prompt.js';
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
} from '../lib/inject.js';
import { collectCombinedSecretFragments, collectIdentitySecretFragments, collectVaultSecretFragments } from '../lib/guard.js';
import { codePointLength } from '../lib/text.js';

const CREDENTIALS = 'svc:alice/Pa55w0rd';
const IDENTITY = '称呼：小王；职业：前端工程师';
const IDENTITY_SECRET = '称呼：小王';

test('buildAnalysisPrompt: 含项目记忆/身份/习惯/账号密码/divergence 指令与全部硬约束（v0.3）', () => {
  const prompt = buildAnalysisPrompt({
    projectEntries: ['决定：先做 MVP', '待办：验证 e2e'],
    identityText: IDENTITY,
    habits: ['偏好中文', '先方案后动手'],
    credentialsText: CREDENTIALS,
    turnText: '用户：记住账号\n\n助手：好的',
    entryMaxChars: 30,
    projectMaxChars: 300,
    identityMaxChars: 60,
    habitsMaxChars: 120,
    habitEntryMaxChars: 20,
    credentialsMaxChars: 60,
  });
  assert.ok(prompt.includes('- 决定：先做 MVP'));
  assert.ok(prompt.includes('- 待办：验证 e2e'));
  assert.ok(prompt.includes(IDENTITY));
  assert.ok(prompt.includes('- 偏好中文'));
  assert.ok(prompt.includes('- 先方案后动手'));
  assert.ok(prompt.includes(CREDENTIALS));
  assert.ok(prompt.includes('用户：记住账号'));
  assert.ok(prompt.includes('助手：好的'));
  assert.ok(prompt.includes('≤30'));
  assert.ok(prompt.includes('≤300'));
  assert.ok(prompt.includes('≤60'));
  assert.ok(prompt.includes('≤20'));
  assert.ok(prompt.includes('≤120'));
  assert.ok(prompt.includes('当前项目记忆：'));
  assert.ok(prompt.includes('当前用户身份：'));
  assert.ok(prompt.includes('当前用户习惯：'));
  assert.ok(prompt.includes('当前账号密码：'));
  assert.ok(prompt.includes('最新对话：'));
  assert.ok(prompt.includes('只输出一行 JSON'));
  assert.ok(prompt.includes('"identity":{"action":"none"}'));
  assert.ok(prompt.includes('"habits":{"action":"none"}'));
  assert.ok(prompt.includes('"credentials":{"action":"none"}'));
  assert.ok(prompt.includes('"divergence":{"status":"none"'));
  assert.ok(prompt.includes('按重要性从高到低排列'));
  // 身份：要求从对话判断/推断稳定身份（如「在开发插件」→「职业：开发人员」）
  assert.ok(prompt.includes('判断/推断'));
  assert.ok(prompt.includes('职业：开发人员'));
  assert.ok(prompt.includes('只记高置信、长期稳定'));
  assert.ok(prompt.includes('禁止推断健康/政治/宗教'));
  // 习惯：长期稳定偏好、不记一次性要求
  assert.ok(prompt.includes('长期稳定的习惯/偏好'));
  assert.ok(prompt.includes('不记一次性要求'));
  // divergence：三种状态与标签要求
  assert.ok(prompt.includes('"status":"new"'));
  assert.ok(prompt.includes('"status":"continuing"'));
  assert.ok(prompt.includes('"status":"commit"'));
  assert.ok(prompt.includes('≤6个字符的小标签'));
});

test('buildAnalysisPrompt: 空记忆显示（空），longtermText 仍兼容为 credentials', () => {
  const prompt = buildAnalysisPrompt({});
  assert.ok(prompt.includes('（空）'));
  const compat = buildAnalysisPrompt({ longtermText: CREDENTIALS });
  assert.ok(compat.includes(CREDENTIALS));
});

test('parseAnalysisOutput: 合法 JSON（project + identity + credentials）', () => {
  const raw = JSON.stringify({
    project_memory: ['决定：先做 MVP', '待办：验证 e2e'],
    identity: { action: 'set', text: IDENTITY, reason: '用户自我介绍' },
    credentials: { action: 'set', text: CREDENTIALS, reason: '用户提供' },
  });
  const parsed = parseAnalysisOutput(raw, {
    entryMaxChars: 30,
    projectMaxChars: 300,
    identityMaxChars: 60,
    credentialsMaxChars: 60,
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.project.entries, ['决定：先做 MVP', '待办：验证 e2e']);
  assert.equal(parsed.project.chars, entriesLength(parsed.project.entries));
  assert.deepEqual(parsed.identity, { text: IDENTITY, reason: '用户自我介绍' });
  assert.deepEqual(parsed.credentials, { text: CREDENTIALS, reason: '用户提供' });
});

test('parseAnalysisOutput: 代码围栏 + 前后解释文字；缺 identity/credentials 视为无变化', () => {
  const raw = [
    '分析结果如下：',
    '```json',
    JSON.stringify({ project_memory: ['A'], identity: { action: 'none' }, credentials: { action: 'none' } }),
    '```',
    '以上。',
  ].join('\n');
  const parsed = parseAnalysisOutput(raw);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.project.entries, ['A']);
  assert.equal(parsed.identity, null);
  assert.equal(parsed.credentials, null);

  const missing = parseAnalysisOutput(JSON.stringify({ project_memory: [] }));
  assert.equal(missing.ok, true);
  assert.equal(missing.identity, null);
  assert.equal(missing.credentials, null);
});

test('parseAnalysisOutput: 坏 JSON / 无 JSON / 空输出 / 缺 project_memory', () => {
  assert.deepEqual(parseAnalysisOutput('{not json}'), { ok: false, code: 'BAD_JSON' });
  assert.deepEqual(parseAnalysisOutput('只有解释没有对象'), { ok: false, code: 'NO_JSON' });
  assert.deepEqual(parseAnalysisOutput(''), { ok: false, code: 'EMPTY_OUTPUT' });
  assert.deepEqual(parseAnalysisOutput(null), { ok: false, code: 'EMPTY_OUTPUT' });
  assert.deepEqual(parseAnalysisOutput('{"identity":{"action":"none"}}'), {
    ok: false,
    code: 'BAD_PROJECT_MEMORY',
  });
  assert.deepEqual(parseAnalysisOutput('{"project_memory":"不是数组"}'), {
    ok: false,
    code: 'BAD_PROJECT_MEMORY',
  });
});

test('parseAnalysisOutput: 单条超 30 截断、总量超 300 丢条、全部条目 ≤30', () => {
  const overlong = '一'.repeat(45);
  const many = Array.from({ length: 12 }, (_, index) => `${String(index).padStart(2, '0')}${'二'.repeat(31)}`);
  const parsed = parseAnalysisOutput(JSON.stringify({
    project_memory: [overlong, ...many],
    identity: { action: 'none' },
    credentials: { action: 'none' },
  }), { entryMaxChars: 30, projectMaxChars: 300 });
  assert.equal(parsed.ok, true);
  assert.equal(codePointLength(parsed.project.entries[0]), 30);
  assert.ok(parsed.project.entries.length <= 10);
  assert.ok(parsed.project.chars <= 300);
  assert.ok(parsed.project.dropped > 0);
  assert.ok(parsed.project.truncated > 0);
  for (const entry of parsed.project.entries) assert.ok(codePointLength(entry) <= 30);
});

test('parseAnalysisOutput: identity / credentials 61 码点分别被拒（视为无变化）', () => {
  const sixtyOne = 'a'.repeat(61);
  const parsed = parseAnalysisOutput(JSON.stringify({
    project_memory: [],
    identity: { action: 'set', text: sixtyOne, reason: 'x' },
    credentials: { action: 'set', text: sixtyOne, reason: 'y' },
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.identity, null, '身份 61 码点被拒');
  assert.equal(parsed.credentials, null, '账号密码 61 码点被拒');
});

test('parseVaultSection: 合法 set 保留 text/reason 并去空白；非法 set 不写', () => {
  assert.equal(DEFAULT_VAULT_SECTION_MAX_CHARS, 60);
  assert.deepEqual(
    parseVaultSection({ action: 'set', text: `  ${IDENTITY}  `, reason: ' 用户提供  ' }),
    { text: IDENTITY, reason: '用户提供' },
  );
  assert.equal(parseVaultSection({ action: 'set', text: '多行\n明文' }), null);
  assert.equal(parseVaultSection({ action: 'set', text: '   ' }), null);
  assert.equal(parseVaultSection({ action: 'set', text: '' }), null);
  assert.equal(parseVaultSection({ action: 'none' }), null);
  assert.equal(parseVaultSection({ action: 'unknown', text: CREDENTIALS }), null);
  assert.equal(parseVaultSection(null), null);
  // v0.1 名称仍可用
  assert.deepEqual(parseLongterm({ action: 'set', text: CREDENTIALS }), { text: CREDENTIALS, reason: '' });
});

test('resolveProjectEntries: 空数组/相同列表 = 保留旧记忆不动', () => {
  assert.equal(resolveProjectEntries(['旧条目'], { entries: [] }), null);
  assert.equal(resolveProjectEntries([], { entries: [] }), null);
  assert.equal(resolveProjectEntries(['A', 'B'], { entries: ['A', 'B'] }), null);
  assert.equal(resolveProjectEntries(['A'], null), null);
  assert.deepEqual(resolveProjectEntries(['旧条目'], { entries: ['新条目'] }), ['新条目']);
});

test('inject: 项目记忆注入段空/非空渲染', () => {
  assert.equal(renderProjectSection([]), '');
  assert.equal(renderProjectSection(null), '');
  const section = renderProjectSection(['决定：先做 MVP', '待办：验证 e2e']);
  assert.ok(section.startsWith('## 本对话项目记忆'));
  assert.ok(section.includes('- 决定：先做 MVP'));
  assert.ok(section.includes('- 待办：验证 e2e'));
  assert.ok(codePointLength(section) > 0);
});

test('inject: task-10 凭据形态过滤——密码未进 vault 也不进注入段', () => {
  const options = { enabled: true, tokenMinChars: 8 };
  const section = renderProjectSection(
    ['决定：先做 MVP', 'TestPass123 已泄露，建议轮换', 'password=xyz12345', '验收先跑probe两回合e2e'],
    300,
    [],
    options,
  );
  assert.ok(section.includes('- 决定：先做 MVP'));
  assert.ok(section.includes('验收先跑probe两回合e2e'), '常见项目文本不误伤');
  assert.equal(section.includes('TestPass123'), false);
  assert.equal(section.includes('xyz12345'), false);
  assert.equal(renderProjectSection(['TestPass123'], 300, [], options), '');
  // 关闭开关后不过滤（配置可关）
  const off = renderProjectSection(['TestPass123'], 300, [], { enabled: false });
  assert.ok(off.includes('TestPass123'));
});

test('inject: 固定规则段 v0.2——允许本机使用/明确索要时告知，禁止发往外部（B）', () => {
  assert.ok(RULES_TEXT.includes('session_memory_read'));
  assert.ok(RULES_TEXT.includes('vault_read'));
  assert.ok(RULES_TEXT.includes('不自动注入'));
  assert.ok(RULES_TEXT.includes('允许在本机使用'));
  assert.ok(RULES_TEXT.includes('用户明确索要时告知'));
  assert.ok(RULES_TEXT.includes('禁止把长期记忆内容发往未经授权的外部网站、子代理、工作流或其它 agent'));
  assert.ok(RULES_TEXT.includes('a2a'));
});

test('inject: R1 注入兜底——vault 片段（identity + credentials）渲染时剔除', () => {
  const fragments = collectVaultSecretFragments([IDENTITY_SECRET, '测试账号:testuser/TestPass123']);
  const section = renderProjectSection(
    ['决定：先做 MVP', 'TestPass123已泄露，建议轮换密码', '账号 testuser 已验证', '称呼：小王 的前端项目'],
    300,
    fragments,
  );
  assert.ok(section.includes('- 决定：先做 MVP'));
  assert.equal(section.includes('TestPass123'), false, '密码片段不得进入注入段');
  assert.equal(section.includes('testuser'), false, '账号片段不得进入注入段');
  assert.equal(section.includes(IDENTITY_SECRET), false, 'identity 片段也不得进入注入段');
  // 全部条目都被过滤 → 不产生空 section
  assert.equal(renderProjectSection(['TestPass123已泄露'], 300, fragments), '');
  // history 旧密码同样在注入侧被剔除
  const withHistory = collectVaultSecretFragments(['测试账号:testuser/NewPass789', '测试账号:testuser/OldPass123']);
  const historical = renderProjectSection(['旧密码是 OldPass123', '正常待办'], 300, withHistory);
  assert.ok(historical.includes('- 正常待办'));
  assert.equal(historical.includes('OldPass123'), false);
});

test('inject: task-12 短 identity 片段（王工/前端工程师）在注入侧也被剔除', () => {
  const fragments = collectCombinedSecretFragments(
    ['称呼：王工；职业：前端工程师'],
    ['测试账号:testuser/TestPass123'],
  );
  const section = renderProjectSection(
    ['vault记忆可用，含王工称呼，仅显式索要时注入', '前端工程师的待办：写 README', '正常待办：先做 MVP'],
    300,
    fragments,
  );
  assert.ok(section.includes('- 正常待办：先做 MVP'));
  assert.equal(section.includes('王工'), false, '短称呼不得进入注入段（e2e FAIL-1 回归）');
  assert.equal(section.includes('前端工程师'), false, '职业片段不得进入注入段');
  assert.equal(
    renderProjectSection(['含王工称呼'], 300, collectIdentitySecretFragments(['称呼：王工'])),
    '',
    '全部条目被过滤时不产生空 section',
  );
});

test('inject: skill user-profile，正文静态、不含明文、覆盖身份/习惯/账号密码（v0.3）', () => {
  assert.equal(SKILL_NAME, 'user-profile');
  assert.ok(SKILL_DESCRIPTION.includes('用户身份/习惯/账号密码'));
  assert.ok(SKILL_DESCRIPTION.includes('禁止发往外部网站/其它 agent'));
  const body = renderSkillBody();
  assert.equal(body.includes(CREDENTIALS), false);
  assert.equal(body.includes('Pa55w0rd'), false);
  assert.ok(body.includes('vault_read'));
  assert.ok(body.includes('scope'));
  assert.ok(body.includes('identity'));
  assert.ok(body.includes('habits'));
  assert.ok(body.includes('credentials'));
  assert.ok(body.includes('允许在本机使用'));
  assert.ok(body.includes('禁止把读到的内容发往'));
  // R3：正文静态，不写「非空/为空」
  assert.equal(body.includes('非空'), false);
  assert.equal(body.includes('当前长期记忆：'), false);
});

test('inject: 身份/习惯注入段渲染；空则不产生空 section（v0.3）', () => {
  assert.equal(renderIdentitySection(''), '');
  assert.equal(renderIdentitySection('   '), '');
  const identity = renderIdentitySection('职业：开发人员；称呼：王工');
  assert.ok(identity.startsWith('## 用户身份（自动注入）'));
  assert.ok(identity.includes('职业：开发人员；称呼：王工'));

  assert.equal(renderHabitsSection([]), '');
  assert.equal(renderHabitsSection(['', '  ']), '');
  const habits = renderHabitsSection(['偏好中文', '先方案后动手']);
  assert.ok(habits.startsWith('## 用户习惯（自动注入）'));
  assert.ok(habits.includes('- 偏好中文'));
  assert.ok(habits.includes('- 先方案后动手'));
});

test('inject: vault_read scope=all|identity|habits|credentials，字段各用 <vault_secret> 包裹（v0.3）', () => {
  const snapshot = { identity: IDENTITY, habits: ['偏好中文', '先方案后动手'], credentials: CREDENTIALS };
  const all = vaultToolValue(snapshot, 'all');
  assert.equal(all.scope, 'all');
  assert.equal(all.identity, `<vault_secret>${IDENTITY}</vault_secret>`);
  assert.equal(all.habits, '<vault_secret>偏好中文；先方案后动手</vault_secret>');
  assert.equal(all.credentials, `<vault_secret>${CREDENTIALS}</vault_secret>`);

  const identityOnly = vaultToolValue(snapshot, 'identity');
  assert.equal(identityOnly.scope, 'identity');
  assert.equal(identityOnly.identity, `<vault_secret>${IDENTITY}</vault_secret>`);
  assert.equal(Object.hasOwn(identityOnly, 'credentials'), false);

  const habitsOnly = vaultToolValue(snapshot, 'habits');
  assert.equal(habitsOnly.scope, 'habits');
  assert.equal(habitsOnly.habits, '<vault_secret>偏好中文；先方案后动手</vault_secret>');
  assert.equal(Object.hasOwn(habitsOnly, 'identity'), false);

  const credentialsOnly = vaultToolValue(snapshot, 'credentials');
  assert.equal(credentialsOnly.credentials, `<vault_secret>${CREDENTIALS}</vault_secret>`);
  assert.equal(Object.hasOwn(credentialsOnly, 'identity'), false);
  assert.equal(Object.hasOwn(credentialsOnly, 'habits'), false);

  assert.equal(vaultToolValue(snapshot, 'all', '小王').matched, true);
  assert.equal(vaultToolValue(snapshot, 'all', '偏好中文').matched, true);
  assert.equal(vaultToolValue(snapshot, 'all', '不存在').matched, false);
  assert.equal(vaultToolValue({}, 'all').note, '长期记忆为空');
  assert.equal(vaultToolValue({}, 'identity').note, '用户身份为空');
  assert.equal(vaultToolValue({}, 'habits').note, '用户习惯为空');
  assert.equal(vaultToolValue({}, 'credentials').note, '账号密码为空');
  // 非法 scope 归一化为 all
  assert.equal(vaultToolValue(snapshot, 'bogus').scope, 'all');
});

test('inject: session_memory_read 工具返回值', () => {
  assert.deepEqual(
    sessionMemoryToolValue('s1', { record: { cwd: 'C:/w', updatedAt: 5, chars: 3, entries: [{ text: 'A' }] } }),
    { session_id: 's1', cwd: 'C:/w', updatedAt: 5, chars: 3, entries: ['A'] },
  );
  const empty = sessionMemoryToolValue('s1', { record: null });
  assert.deepEqual(empty.entries, []);
  assert.equal(typeof empty.note, 'string');

  const all = allSessionsToolValue([
    { sessionId: 's1', cwd: 'C:/w', updatedAt: 2, chars: 5, entries: 2 },
    { sessionId: 's2', cwd: 'C:/x', updatedAt: 1, chars: 0, entries: 0 },
  ]);
  assert.equal(all.count, 2);
  assert.equal(all.sessions[0].session_id, 's1');
  assert.equal(all.sessions[0].entries, 2);
});

test('parseHabits: 逐条折叠空白/去重/单条截断 20；总量超 120 整段拒绝（保留旧习惯）', () => {
  assert.equal(DEFAULT_HABITS_MAX_CHARS, 120);
  assert.equal(DEFAULT_HABIT_ENTRY_MAX_CHARS, 20);
  const parsed = parseHabits({
    action: 'set',
    items: ['  偏好 中文 ', '先方案后动手', '偏好 中文', 'a'.repeat(25)],
    reason: '用户偏好',
  });
  assert.deepEqual(parsed.items, ['偏好 中文', '先方案后动手', 'a'.repeat(20)]);
  assert.equal(parsed.reason, '用户偏好');

  // 总量 >120 → 整段拒绝（7 条唯一、每条 19 码点 = 133）
  const overfull = parseHabits({
    action: 'set',
    items: Array.from({ length: 7 }, (_, index) => '一'.repeat(18) + String(index)),
  });
  assert.equal(overfull, null);
  // 非 set / 非数组 / 空 → 无变化
  assert.equal(parseHabits({ action: 'none', items: ['x'] }), null);
  assert.equal(parseHabits({ action: 'set', items: 'x' }), null);
  assert.equal(parseHabits({ action: 'set', items: [] }), null);
  assert.equal(parseHabits({ action: 'set', items: [123, ''] }), null);
});

test('parseAnalysisOutput: habits + divergence 解析（含超长标签截断）', () => {
  const parsed = parseAnalysisOutput(JSON.stringify({
    project_memory: ['A'],
    identity: { action: 'set', text: '职业：开发人员', reason: '从对话推断' },
    habits: { action: 'set', items: ['偏好中文', '要求快、不弹窗'], reason: '习惯' },
    credentials: { action: 'none' },
    divergence: { status: 'new', tag: 'abcdefg', same: true },
  }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.identity, { text: '职业：开发人员', reason: '从对话推断' });
  assert.deepEqual(parsed.habits, { items: ['偏好中文', '要求快、不弹窗'], reason: '习惯' });
  assert.deepEqual(parsed.divergence, { status: 'new', tag: 'abcdef', same: true });

  // 缺失 → habits null / divergence none；未知状态归一为 none
  const minimal = parseAnalysisOutput(JSON.stringify({ project_memory: [] }));
  assert.equal(minimal.ok, true);
  assert.equal(minimal.habits, null);
  assert.deepEqual(minimal.divergence, { status: 'none', tag: '', same: false });
  const invalid = parseAnalysisOutput(JSON.stringify({
    project_memory: [],
    divergence: { status: 'what', tag: 'X', same: 'yes' },
    habits: { action: 'set', items: 'oops' },
  }));
  assert.deepEqual(invalid.divergence, { status: 'none', tag: 'X', same: false });
  assert.equal(invalid.habits, null);
});

test('安全过滤：习惯可自动注入；含身份/凭据片段的条目仍被项目记忆过滤', () => {
  const fragments = collectCombinedSecretFragments([IDENTITY], [CREDENTIALS]);
  const project = renderProjectSection(
    ['决定：先做 MVP', '偏好中文', `账号 ${CREDENTIALS} 已验证`, '称呼：小王 的项目'],
    300,
    fragments,
  );
  assert.ok(project.includes('- 决定：先做 MVP'));
  assert.ok(project.includes('- 偏好中文'), '习惯词不是秘密，可以留在项目记忆');
  assert.equal(project.includes('Pa55w0rd'), false, '凭据片段仍被过滤');
  assert.equal(project.includes('称呼：小王'), false, '身份整串仍被过滤');
  // 习惯注入段本身不含凭据
  const habits = renderHabitsSection(['偏好中文']);
  assert.equal(habits.includes(CREDENTIALS), false);
});
