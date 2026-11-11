/**
 * 表情包发送决策：Noisy-OR 概率模型。
 *
 * 每个特征先归一化到 e_i ∈ [0,1]，再由「单独触发概率上限」得到 p_i = pMax_i · e_i：
 *
 *   P_raw = 1 − (1 − p₀) · Π (1 − p_i)
 *   P     = clamp(P_raw · s, pMin, pMax)        s 为抑制因子（例如本轮已带图片）
 *
 * 单靠这一步在高概率时仍会连续触发，所以再加三层后处理：
 *   ① 冷却时间：触发后 T_cool 内不再触发
 *   ② 连续触发惩罚：最近 k 次已触发 m 次 → P' = P · α^m
 *   ③ 全局频率控制：最近 N 条回复的触发率超过目标 f_target → 按比例压低 P
 *
 * 所有输入都是确定的，随机源可注入（默认 mulberry32 + 种子），因此结果可复现。
 *
 * @module dsh-wx-ilink/sticker-decision
 */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const clamp01 = (value) => clamp(Number.isFinite(value) ? value : 0, 0, 1);

/** 饱和映射 1 − e^(−value/scale)，把无界量（长度、时长、轮次）压到 [0,1)。 */
export function saturate(value, scale) {
  const amount = Math.max(0, Number(value) || 0);
  if (!(scale > 0)) return amount > 0 ? 1 : 0;
  return clamp01(1 - Math.exp(-amount / scale));
}

/** mulberry32：小而确定的 PRNG，种子相同则序列相同。 */
export function mulberry32(seed) {
  let state = (Number(seed) || 0) >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 决策默认参数（全部可被 config.stickers 覆盖）。 */
export const DEFAULT_DECISION = {
  /** 没有任何特征时的基线触发概率 p₀。 */
  baseline: 0.03,
  /** 最终概率下限 / 上限。 */
  pMin: 0.01,
  pMax: 0.9,
  /** 各特征单独触发概率上限 pMax_i，以及归一化尺度。 */
  features: {
    length: { pMax: 0.45, scale: 220 },
    duration: { pMax: 0.3, scale: 8_000 },
    emotion: { pMax: 0.65 },
    turn: { pMax: 0.2, scale: 6 },
    file: { pMax: 0.2 },
    doc: { pMax: 0.15 },
  },
  /** 抑制因子：本轮已经发过图片时明显压低概率。 */
  suppression: { image: 0.3 },
  /** ① 冷却：触发后这段时间内不再触发。 */
  cooldownMs: 120_000,
  /** ② 连续触发惩罚：窗口 k 内触发 m 次，P ×= α^m。 */
  consecutive: { window: 6, alpha: 0.7 },
  /** ③ 全局频率控制：窗口 N 内触发率超过 target 时按比例压低。 */
  global: { window: 20, target: 0.15 },
  /** 随机种子；0 表示每次进程启动随机。 */
  seed: 0,
};

/** 情绪线索：命中越具体、越强，得分越高。 */
const MOOD_CUES = [
  { mood: 'celebrate', score: 0.85, patterns: [/完成|搞定|成功|通过了?|全部通过|太好了|完美|恭喜|顺利|上线/] },
  { mood: 'happy', score: 0.7, patterns: [/哈哈|开心|高兴|不错|好耶|棒|赞|😄|😊|🎉/] },
  { mood: 'oops', score: 0.65, patterns: [/抱歉|对不起|失败|出错|错误|超时|拒绝|无法|不行/] },
  { mood: 'sad', score: 0.55, patterns: [/遗憾|可惜|找不到|没找到|没有找到|丢失/] },
  { mood: 'thinking', score: 0.45, patterns: [/让我|稍等|正在|考虑|看看|分析|检查|排查/] },
  { mood: 'question', score: 0.35, patterns: [/[?？]\s*$|要不要|是否需要|你希望|可以吗/] },
];

const EMOJI_PATTERN = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

/**
 * 从回复文本里读情绪：返回情绪标签与强度。
 * 纯规则、确定性强，方便解释和调参。
 * @param {string} text - 助手回复正文。
 * @returns {{mood: string, intensity: number}} 情绪标签与 [0,1] 强度。
 */
export function readEmotion(text) {
  const source = String(text ?? '');
  let mood = '';
  let best = 0;
  for (const cue of MOOD_CUES) {
    if (!cue.patterns.some((pattern) => pattern.test(source))) continue;
    if (cue.score > best) {
      best = cue.score;
      mood = cue.mood;
    }
  }
  const exclamations = (source.match(/[!！]/g) ?? []).length;
  const emojis = (source.match(EMOJI_PATTERN) ?? []).length;
  const intensity = clamp01(best + Math.min(exclamations, 3) * 0.08 + Math.min(emojis, 3) * 0.1);
  return { mood: mood || 'happy', intensity };
}

/**
 * 把一次回复的原始信号归一化成特征向量。
 * @param {object} input - 回复长度、耗时、情绪、轮次与附件情况。
 * @param {object} decision - 决策参数。
 * @returns {object} 每个特征在 [0,1] 内。
 */
export function computeFeatures(input, decision = DEFAULT_DECISION) {
  const features = decision.features;
  return {
    length: saturate(input.replyLength, features.length.scale),
    duration: saturate(input.durationMs, features.duration.scale),
    emotion: clamp01(input.emotionIntensity),
    turn: saturate(input.turn, features.turn.scale),
    file: input.hasFile ? 1 : 0,
    doc: input.hasDoc ? 1 : 0,
  };
}

/**
 * Noisy-OR 核心：把特征与各自上限合成 P_raw。
 * @param {object} features - computeFeatures 的结果。
 * @param {object} decision - 决策参数。
 * @returns {number} [0,1] 内的原始概率。
 */
export function noisyOr(features, decision = DEFAULT_DECISION) {
  const limits = decision.features;
  let product = 1 - clamp01(decision.baseline);
  for (const [name, limit] of Object.entries(limits)) {
    if (name === 'length' || name === 'duration' || name === 'emotion' || name === 'turn' || name === 'file' || name === 'doc') {
      const feature = features[name] ?? 0;
      const p = clamp01(limit.pMax) * clamp01(feature);
      product *= 1 - p;
    }
  }
  return clamp01(1 - product);
}

/**
 * 一次完整决策：Noisy-OR + 抑制 + 三层后处理 + 采样。
 *
 * @param {object} params
 * @param {object} params.input - replyLength / durationMs / emotionIntensity / turn / hasFile / hasDoc / hasImage。
 * @param {object} params.state - `{ lastSentAt, history }`，history 是按时间顺序的触发记录。
 * @param {object} [params.decision] - 决策参数。
 * @param {number} [params.now] - 当前时间戳（毫秒），便于测试。
 * @param {() => number} [params.random] - 均匀随机源，默认按 seed 生成。
 * @returns {object} 诊断信息与 send 判定。
 */
export function decideSticker({ input, state, decision = DEFAULT_DECISION, now = Date.now(), random }) {
  const features = computeFeatures(input, decision);
  const raw = noisyOr(features, decision);

  const suppression = input.hasImage ? clamp01(decision.suppression.image) : 1;
  const afterSuppression = clamp(raw * suppression, decision.pMin, decision.pMax);

  const history = Array.isArray(state?.history) ? state.history : [];
  const lastSentAt = Number(state?.lastSentAt) || 0;

  let cooled = false;
  let afterCooldown = afterSuppression;
  // lastSentAt 为 0 表示从未发送过，此时不应进入冷却。
  if (decision.cooldownMs > 0 && lastSentAt > 0 && now - lastSentAt < decision.cooldownMs) {
    cooled = true;
    afterCooldown = 0;
  }

  const window = Math.max(1, Math.floor(decision.consecutive.window));
  const recent = history.slice(-window);
  const triggered = recent.filter(Boolean).length;
  const afterPenalty = cooled ? 0 : afterCooldown * Math.pow(clamp01(decision.consecutive.alpha), triggered);

  const globalWindow = Math.max(1, Math.floor(decision.global.window));
  const globalHistory = history.slice(-globalWindow);
  const globalCount = globalHistory.filter(Boolean).length;
  const observedRate = globalHistory.length > 0 ? globalCount / globalHistory.length : 0;
  const target = clamp01(decision.global.target);
  const rateScale = observedRate > target && target > 0 ? target / observedRate : 1;

  const probability = clamp(afterPenalty * rateScale, 0, decision.pMax);
  const generator = random ?? mulberry32((Number(decision.seed) || now) >>> 0);
  const roll = generator();
  const send = !cooled && roll < probability;

  return {
    send,
    roll,
    probability,
    raw,
    suppression,
    factors: {
      features,
      cooldown: cooled,
      recentTriggers: triggered,
      recentWindow: recent.length,
      observedRate,
      rateScale,
    },
  };
}

/** 决策后更新状态（无论是否触发都要把这一轮记进历史）。 */
export function recordDecision(state, result, now = Date.now()) {
  const history = Array.isArray(state?.history) ? [...state.history] : [];
  history.push(Boolean(result?.send));
  const limit = Math.max(
    Math.floor(DEFAULT_DECISION.global.window),
    Math.floor(DEFAULT_DECISION.consecutive.window),
  ) * 4;
  while (history.length > limit) history.shift();
  return {
    lastSentAt: result?.send ? now : (Number(state?.lastSentAt) || 0),
    history,
  };
}