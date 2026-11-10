/**
 * 配置解析与常量。
 * @module dsh-wx-ilink/config
 */

import os from 'node:os';
import path from 'node:path';

import { DEFAULT_BASE_URL } from './ilink.js';
import { DEFAULT_MAX_MEDIA_BYTES } from './media.js';

export const LOGIN_PAGE = '/weixin';
export const DEFAULT_STATE_DIRNAME = 'weixin-ilink';
export const MAX_CHUNKS = 8;
export const MAX_SEEN = 800;
export const WRITER_HELD_ATTEMPTS = 40;
export const WRITER_HELD_GAP_MS = 250;

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
    persona: text('persona'),
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
