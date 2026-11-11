import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DECISION,
  computeFeatures,
  decideSticker,
  mulberry32,
  noisyOr,
  readEmotion,
  recordDecision,
  saturate,
} from '../lib/sticker-decision.js';

const base = {
  replyLength: 0,
  durationMs: 0,
  emotionIntensity: 0,
  turn: 0,
  hasFile: false,
  hasDoc: false,
  hasImage: false,
};

test('saturate 单调递增且落在 [0,1)', () => {
  assert.equal(saturate(0, 100), 0);
  assert.ok(saturate(100, 100) > saturate(50, 100));
  assert.ok(saturate(1e9, 100) <= 1);
  assert.equal(saturate(5, 0), 1);
});

test('mulberry32 同种子同序列，不同种子不同', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const c = mulberry32(43);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, [c(), c(), c()]);
  for (const value of seqA) assert.ok(value >= 0 && value < 1);
});

test('无特征时趋近基线概率', () => {
  const probability = noisyOr(computeFeatures(base, DEFAULT_DECISION), DEFAULT_DECISION);
  assert.ok(Math.abs(probability - DEFAULT_DECISION.baseline) < 1e-9);
});

test('特征越多越强，P 越大（单调）', () => {
  const weak = noisyOr(computeFeatures({ ...base, replyLength: 20, emotionIntensity: 0.1 }, DEFAULT_DECISION), DEFAULT_DECISION);
  const strong = noisyOr(computeFeatures({ ...base, replyLength: 800, emotionIntensity: 0.9 }, DEFAULT_DECISION), DEFAULT_DECISION);
  assert.ok(strong > weak);
  assert.ok(strong <= 1);
});

test('P 天然饱和在 [0,1]', () => {
  const extreme = noisyOr(computeFeatures({
    replyLength: 1e9, durationMs: 1e9, emotionIntensity: 1, turn: 1e9, hasFile: true, hasDoc: true,
  }, DEFAULT_DECISION), DEFAULT_DECISION);
  assert.ok(extreme > 0.9 && extreme <= 1);
});

test('已带图片是抑制特征', () => {
  const input = { ...base, replyLength: 500, emotionIntensity: 0.9 };
  const normal = decideSticker({ input, state: {}, decision: { ...DEFAULT_DECISION, seed: 7 } });
  const withImage = decideSticker({ input: { ...input, hasImage: true }, state: {}, decision: { ...DEFAULT_DECISION, seed: 7 } });
  assert.ok(withImage.probability < normal.probability);
  assert.equal(withImage.suppression, DEFAULT_DECISION.suppression.image);
});

test('冷却期内不触发', () => {
  const now = 1_000_000;
  const result = decideSticker({
    input: { ...base, replyLength: 900, emotionIntensity: 1 },
    state: { lastSentAt: now - 1000, history: [] },
    decision: { ...DEFAULT_DECISION, seed: 1 },
    now,
  });
  assert.equal(result.factors.cooldown, true);
  assert.equal(result.probability, 0);
  assert.equal(result.send, false);
});

test('从未发送过时不应进入冷却（回归）', () => {
  const result = decideSticker({
    input: { ...base, replyLength: 500, emotionIntensity: 0.9 },
    state: { lastSentAt: 0, history: [] },
    decision: { ...DEFAULT_DECISION, seed: 5 },
    now: 1000,
  });
  assert.equal(result.factors.cooldown, false);
  assert.ok(result.probability > 0);
});

test('连续触发会被惩罚压低', () => {
  const now = 10_000_000;
  const input = { ...base, replyLength: 600, emotionIntensity: 0.8 };
  const decision = { ...DEFAULT_DECISION, seed: 3 };
  const clean = decideSticker({ input, state: { history: [false, false, false] }, decision, now });
  const dirty = decideSticker({ input, state: { history: [true, true, true] }, decision, now });
  assert.ok(dirty.probability < clean.probability);
  assert.equal(dirty.factors.recentTriggers, 3);
});

test('全局触发率超过目标时按比例压低', () => {
  const now = 10_000_000;
  const input = { ...base, replyLength: 600, emotionIntensity: 0.8 };
  const decision = { ...DEFAULT_DECISION, seed: 3 };
  const history = Array.from({ length: 20 }, (_, index) => index % 2 === 0);
  const result = decideSticker({ input, state: { history }, decision, now });
  assert.ok(result.factors.observedRate > DEFAULT_DECISION.global.target);
  assert.ok(result.factors.rateScale < 1);
});

test('同一 seed 决策可复现', () => {
  const now = 5_000_000;
  const input = { ...base, replyLength: 400, emotionIntensity: 0.7 };
  const decision = { ...DEFAULT_DECISION, seed: 99 };
  const first = decideSticker({ input, state: {}, decision, now });
  const second = decideSticker({ input, state: {}, decision, now });
  assert.equal(first.roll, second.roll);
  assert.equal(first.send, second.send);
});

test('r < P 才发送', () => {
  const high = decideSticker({
    input: { ...base, replyLength: 2000, emotionIntensity: 1 },
    state: {},
    decision: { ...DEFAULT_DECISION, seed: 1, cooldownMs: 0 },
    now: 1,
  });
  // 用固定随机源验证判定边界
  const always = decideSticker({
    input: { ...base, replyLength: 2000, emotionIntensity: 1 },
    state: {},
    decision: { ...DEFAULT_DECISION, cooldownMs: 0 },
    now: 1,
    random: () => 0,
  });
  const never = decideSticker({
    input: { ...base, replyLength: 2000, emotionIntensity: 1 },
    state: {},
    decision: { ...DEFAULT_DECISION, cooldownMs: 0 },
    now: 1,
    random: () => 0.999999,
  });
  assert.equal(always.send, true);
  assert.equal(never.send, false);
  assert.ok(high.probability > 0);
});

test('readEmotion 识别情绪并给出强度', () => {
  assert.equal(readEmotion('搞定了，全部通过！').mood, 'celebrate');
  assert.equal(readEmotion('抱歉，这次失败了').mood, 'oops');
  assert.equal(readEmotion('让我看看这个文件').mood, 'thinking');
  assert.equal(readEmotion('哈哈，好开心😄').mood, 'happy');
  assert.equal(readEmotion('太好了，搞定！').mood, 'celebrate');
  assert.ok(readEmotion('搞定了！！！').intensity > readEmotion('搞定了').intensity);
  assert.equal(readEmotion('').mood, 'happy');
  assert.equal(readEmotion('').intensity, 0);
});

test('recordDecision 维护历史与最后发送时间', () => {
  const now = 12345;
  const triggered = recordDecision({}, { send: true }, now);
  assert.equal(triggered.lastSentAt, now);
  assert.deepEqual(triggered.history, [true]);

  const skipped = recordDecision(triggered, { send: false }, now + 1);
  assert.equal(skipped.lastSentAt, now);
  assert.deepEqual(skipped.history, [true, false]);
});

test('历史长度受控，不会无限增长', () => {
  let state = {};
  for (let index = 0; index < 500; index += 1) state = recordDecision(state, { send: index % 3 === 0 }, index);
  assert.ok(state.history.length <= 80);
});