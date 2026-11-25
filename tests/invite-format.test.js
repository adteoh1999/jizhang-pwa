// 2f Task 8：邀请码显示用的纯函数（日期一律用马来西亚时间，两个时区跑结果都一样）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCode, spokenCode, statusLabel, usesLabel, dateLabelMY, expiryLabel, inviteMeta, shareText,
  VALIDITY_OPTIONS, DEFAULT_DAYS, clampUses, USES_MIN, USES_MAX, NOTE_MAX,
} from '../js/invite-format.js';

test('formatCode：8 码加中间的横线；不是 8 码原样回传', () => {
  assert.equal(formatCode('K7MPQ4XZ'), 'K7MP-Q4XZ');
  assert.equal(formatCode('ABC'), 'ABC');
  assert.equal(formatCode(null), '');
});

test('spokenCode：读屏逐字分开念，两组之间停顿', () => {
  assert.equal(spokenCode('K7MPQ4XZ'), 'K 7 M P，Q 4 X Z');
});

test('statusLabel：四种状态的中文；看不懂的回空字串', () => {
  assert.equal(statusLabel('active'), '有效');
  assert.equal(statusLabel('disabled'), '已停用');
  assert.equal(statusLabel('expired'), '已过期');
  assert.equal(statusLabel('used_up'), '已用完');
  assert.equal(statusLabel('weird'), '');
});

test('usesLabel：已用 x/y', () => {
  assert.equal(usesLabel(0, 1), '已用 0/1');
  assert.equal(usesLabel(3, 20), '已用 3/20');
});

test('dateLabelMY：用马来西亚时间（UTC+8）的月日，跟设备时区无关', () => {
  assert.equal(dateLabelMY('2026-12-01T16:30:00.123456+00:00'), '12月2日'); // 马来西亚已是 12/2 00:30
  assert.equal(dateLabelMY('2026-12-01T15:59:59+00:00'), '12月1日');
  assert.equal(dateLabelMY('2027-01-05T00:00:00Z'), '1月5日');
  assert.equal(dateLabelMY('看不懂'), '');
  assert.equal(dateLabelMY(null), '');
});

test('expiryLabel：null → 永不过期；有日期 → M月D日到期；看不懂 → 空字串', () => {
  assert.equal(expiryLabel(null), '永不过期');
  assert.equal(expiryLabel(undefined), '永不过期');
  assert.equal(expiryLabel('2026-12-01T16:30:00+00:00'), '12月2日到期');
  assert.equal(expiryLabel('bad'), '');
});

test('inviteMeta：列表第二行「状态 · 已用 x/y · 到期」，看不懂的段落略过', () => {
  assert.equal(inviteMeta({ status: 'active', used_count: 0, max_uses: 1, expires_at: '2026-12-01T16:30:00+00:00' }),
    '有效 · 已用 0/1 · 12月2日到期');
  assert.equal(inviteMeta({ status: 'disabled', used_count: 2, max_uses: 5, expires_at: null }), '已停用 · 已用 2/5 · 永不过期');
  assert.equal(inviteMeta({ status: '?', used_count: 1, max_uses: 1, expires_at: 'bad' }), '已用 1/1');
});

test('shareText：固定句子（全局限制）', () => {
  assert.equal(shareText('K7MPQ4XZ'), '用邀请码 K7MP-Q4XZ 注册：https://jizhang.adteoh.com');
});

test('有效期选项：1／7／30 天／永不过期（null），默认 7', () => {
  assert.deepEqual(VALIDITY_OPTIONS, [
    { label: '1 天', days: 1 }, { label: '7 天', days: 7 }, { label: '30 天', days: 30 }, { label: '永不过期', days: null },
  ]);
  assert.equal(DEFAULT_DAYS, 7);
});

test('clampUses：1–20 的整数；超出夹回边界，不是数字回 1', () => {
  assert.equal(USES_MIN, 1);
  assert.equal(USES_MAX, 20);
  assert.equal(NOTE_MAX, 40);
  assert.equal(clampUses(0), 1);
  assert.equal(clampUses(21), 20);
  assert.equal(clampUses(5.7), 5);
  assert.equal(clampUses(NaN), 1);
  assert.equal(clampUses(7), 7);
});

test('segmentStep（多选项分段控件的方向键）：左右上下移一格，两端绕回；其他键回原位', async () => {
  const { segmentStep } = await import('../js/ui/components.js');
  assert.equal(segmentStep(0, 'ArrowRight', 4), 1);
  assert.equal(segmentStep(3, 'ArrowRight', 4), 0);
  assert.equal(segmentStep(0, 'ArrowLeft', 4), 3);
  assert.equal(segmentStep(2, 'ArrowDown', 4), 3);
  assert.equal(segmentStep(2, 'ArrowUp', 4), 1);
  assert.equal(segmentStep(2, 'Enter', 4), 2);
});
