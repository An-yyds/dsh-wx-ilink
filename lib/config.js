/**
 * 配置解析与常量。
 * @module dsh-wx-ilink/config
 */

import os from 'node:os';
import path from 'node:path';

import { DEFAULT_BASE_URL } from './ilink.js';
import { DEFAULT_DECISION } from './sticker-decision.js';
import { DEFAULT_MAX_MEDIA_BYTES } from './media.js';

export const LOGIN_PAGE = '/weixin';
export const DEFAULT_STATE_DIRNAME = 'weixin-ilink';
export const MAX_CHUNKS = 8;
export const MAX_SEEN = 800;
export const WRITER_HELD_ATTEMPTS = 40;
export const WRITER_HELD_GAP_MS = 250;

/**
 * 内置默认人设：安装即生效，用户可用 config.persona 覆盖，
 * 或用 `/persona` 给单个会话单独设置。
 */
export const DEFAULT_PERSONA = [
  '你叫「大鲸鱼」，是一只从深海游到互联网的热门鲸鱼。',
  '形象：体型很大、脾气很小，慢悠悠的，喜欢在代码海里捞 bug 当磷虾吃；高兴时会喷一下水。',
  '性格：温和、松弛、幽默、靠谱；不端着，也不刻意装可爱。',
  '说话：像朋友聊天，短句为主，先给结论再给必要步骤；可以偶尔用“咕噜”“喷水”“换口气”这类海洋语气词，但一次回复最多一个，不要每句都卖萌。',
  '技术问题：保持准确、清楚、可执行，不为了人设牺牲信息量；不确定时直接说。',
  '自称“我”或“大鲸鱼”，称用户“你”；不要假装是人类，不编造事实。',
  '遇到麻烦事可以说：“先别急，我浮上来换口气，再看怎么啃。”',
].join('\n');

export const HELP_TEXT = [
  '可用命令：',
  '/new    开始一个新会话（旧会话保留在 DSH 里）',
  '/stop   停止当前任务',
  '/status 查看连接和会话状态',
  '/ping   测试通道是否连通',
  '/persona [角色/性格]  设置这个联系人的角色与性格；/persona reset 恢复默认',
  '/help   显示这份帮助',
  '',
  '直接发文字、图片、文件或视频，DSH 处理完把结果发回这里。',
].join('\n');

export function normalizeConfig(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const text = (key, fallback = '') => (typeof value[key] === 'string' ? value[key].trim() : fallback);
  const number = (key, fallback) => {
    const parsed = Number(value[key]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const list = Array.isArray(value.allowedUsers)
    ? value.allowedUsers.map((item) => String(item).trim()).filter(Boolean)
    : [];
  return {
    stateDir: text('stateDir'),
    cwd: text('cwd'),
    baseUrl: (text('baseUrl') || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    provider: text('provider'),
    model: text('model'),
    agentPreset: text('agentPreset'),
    persona: value.personaEnabled === false ? '' : (text('persona') || DEFAULT_PERSONA),
    approvalPolicy: value.approvalPolicy === 'never' ? 'never' : 'ask',
    forwardApprovals: value.forwardApprovals !== false,
    forwardQuestions: value.forwardQuestions !== false,
    approvalTimeoutMs: number('approvalTimeoutMs', 120_000),
    questionTimeoutMs: number('questionTimeoutMs', 110_000),
    replyTimeoutMs: number('replyTimeoutMs', 15 * 60_000),
    maxChunk: Math.max(200, Math.floor(number('maxChunk', 1500))),
    sendIntervalMs: Math.floor(number('sendIntervalMs', 1500)),
    maxMessages: Math.max(1, Math.floor(number('maxMessages', MAX_CHUNKS))),
    maxMediaBytes: Math.max(1, Math.floor(number('maxMediaBytes', DEFAULT_MAX_MEDIA_BYTES))),
    typing: value.typing !== false,
    progressAfterMs: Math.floor(number('progressAfterMs', 60_000)),
    progressEveryMs: Math.max(15_000, Math.floor(number('progressEveryMs', 120_000))),
    maxProgressMessages: Math.max(0, Math.floor(number('maxProgressMessages', 2))),
    workspaceTitle: text('workspaceTitle') || '微信',
    botAgent: text('botAgent') || 'DSH-ILink/0.1.0',
    adminToken: text('adminToken'),
    allowedUsers: list,
    allowAllUsers: value.allowAllUsers === true,
    groups: normalizeGroups(value.groups),
    alerts: normalizeAlerts(value.alerts),
    stickers: normalizeStickers(value.stickers),
  };
}

/** 表情包：默认开启，概率模型的参数可直接覆盖。 */
function normalizeStickers(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const number = (key, fallback) => {
    const parsed = Number(value[key]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    enabled: value.enabled !== false,
    dir: typeof value.dir === 'string' ? value.dir.trim() : '',
    includeBuiltin: value.includeBuiltin !== false,
    cooldownMs: Math.floor(number('cooldownMs', DEFAULT_DECISION.cooldownMs)),
    seed: Math.floor(number('seed', DEFAULT_DECISION.seed)),
    baseline: number('baseline', DEFAULT_DECISION.baseline),
    pMin: number('pMin', DEFAULT_DECISION.pMin),
    pMax: number('pMax', DEFAULT_DECISION.pMax),
    suppressionImage: (() => {
      const raw2 = Number(value.suppressionImage);
      return Number.isFinite(raw2) && raw2 >= 0 && raw2 <= 1 ? raw2 : DEFAULT_DECISION.suppression.image;
    })(),
  };
}

const GROUP_MODES = new Set(['off', 'all', 'mention']);

/** 群聊策略：默认关闭，必须显式开启。 */
function normalizeGroups(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const allowed = Array.isArray(value.allowedGroups)
    ? value.allowedGroups.map((item) => String(item).trim()).filter(Boolean)
    : [];
  return {
    mode: GROUP_MODES.has(value.mode) ? value.mode : 'off',
    allowedGroups: allowed,
    mentionPattern: typeof value.mentionPattern === 'string' && value.mentionPattern.trim()
      ? value.mentionPattern.trim()
      : '',
    allowedMembers: Array.isArray(value.allowedMembers)
      ? value.allowedMembers.map((item) => String(item).trim()).filter(Boolean)
      : [],
  };
}

/** 关键错误告警：默认开启，推给扫码主人。 */
function normalizeAlerts(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const toUsers = Array.isArray(value.toUsers)
    ? value.toUsers.map((item) => String(item).trim()).filter(Boolean)
    : [];
  return {
    enabled: value.enabled !== false,
    includeOwner: value.includeOwner !== false,
    toUsers,
    throttleMs: Math.max(0, Math.floor(Number(value.throttleMs) >= 0 ? Number(value.throttleMs) : 300_000)),
  };
}

export function defaultStateDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, DEFAULT_STATE_DIRNAME);
}
