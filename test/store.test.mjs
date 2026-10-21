import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryStore,
  SESSION_MEMORY_FILE,
  VAULT_FILE,
  VAULT_FORMAT_VERSION,
  writeFileAtomicSync,
} from '../lib/store.js';
import { codePointLength } from '../lib/text.js';

/** 每个用例独立临时目录；t.after 清理。 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-session-memory-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('store: 空目录初始化 + 项目记忆原子落盘 + 新实例重载', async (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dataDir: dir });
  assert.deepEqual(store.projectEntries('s1'), []);
  assert.equal(store.vaultIdentity(), '');
  assert.equal(store.vaultCredentials(), '');
  assert.equal(store.vaultSnapshot().rev, 0);
  assert.equal(store.projectSnapshot('s1').record, null);

  const result = await store.updateProjectMemory('s1', () => ({
    cwd: 'C:/work',
    updatedAt: 111,
    entries: [
      { text: '决定：先做 MVP', turn: 1, at: 111 },
      { text: '待办：验证 e2e', turn: 1, at: 111 },
    ],
  }), { expectedRev: 0 });
  assert.equal(result.changed, true);
  assert.equal(result.rev, 1);

  const raw = JSON.parse(readFileSync(join(dir, SESSION_MEMORY_FILE), 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.rev, 1);
  assert.equal(raw.sessions.s1.cwd, 'C:/work');
  assert.equal(raw.sessions.s1.chars, codePointLength('决定：先做 MVP') + codePointLength('待办：验证 e2e'));
  assert.deepEqual(raw.sessions.s1.entries.map((entry) => entry.text), ['决定：先做 MVP', '待办：验证 e2e']);
  // 原子写不残留 .tmp-* 文件
  assert.deepEqual(readdirSync(dir), [SESSION_MEMORY_FILE]);

  const reloaded = new MemoryStore({ dataDir: dir });
  assert.deepEqual(reloaded.projectEntries('s1'), ['决定：先做 MVP', '待办：验证 e2e']);
  assert.equal(reloaded.projectSnapshot('s1').rev, 1);
});

test('store: 原子写 = 同目录临时文件 + rename，旧内容被完整替换', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'sample.json');
  writeFileAtomicSync(file, '{"step":1}');
  writeFileAtomicSync(file, '{"step":2}');
  assert.equal(readFileSync(file, 'utf8'), '{"step":2}');
  assert.deepEqual(readdirSync(dir), ['sample.json']);
});

test('store: rev 冲突时从磁盘重读一次再应用，不覆盖其它会话', async (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dataDir: dir });
  await store.updateProjectMemory('s1', () => ({
    cwd: 'C:/w',
    updatedAt: 1,
    entries: [{ text: 'A', turn: 1, at: 1 }],
  }), { expectedRev: 0 });

  // 模拟其它写者：文件被改成 rev=9 并多一个会话 s2。
  const file = join(dir, SESSION_MEMORY_FILE);
  const external = JSON.parse(readFileSync(file, 'utf8'));
  external.rev = 9;
  external.sessions.s2 = {
    cwd: 'C:/x',
    updatedAt: 2,
    chars: 1,
    entries: [{ text: 'B', turn: 1, at: 2 }],
  };
  writeFileSync(file, JSON.stringify(external));

  // 用过期 rev=1 更新 s1：应重读 → 在 rev=9 之上应用。
  const result = await store.updateProjectMemory('s1', (record) => ({
    ...record,
    updatedAt: 3,
    entries: [...record.entries, { text: 'C', turn: 2, at: 3 }],
  }), { expectedRev: 1 });
  assert.equal(result.changed, true);

  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.rev, 10);
  assert.deepEqual(after.sessions.s1.entries.map((entry) => entry.text), ['A', 'C']);
  assert.equal(after.sessions.s2.entries[0].text, 'B', '其它会话不被覆盖');
});

test('store: 写入时条目硬约束（每条 ≤30、总 ≤300、去掉非法项）', async (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dataDir: dir, entryMaxChars: 30, projectMaxChars: 300 });
  const entries = Array.from({ length: 12 }, (_, index) => ({
    text: `${String(index).padStart(2, '0')}${'一'.repeat(31)}`,
    turn: index + 1,
    at: index + 1,
  }));
  const result = await store.updateProjectMemory('s1', () => ({ entries: [...entries, null, 42] }), { expectedRev: 0 });
  assert.equal(result.changed, true);
  const record = store.projectSnapshot('s1').record;
  assert.equal(record.entries.length, 10);
  assert.ok(record.chars <= 300);
  for (const entry of record.entries) assert.ok(codePointLength(entry.text) <= 30);
  const raw = JSON.parse(readFileSync(join(dir, SESSION_MEMORY_FILE), 'utf8'));
  assert.equal(raw.sessions.s1.chars, record.chars);
});

test('store: vault v0.2 identity/credentials 分别落库 + history 为 prev/next 对象', async (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dataDir: dir });

  const first = await store.updateVault(
    { identity: '称呼：小王；职业：前端工程师', credentials: 'svc:alice/Pa55w0rd' },
    { reason: '用户提供了身份与账号密码', sessionId: 's1', turn: 3 },
  );
  assert.equal(first.changed, true);
  assert.equal(store.vaultIdentity(), '称呼：小王；职业：前端工程师');
  assert.equal(store.vaultCredentials(), 'svc:alice/Pa55w0rd');

  // 只改 credentials，identity 保持不变（缺省段沿用当前值）
  const second = await store.updateVault({ credentials: 'svc:alice/NewPa55' }, { reason: '用户更正密码', sessionId: 's1', turn: 5 });
  assert.equal(second.changed, true);
  assert.equal(store.vaultIdentity(), '称呼：小王；职业：前端工程师');
  assert.equal(store.vaultCredentials(), 'svc:alice/NewPa55');

  // 两段都不变 → no-op
  const third = await store.updateVault(
    { identity: '称呼：小王；职业：前端工程师', credentials: 'svc:alice/NewPa55' },
    {},
  );
  assert.equal(third.changed, false);

  const raw = JSON.parse(readFileSync(join(dir, VAULT_FILE), 'utf8'));
  assert.equal(raw.version, VAULT_FORMAT_VERSION);
  assert.equal(raw.version, 2);
  assert.equal(raw.rev, 2);
  assert.equal(raw.identity, '称呼：小王；职业：前端工程师');
  assert.equal(raw.credentials, 'svc:alice/NewPa55');
  assert.equal(raw.history.length, 2);
  assert.deepEqual(raw.history[0].prev, { identity: '', credentials: '' });
  assert.deepEqual(raw.history[0].next, { identity: '称呼：小王；职业：前端工程师', credentials: 'svc:alice/Pa55w0rd' });
  assert.equal(raw.history[0].turn, 3);
  assert.deepEqual(raw.history[1].prev, { identity: '称呼：小王；职业：前端工程师', credentials: 'svc:alice/Pa55w0rd' });
  assert.deepEqual(raw.history[1].next, { identity: '称呼：小王；职业：前端工程师', credentials: 'svc:alice/NewPa55' });
  assert.equal(raw.history[1].sessionId, 's1');

  const reloaded = new MemoryStore({ dataDir: dir });
  assert.equal(reloaded.vaultIdentity(), '称呼：小王；职业：前端工程师');
  assert.equal(reloaded.vaultCredentials(), 'svc:alice/NewPa55');
  assert.equal(reloaded.vaultSnapshot().rev, 2);
});

test('store: v1 vault 迁移 —— {text} → credentials，history 字符串映射为对象', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, VAULT_FILE), JSON.stringify({
    version: 1,
    rev: 4,
    text: '测试账号:testuser/TestPass123',
    updatedAt: 123,
    history: [
      { at: 1, prev: '', next: '测试账号:testuser/OldPass456', reason: '旧版记录', sessionId: 's1', turn: 1 },
    ],
  }));
  const store = new MemoryStore({ dataDir: dir });
  assert.equal(store.isVaultBlocked(), false, 'v1 是合法旧版，不应 fail-closed');
  assert.equal(store.vaultIdentity(), '', 'v1 没有 identity');
  assert.equal(store.vaultCredentials(), '测试账号:testuser/TestPass123');
  assert.equal(store.vaultSnapshot().rev, 4);
  // 旧 history 的字符串也参与秘密集合（旧密码过滤能力保留）
  const secretTexts = store.vaultSecretTexts();
  assert.ok(secretTexts.includes('测试账号:testuser/TestPass123'));
  assert.ok(secretTexts.includes('测试账号:testuser/OldPass456'));
});

test('store: identity/credentials 分别硬校验 61 码点被拒', async (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dataDir: dir });
  await assert.rejects(
    store.updateVault({ identity: 'a'.repeat(61) }, {}),
    (error) => error.code === 'BAD_IDENTITY_TEXT',
  );
  await assert.rejects(
    store.updateVault({ credentials: 'a'.repeat(61) }, {}),
    (error) => error.code === 'BAD_CREDENTIALS_TEXT',
  );
  await assert.rejects(
    store.updateVault({ identity: '多行\n身份' }, {}),
    (error) => error.code === 'BAD_IDENTITY_TEXT',
  );
  // 60 码点合法
  const ok = await store.updateVault({ identity: 'a'.repeat(60), credentials: 'b'.repeat(60) }, {});
  assert.equal(ok.changed, true);
});

test('store: session-memory 坏文件 → 备份 .corrupt-* 后从空库继续', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, SESSION_MEMORY_FILE), '{ broken json');
  const warnings = [];
  const store = new MemoryStore({ dataDir: dir, onWarn: (code) => warnings.push(code) });
  assert.deepEqual(store.projectEntries('s1'), []);
  const files = readdirSync(dir);
  assert.ok(files.some((name) => name.startsWith(`${SESSION_MEMORY_FILE}.corrupt-`)), '坏文件被备份');
  assert.ok(warnings.includes('SESSION_STORE_CORRUPT_RECOVERED'));

  const result = await store.updateProjectMemory('s1', () => ({ entries: ['新条目'] }), { expectedRev: 0 });
  assert.equal(result.changed, true);
  assert.deepEqual(new MemoryStore({ dataDir: dir }).projectEntries('s1'), ['新条目']);
});

test('store: vault 坏 JSON → 备份后 fail-closed，拒绝任何覆盖写', async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, VAULT_FILE), '{ "version": 2, "identity": ');
  const warnings = [];
  const store = new MemoryStore({ dataDir: dir, onWarn: (code) => warnings.push(code) });
  assert.equal(store.isVaultBlocked(), true);
  assert.equal(store.vaultCredentials(), '');
  assert.ok(warnings.includes('VAULT_CORRUPT_BLOCKED'));
  assert.ok(readdirSync(dir).some((name) => name.startsWith(`${VAULT_FILE}.corrupt-`)), '坏 vault 被备份');
  await assert.rejects(
    store.updateVault({ credentials: 'svc:alice/Pa55w0rd' }, { reason: 'x' }),
    (error) => error.code === 'VAULT_CORRUPT',
  );
  // fail-closed：不产生新的 vault.json 覆盖原数据。
  assert.equal(readdirSync(dir).includes(VAULT_FILE), false);
});

test('store: vault 结构非法（identity 超长/credentials 含换行）→ fail-closed', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, VAULT_FILE), JSON.stringify({
    version: 2,
    rev: 1,
    identity: 'a'.repeat(61),
    credentials: '',
    updatedAt: 1,
    history: [],
  }));
  const blocked = new MemoryStore({ dataDir: dir });
  assert.equal(blocked.isVaultBlocked(), true);
  assert.ok(readdirSync(dir).some((name) => name.startsWith(`${VAULT_FILE}.corrupt-`)));

  const dir2 = tempDir(t);
  writeFileSync(join(dir2, VAULT_FILE), JSON.stringify({
    version: 2,
    rev: 1,
    identity: '正常身份',
    credentials: '多行\n明文',
    updatedAt: 1,
    history: [],
  }));
  const blocked2 = new MemoryStore({ dataDir: dir2 });
  assert.equal(blocked2.isVaultBlocked(), true);
});

test('store: listSessions 按 updatedAt 倒序且不含长期记忆', async (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dataDir: dir });
  await store.updateProjectMemory('older', () => ({ cwd: 'C:/a', updatedAt: 10, entries: ['A'] }), { expectedRev: 0 });
  await store.updateProjectMemory('newer', () => ({ cwd: 'C:/b', updatedAt: 20, entries: ['B'] }), { expectedRev: 1 });
  const list = store.listSessions();
  assert.deepEqual(list.map((item) => item.sessionId), ['newer', 'older']);
  assert.equal(list[0].entries, 1);
  assert.equal(list[0].cwd, 'C:/b');
  assert.equal(JSON.stringify(list).includes('vault'), false);
});

test('store: vaultSecretTexts 含 identity + credentials + history prev/next（去重）', async (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dataDir: dir });
  await store.updateVault(
    { identity: '称呼：小王', credentials: '测试账号:testuser/OldPass456' },
    { reason: '首次', sessionId: 's1', turn: 1 },
  );
  await store.updateVault(
    { identity: '称呼：王工', credentials: '测试账号:testuser/NewPass789' },
    { reason: '轮换', sessionId: 's1', turn: 2 },
  );

  const texts = store.vaultSecretTexts();
  assert.ok(texts.includes('称呼：王工'), '当前 identity');
  assert.ok(texts.includes('称呼：小王'), 'history 旧 identity');
  assert.ok(texts.includes('测试账号:testuser/NewPass789'), '当前 credentials');
  assert.ok(texts.includes('测试账号:testuser/OldPass456'), 'history 旧密码');
  assert.equal(new Set(texts).size, texts.length, '去重');

  const reloaded = new MemoryStore({ dataDir: dir });
  assert.ok(reloaded.vaultSecretTexts().includes('测试账号:testuser/OldPass456'), '重载后 history 仍可提取');
  assert.deepEqual(new MemoryStore({ dataDir: join(dir, 'empty') }).vaultSecretTexts(), []);
});

test('store: vaultIdentityTexts / vaultCredentialTexts 分列表（task-12 identity 短片段过滤用）', async (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore({ dataDir: dir });
  await store.updateVault(
    { identity: '称呼：小王', credentials: '测试账号:testuser/OldPass456' },
    { reason: '首次', sessionId: 's1', turn: 1 },
  );
  await store.updateVault(
    { identity: '称呼：王工；职业：前端工程师', credentials: '测试账号:testuser/NewPass789' },
    { reason: '轮换', sessionId: 's1', turn: 2 },
  );

  const identities = store.vaultIdentityTexts();
  assert.ok(identities.includes('称呼：王工；职业：前端工程师'), '当前 identity');
  assert.ok(identities.includes('称呼：小王'), 'history 旧 identity');

  const credentials = store.vaultCredentialTexts();
  assert.ok(credentials.includes('测试账号:testuser/NewPass789'));
  assert.ok(credentials.includes('测试账号:testuser/OldPass456'));

  // 两段列表互不混入
  assert.equal(identities.some((text) => text.includes('TestPass')), false);
  assert.equal(credentials.some((text) => text.includes('王工')), false);
  assert.deepEqual(new MemoryStore({ dataDir: join(dir, 'empty') }).vaultIdentityTexts(), []);
});
