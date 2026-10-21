import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CREDENTIAL_TOKEN_MIN_CHARS,
  filterEntriesByCredentialPatterns,
  looksLikeCredential,
} from '../lib/secrets-patterns.js';

test('looksLikeCredential: 关键词上下文 + ≥4 码点值 → 凭据', () => {
  const positives = [
    '密码：abc12345',
    '密码: abc12345',
    'password=xyz12345',
    'password: xyz12345',
    'pwd = zzz9999',
    'secret: abcdefg',
    'token=ABCDEF1234',
    'api_key: sk-abc123',
    'api-key: sk-abc123',
    '账号密码：testuser/TestPass123',
    '用户名密码 abc12345',
    '密码 TestPass123',
  ];
  for (const text of positives) assert.equal(looksLikeCredential(text), true, text);
});

test('looksLikeCredential: 高熵 token（≥8 码点、字母+数字）→ 凭据', () => {
  const positives = ['TestPass123', 'NewPass456', 'abc12345', '记住密码 TestPass123', 'TOKEN abc98765'];
  for (const text of positives) assert.equal(looksLikeCredential(text), true, text);
});

test('looksLikeCredential: 常见项目文本不误伤', () => {
  const negatives = [
    'v3.2', // 版本号
    '0.2.1-rc.2',
    'task_261020_001', // 下划线标识符，分段后都 <8
    'deepseek-flash',
    '验收先跑probe两回合e2e', // 纯中文 + 短 ASCII 片段
    'DeepSeek Harness',
    'README.md',
    '12345678', // 纯数字：高熵不成立
    '2026-10-20',
    'node --test --test-isolation=none',
    '决定：先做 MVP，再补 UI',
    '待办：验证 probe 端到端',
    '条目甲：先做 MVP',
  ];
  for (const text of negatives) assert.equal(looksLikeCredential(text), false, text);
});

test('looksLikeCredential: 关键词但值不足 4 码点 / 无分隔符不误判', () => {
  assert.equal(looksLikeCredential('密码需要定期更换'), false, '无分隔符不匹配');
  assert.equal(looksLikeCredential('密码：短'), false, '值只有 1 码点');
  assert.equal(looksLikeCredential('password is required'), false, '空格后是短词 is');
  assert.equal(looksLikeCredential('token 过期'), false);
});

test('looksLikeCredential: credentialTokenMinChars 可配（默认 8）', () => {
  assert.equal(DEFAULT_CREDENTIAL_TOKEN_MIN_CHARS, 8);
  assert.equal(looksLikeCredential('Abc12345'), true);
  assert.equal(looksLikeCredential('Abc1234'), false, '7 码点默认不命中');
  assert.equal(looksLikeCredential('Abc1234', { tokenMinChars: 7 }), true);
  assert.equal(looksLikeCredential('TestPass123', { highEntropy: false }), false, '可单独关闭高熵规则');
  assert.equal(looksLikeCredential('密码：abc12345', { keywords: false, highEntropy: false }), false);
});

test('looksLikeCredential: 非字符串/空文本安全返回 false', () => {
  assert.equal(looksLikeCredential(null), false);
  assert.equal(looksLikeCredential(undefined), false);
  assert.equal(looksLikeCredential(123), false);
  assert.equal(looksLikeCredential(''), false);
});

test('filterEntriesByCredentialPatterns: 丢弃凭据条目、保留正常条目与原始形状', () => {
  const result = filterEntriesByCredentialPatterns([
    'TestPass123',
    '决定：先做 MVP',
    { text: 'password=xyz12345' },
    'NewPass456',
    'v3.2',
    null,
  ]);
  assert.deepEqual(result.entries, ['决定：先做 MVP', 'v3.2']);
  assert.equal(result.removed, 3);
});

test('filterEntriesByCredentialPatterns: enabled:false 不过滤（配置开关）', () => {
  const entries = ['TestPass123', '决定：先做 MVP'];
  const result = filterEntriesByCredentialPatterns(entries, { enabled: false });
  assert.deepEqual(result.entries, entries);
  assert.equal(result.removed, 0);
  assert.deepEqual(filterEntriesByCredentialPatterns(null).entries, []);
});
