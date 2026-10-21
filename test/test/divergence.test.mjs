import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIVERGENCE_STRIKES_REQUIRED,
  DIVERGENCE_TAG_MAX_CHARS,
  applyDivergence,
  divergenceTagLength,
  normalizeDivergenceState,
  parseDivergence,
  sanitizeDivergenceTag,
} from '../lib/divergence.js';
import { codePointLength } from '../lib/text.js';

const TAG = 'AB';

test('divergence: 标签很小 —— trim/折叠空白/≤6 码点截断；非法 → null', () => {
  assert.equal(DIVERGENCE_TAG_MAX_CHARS, 6);
  assert.equal(DIVERGENCE_STRIKES_REQUIRED, 3);
  assert.equal(sanitizeDivergenceTag('  AB  '), 'AB');
  assert.equal(sanitizeDivergenceTag('A\nB\tC'), 'A B C');
  assert.equal(sanitizeDivergenceTag('一二三四五六七八'), '一二三四五六');
  assert.equal(codePointLength(sanitizeDivergenceTag('abcdefg')), 6);
  assert.equal(sanitizeDivergenceTag(''), null);
  assert.equal(sanitizeDivergenceTag('   '), null);
  assert.equal(sanitizeDivergenceTag(42), null);

  const parsed = parseDivergence({ status: 'new', tag: 'abcdefg', same: true });
  assert.deepEqual(parsed, { status: 'new', tag: 'abcdef', same: true });
  assert.deepEqual(parseDivergence({ status: 'bogus', tag: 'X', same: 'yes' }), {
    status: 'none',
    tag: 'X',
    same: false,
  });
  assert.deepEqual(parseDivergence(null), { status: 'none', tag: '', same: false });
});

test('divergence: status=new 打标签 strikes=1，冻结 project_memory；tag 非法用 ?turn 兜底', () => {
  const result = applyDivergence(null, { status: 'new', tag: ' 话题A ', same: true }, 7);
  assert.equal(result.acceptProjectMemory, false);
  assert.deepEqual(result.divergence, { tag: '话题A', strikes: 1, lastTurn: 7 });

  const fallback = applyDivergence(null, { status: 'new', tag: '', same: true }, 12);
  assert.equal(fallback.divergence.tag, '?12');
  assert.equal(fallback.divergence.strikes, 1);
  assert.equal(fallback.acceptProjectMemory, false);
});

test('divergence: status=continuing + same —— 第 2 次仍冻结，第 3 次等同 commit 并清空标签', () => {
  const first = applyDivergence(null, { status: 'new', tag: TAG, same: true }, 1);
  assert.equal(first.divergence.strikes, 1);
  assert.equal(first.acceptProjectMemory, false);

  const second = applyDivergence(first.divergence, { status: 'continuing', tag: TAG, same: true }, 2);
  assert.deepEqual(second.divergence, { tag: TAG, strikes: 2, lastTurn: 2 });
  assert.equal(second.acceptProjectMemory, false, '第二次仍冻结');

  const third = applyDivergence(second.divergence, { status: 'continuing', tag: TAG, same: true }, 3);
  assert.equal(third.acceptProjectMemory, true, '第三次等同 commit：接受项目记忆');
  assert.equal(third.divergence, null, 'commit 后标签清空');
});

test('divergence: status=none / unrelated 清空标签并接受 project_memory', () => {
  const state = { tag: TAG, strikes: 2, lastTurn: 2 };
  const none = applyDivergence(state, { status: 'none', tag: '', same: false }, 3);
  assert.equal(none.acceptProjectMemory, true);
  assert.equal(none.divergence, null);
  assert.equal(none.cleared, true);

  // continuing 但 same=false：视为无关话题 → 重置并接受
  const unrelated = applyDivergence(state, { status: 'continuing', tag: TAG, same: false }, 3);
  assert.equal(unrelated.acceptProjectMemory, true);
  assert.equal(unrelated.divergence, null);

  // 没有标签时 continuing + same 也按无关处理（清空、接受）
  const noState = applyDivergence(null, { status: 'continuing', tag: TAG, same: true }, 3);
  assert.equal(noState.acceptProjectMemory, true);
  assert.equal(noState.divergence, null);
});

test('divergence: status=commit —— 只有 strikes+1>=3 才接受；否则按 continuing 继续冻结', () => {
  // strikes=2 + commit → 接受并清空
  const accepted = applyDivergence({ tag: TAG, strikes: 2, lastTurn: 2 }, { status: 'commit', tag: TAG, same: true }, 3);
  assert.equal(accepted.acceptProjectMemory, true);
  assert.equal(accepted.divergence, null);

  // strikes=1 + commit → 按 continuing：strikes=2，继续冻结
  const frozen = applyDivergence({ tag: TAG, strikes: 1, lastTurn: 1 }, { status: 'commit', tag: TAG, same: true }, 2);
  assert.equal(frozen.acceptProjectMemory, false);
  assert.deepEqual(frozen.divergence, { tag: TAG, strikes: 2, lastTurn: 2 });

  // 没有已存在标签却 commit → 按 new：打标签、冻结
  const orphan = applyDivergence(null, { status: 'commit', tag: TAG, same: true }, 4);
  assert.equal(orphan.acceptProjectMemory, false);
  assert.deepEqual(orphan.divergence, { tag: TAG, strikes: 1, lastTurn: 4 });
});

test('divergence: 已存在同 tag 时模型给 new 按 continuing 处理（计数不丢）', () => {
  const state = { tag: TAG, strikes: 2, lastTurn: 2 };
  const result = applyDivergence(state, { status: 'new', tag: TAG, same: true }, 3);
  assert.equal(result.acceptProjectMemory, true, '同 tag 的 new 视为第 3 次 → commit');
  assert.equal(result.divergence, null);

  // 已有不同 tag 的标签：new 重置 strikes=1 并冻结
  const reset = applyDivergence({ tag: 'OLD', strikes: 2, lastTurn: 2 }, { status: 'new', tag: 'NEW', same: true }, 3);
  assert.equal(reset.acceptProjectMemory, false);
  assert.deepEqual(reset.divergence, { tag: 'NEW', strikes: 1, lastTurn: 3 });
});

test('divergence: normalizeDivergenceState / divergenceTagLength（落盘数据防御）', () => {
  assert.deepEqual(normalizeDivergenceState({ tag: ' AB ', strikes: 2, lastTurn: 5 }), {
    tag: 'AB',
    strikes: 2,
    lastTurn: 5,
  });
  assert.equal(normalizeDivergenceState(null), null);
  assert.equal(normalizeDivergenceState({ tag: '', strikes: 2 }), null);
  assert.deepEqual(normalizeDivergenceState({ tag: 'X' }), { tag: 'X', strikes: 1, lastTurn: 0 });

  assert.equal(divergenceTagLength({ tag: '一二三' }), 3);
  assert.equal(divergenceTagLength(null), 0);
});
