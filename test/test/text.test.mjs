import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ENTRY_MAX_CHARS,
  DEFAULT_PROJECT_MAX_CHARS,
  codePointLength,
  extractJsonObject,
  fitEntries,
  normalizeEntryText,
  sanitizeVaultText,
  stripCodeFences,
  sumEntriesChars,
  truncateCodePoints,
  truncateCodePointsEnd,
  truncateMiddle,
} from '../lib/text.js';

test('codePointLength: 中文/emoji 按 Unicode 码点计数', () => {
  assert.equal(codePointLength('abc'), 3);
  assert.equal(codePointLength('记忆插件'), 4);
  assert.equal(codePointLength('👍'), 1, '代理对应算 1 个码点');
  assert.equal(codePointLength('👨‍👩‍👧'), 5, 'ZWJ 序列按码点计');
  assert.equal(codePointLength(''), 0);
  assert.equal(codePointLength(null), 0);
  assert.equal(codePointLength(123), 0);
});

test('truncateCodePoints / truncateCodePointsEnd: 不切断代理对', () => {
  assert.equal(truncateCodePoints('👍👍👍', 2), '👍👍');
  assert.equal(truncateCodePoints('abc', 5), 'abc');
  assert.equal(truncateCodePoints('abc', 0), '');
  assert.equal(truncateCodePointsEnd('ab👍👍', 2), '👍👍');
  assert.equal(truncateCodePointsEnd('abc', 5), 'abc');
});

test('normalizeEntryText: trim、换行折叠、去空、非字符串', () => {
  assert.equal(normalizeEntryText('  决定：先做 MVP  '), '决定：先做 MVP');
  assert.equal(normalizeEntryText('第一行\n第二行'), '第一行 第二行');
  assert.equal(normalizeEntryText('a\tb\r\nc'), 'a b c');
  assert.equal(normalizeEntryText('   '), null);
  assert.equal(normalizeEntryText(42), null);
  assert.equal(normalizeEntryText(null), null);
});

test('fitEntries: 单条超 30 码点被截断、去重、跳过非法项', () => {
  const longEntry = '一'.repeat(45);
  const result = fitEntries([longEntry, 'A', 'A', '', null, 7, 'B'], {
    entryMaxChars: DEFAULT_ENTRY_MAX_CHARS,
    projectMaxChars: DEFAULT_PROJECT_MAX_CHARS,
  });
  assert.deepEqual(result.entries.slice(1), ['A', 'B']);
  assert.equal(codePointLength(result.entries[0]), 30);
  assert.equal(result.truncated, 1);
  assert.equal(result.chars, sumEntriesChars(result.entries));
  assert.ok(result.chars <= DEFAULT_PROJECT_MAX_CHARS);
});

test('fitEntries: 总量超 300 时默认从尾部（重要性最低）丢条目', () => {
  // 12 条 × 30 码点 = 360 > 300；默认 drop: 'tail' 丢尾部。
  const entries = Array.from({ length: 12 }, (_, index) => `${String(index).padStart(2, '0')}${'一'.repeat(28)}`);
  const result = fitEntries(entries, { entryMaxChars: 30, projectMaxChars: 300 });
  assert.equal(result.dropped, 2);
  assert.equal(result.entries.length, 10);
  assert.ok(result.chars <= 300);
  assert.ok(result.entries[0].startsWith('00'), '头部（最重要）保留');
  assert.ok(!result.entries.includes(entries[11]), '尾部（最不重要）被丢弃');
});

test('fitEntries: drop:"head" 时按 spec 字面从头部丢条目', () => {
  const entries = Array.from({ length: 12 }, (_, index) => `${String(index).padStart(2, '0')}${'一'.repeat(28)}`);
  const result = fitEntries(entries, { entryMaxChars: 30, projectMaxChars: 300, drop: 'head' });
  assert.equal(result.dropped, 2);
  assert.ok(result.entries.includes(entries[11]));
  assert.ok(!result.entries.includes(entries[0]));
});

test('fitEntries: 坏输入返回空列表', () => {
  assert.deepEqual(fitEntries(null).entries, []);
  assert.deepEqual(fitEntries(undefined).entries, []);
  assert.deepEqual(fitEntries([]).entries, []);
});

test('sanitizeVaultText: 非空、无换行、≤60 码点，否则 null（不截断）', () => {
  const secret = 'svc:alice/Pa55w0rd';
  assert.equal(sanitizeVaultText(secret, 60), secret);
  assert.equal(sanitizeVaultText(`  ${secret}  `, 60), secret);
  assert.equal(sanitizeVaultText('a'.repeat(60), 60), 'a'.repeat(60));
  assert.equal(sanitizeVaultText('a'.repeat(61), 60), null);
  assert.equal(sanitizeVaultText('line1\nline2', 60), null);
  assert.equal(sanitizeVaultText('tab\there', 60), null);
  assert.equal(sanitizeVaultText('', 60), null);
  assert.equal(sanitizeVaultText('   ', 60), null);
  assert.equal(sanitizeVaultText(null, 60), null);
  assert.equal(sanitizeVaultText({ text: 'x' }, 60), null);
});

test('truncateMiddle: 保留头 1500 + 尾部，总长不超 maxChars', () => {
  const longText = '头'.repeat(1500) + '中'.repeat(3000) + '尾'.repeat(1000);
  const cut = truncateMiddle(longText, 4000, 1500);
  assert.ok(codePointLength(cut) <= 4000);
  assert.ok(cut.startsWith('头'.repeat(100)));
  assert.ok(cut.endsWith('尾'.repeat(100)));
  assert.ok(cut.includes('中间内容已截断'));
  assert.equal(truncateMiddle('短文本', 4000, 1500), '短文本');
  const tiny = truncateMiddle(longText, 50, 1500);
  assert.ok(codePointLength(tiny) <= 50);
});

test('stripCodeFences / extractJsonObject: 去围栏取第一个 { 到最后一个 }', () => {
  const fenced = '```json\n{"project_memory":[],"longterm":{"action":"none"}}\n```';
  assert.equal(
    extractJsonObject(stripCodeFences(fenced)),
    '{"project_memory":[],"longterm":{"action":"none"}}',
  );
  assert.equal(extractJsonObject('没有 JSON'), null);
  assert.equal(extractJsonObject('前 {a:1} 后'), '{a:1}');
  assert.equal(extractJsonObject(''), null);
});
