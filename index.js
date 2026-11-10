/**
 * dsh-wx-ilink — 独立的 DSH 微信 iLink 通道（Host 插件入口）。
 *
 * 数据流：
 *   手机微信扫码 → iLink bot_token
 *   → getupdates 长轮询 → 按会话主体（联系人 / 群）映射 DSH 会话
 *   → agent.followup() → whenIdle() → 从 session log 汇总最终 assistant 文本
 *   → sendmessage 回微信
 *
 * 模块划分：
 *   config      配置与常量
 *   text        纯文本 / HTTP 工具
 *   ilink       iLink 协议
 *   media       媒体下载与解密
 *   qr          二维码 SVG
 *   login       扫码登录状态机
 *   panel       本机登录页与兜底路由
 *   approval    工具审批 → 微信 1/2
 *   questions   ask_user_question → 微信逐题问答
 *   attachments 媒体 → DSH 内容块
 *   typing      “正在输入”与进度提示
 *   peers       单聊 / 群聊主体解析
 *   alerts      关键错误告警
 *
 * @module dsh-wx-ilink
 */

import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isSessionExpired,
  getUpdates,
  sendText,
  notifyStart,
  notifyStop,
  sendItems,
  uploadMedia,
  buildMediaItem,
  extractText,
  chunkText,
  sleep,
} from './lib/ilink.js';
import { StateStore } from './lib/state.js';
import { dataUrlBytes, qrDataUrl } from './lib/qr.js';
import { LoginSession } from './lib/login.js';
import { Panel } from './lib/panel.js';
import { ApprovalCenter } from './lib/approval.js';
import { QuestionCenter } from './lib/questions.js';
import { AttachmentPipeline } from './lib/attachments.js';
import { TypingCenter } from './lib/typing.js';
import { PeerRouter, isGroupKey } from './lib/peers.js';
import { AlertCenter } from './lib/alerts.js';
import { ControlTools } from './lib/control.js';
import {
  HELP_TEXT,
  LOGIN_PAGE,
  MAX_SEEN,
  WRITER_HELD_ATTEMPTS,
  WRITER_HELD_GAP_MS,
  defaultStateDir,
  normalizeConfig,
} from './lib/config.js';
import {
  isWriterHeld,
  makeUserMessage,
  reasonText,
  summarizeTurn,
  toPlainText,
} from './lib/text.js';
import { MediaTooLargeError } from './lib/media.js';

export const name = 'dsh-wx-ilink';
export const inject = ['agents', 'sessions', 'tools'];

/** 连续收消息失败达到该次数就告警。 */
const POLL_ALERT_AFTER = 3;

export class WeixinIlinkPlugin {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.stateDir = path.resolve(config.stateDir || defaultStateDir());
    this.cwd = path.resolve(config.cwd || path.join(this.stateDir, 'workspace'));
    this.store = new StateStore(this.stateDir);
    this.state = null;
    this.baseUrl = config.baseUrl;
    this.routes = [];
    this.loopRunning = false;
    this.loopController = null;
    this.loopPromise = null;
    this.queues = new Map();
    this.lastSeen = new Map();
    this.handles = new Map();
    this.seen = new Map();
    this.stopped = false;
    this.adminToken = '';

    this.login = new LoginSession(this);
    this.panel = new Panel(this);
    this.approvals = new ApprovalCenter(this);
    this.questions = new QuestionCenter(this);
    this.attachments = new AttachmentPipeline(this);
    this.typing = new TypingCenter(this);
    this.peers = new PeerRouter(this);
    this.alerts = new AlertCenter(this);
    this.control = new ControlTools(this);
  }

  get agents() {
    return this.ctx.agents;
  }

  get sessions() {
    return this.ctx.get?.('sessions');
  }

  log(level, message) {
    const line = `[dsh-wx-ilink] ${message}`;
    try {
      fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      const file = path.join(this.stateDir, 'plugin.log');
      try {
        if (fs.statSync(file).size > 256 * 1024) fs.truncateSync(file, 0);
      } catch {
        /* 文件还不存在 */
      }
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${message}\n`, { mode: 0o600 });
    } catch {
      /* 日志失败不影响主流程 */
    }
    try {
      const logger = this.ctx.logger;
      const fn = logger?.[level] ?? logger?.info;
      if (typeof fn === 'function' && logger !== console) {
        fn.call(logger, line);
        return;
      }
    } catch {
      /* ignore */
    }
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(line);
  }

  validateBaseUrl(candidate, current) {
    let next;
    try {
      next = new URL(String(candidate));
    } catch {
      throw new Error('iLink 返回了无效的服务地址');
    }
    const currentHost = (() => {
      try {
        return new URL(String(current)).hostname;
      } catch {
        return '';
      }
    })();
    const host = next.hostname;
    const official = host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com');
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    const sameHost = host === currentHost;
    if (!official && !sameHost && !local) throw new Error(`iLink 返回了不受信任的主机：${host}`);
    if (next.protocol !== 'https:' && !(local && next.protocol === 'http:')) {
      throw new Error(`iLink 服务地址必须使用 HTTPS：${next.protocol}`);
    }
    next.username = '';
    next.password = '';
    next.hash = '';
    return next.origin + next.pathname.replace(/\/+$/, '');
  }

  async start() {
    this.store.ensureDir();
    fs.mkdirSync(this.cwd, { recursive: true });
    this.state = this.store.load();
    this.baseUrl = this.state.baseUrl || this.config.baseUrl;
    if (!this.state.adminToken) this.state.adminToken = randomBytes(16).toString('hex');
    this.adminToken = this.config.adminToken || this.state.adminToken;
    this.state.adminToken = this.adminToken;
    this.store.save();

    this.registerOptionalRoutes();
    this.registerSendTool();
    this.registerControlTools();
    this.log('info', `状态目录：${this.stateDir}`);
    if (this.pageUrl()) this.log('info', `登录页：${this.pageUrl()}`);
    else this.log('info', '当前宿主没有 webServer，跳过本地网页面板；请用 weixin_login 等工具操作');
    if (this.config.groups.mode !== 'off') {
      this.log('info', `群聊已启用（mode=${this.config.groups.mode}，白名单 ${this.config.groups.allowedGroups.length || '不限'} 个）`);
    }

    if (this.state.token) {
      this.startLoop();
    } else {
      this.login.start().catch((error) => this.log('error', `登录启动失败：${error?.message ?? error}`));
    }
  }

  async stop() {
    this.stopped = true;
    this.approvals.cancelAll();
    this.questions.cancelAll();
    this.typing.clear();
    for (const dispose of this.routes.splice(0)) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    this.login.stop();
    await this.stopLoop();
    for (const [sessionId, handle] of this.handles) {
      this.handles.delete(sessionId);
      try {
        await handle?.dispose?.();
      } catch (error) {
        this.log('warn', `释放会话 ${sessionId} 失败：${error?.message ?? error}`);
      }
    }
    this.log('info', '通道已停止');
  }

  pageUrl() {
    try {
      const origin = this.ctx.get?.('webServer')?.getOrigin?.();
      if (!origin) return '';
      return `${origin}${LOGIN_PAGE}?token=${encodeURIComponent(this.adminToken)}`;
    } catch {
      return '';
    }
  }

  /**
   * 本地网页面板只在宿主提供 webServer 时注册。
   * 桌面端等没有 HTTP 服务的宿主会跳过，通道本身仍然工作。
   */
  registerOptionalRoutes() {
    try {
      this.ctx.inject(['webServer'], (webCtx) => {
        try {
          for (const route of this.panel.routes()) {
            this.routes.push(webCtx.webServer.register(route));
          }
          this.log('info', '已注册本地网页面板路由');
        } catch (error) {
          this.log('warn', `注册网页面板路由失败：${error?.message ?? error}`);
        }
      });
    } catch (error) {
      this.log('warn', `当前宿主不支持 webServer 注入：${error?.message ?? error}`);
    }
  }

  statusPayload() {
    const login = this.login.snapshot();
    const connected = Boolean(this.state?.token);
    let state = login.state;
    let message = login.message;
    if (connected) {
      state = this.loopRunning ? 'connected' : 'connecting';
      message = this.loopRunning ? '已连接微信，等待消息' : '已登录，正在连接…';
    }
    const stateText = {
      idle: '未登录',
      starting: '正在获取二维码',
      wait: '等待扫码',
      scanned: '已扫码，待确认',
      waiting_code: '正在验证验证码',
      need_code: '需要验证码',
      connected: '已连接',
      connecting: '正在连接',
      error: '出错',
    }[state] ?? state;
    return {
      ok: true,
      state,
      stateText,
      message,
      hasQr: connected ? false : login.hasQr,
      qrAt: login.qrAt,
      needCode: login.needCode,
      connected,
      botId: this.state?.botId ?? '',
      userId: this.state?.userId ?? '',
      sessions: Object.keys(this.state?.sessionMap ?? {}).length,
      queue: this.queues.size,
      approvals: this.approvals.size,
      questions: this.questions.size,
      groups: this.config.groups.mode,
      alerts: this.config.alerts.enabled,
      hasCursor: Boolean(this.state?.cursor),
      cwd: this.cwd,
    };
  }

  async applyCredentials({ token, baseUrl, botId, userId }) {
    await this.stopLoop();
    this.baseUrl = baseUrl || this.baseUrl;
    this.state.token = token;
    this.state.baseUrl = this.baseUrl;
    this.state.botId = botId || '';
    this.state.userId = userId || '';
    this.state.cursor = '';
    this.store.save();
    this.alerts.reset();
    this.startLoop();
  }

  async logout() {
    this.log('info', '退出微信登录');
    this.approvals.cancelAll();
    this.questions.cancelAll();
    this.typing.clear();
    this.login.stop();
    await this.stopLoop();
    this.state.token = '';
    this.state.botId = '';
    this.state.userId = '';
    this.state.cursor = '';
    this.state.contextTokens = {};
    this.store.save();
    this.login.start().catch((error) => this.log('error', `重新登录失败：${error?.message ?? error}`));
  }

  startLoop() {
    if (this.loopRunning || !this.state.token) return;
    this.loopRunning = true;
    this.loopController = new AbortController();
    const token = this.state.token;
    notifyStart({
      baseUrl: this.baseUrl,
      token,
      botAgent: this.config.botAgent,
      signal: this.loopController.signal,
    }).catch((error) => this.log('warn', `notifystart 失败：${error?.message ?? error}`));

    this.log('info', '开始长轮询收消息');
    this.loopPromise = (async () => {
      let failures = 0;
      let alerted = false;
      while (this.loopRunning && !this.loopController.signal.aborted) {
        try {
          const response = await getUpdates({
            baseUrl: this.baseUrl,
            token: this.state.token,
            buf: this.state.cursor,
            signal: this.loopController.signal,
            botAgent: this.config.botAgent,
          });
          failures = 0;
          alerted = false;
          const next = response?.get_updates_buf;
          if (typeof next === 'string' && next && next !== this.state.cursor) {
            this.state.cursor = next;
            this.store.save();
          }
          for (const message of response?.msgs ?? []) this.accept(message);
        } catch (error) {
          if (!this.loopRunning || this.loopController.signal.aborted) break;
          if (isSessionExpired(error)) {
            this.handleExpired();
            break;
          }
          failures += 1;
          this.log('warn', `收消息失败（第 ${failures} 次）：${error?.message ?? error}`);
          if (failures >= POLL_ALERT_AFTER && !alerted) {
            alerted = true;
            this.alerts.alert('poll-failed', `连续 ${failures} 次拉取微信消息失败：${error?.message ?? error}`, 'warn');
          }
          await sleep(Math.min(1000 * 2 ** Math.min(failures, 5), 30_000));
        }
      }
    })()
      .catch((error) => {
        if (this.loopRunning) {
          this.log('error', `消息循环异常退出：${error?.message ?? error}`);
          this.alerts.alert('loop-crashed', `微信消息循环异常退出：${error?.message ?? error}`);
        }
      })
      .finally(() => {
        this.loopRunning = false;
      });
  }

  async stopLoop() {
    this.loopRunning = false;
    try {
      this.loopController?.abort();
    } catch {
      /* ignore */
    }
    const pending = this.loopPromise;
    this.loopController = null;
    this.loopPromise = null;
    if (pending) await pending.catch(() => {});
    if (this.state?.token) {
      notifyStop({
        baseUrl: this.baseUrl,
        token: this.state.token,
        botAgent: this.config.botAgent,
      }).catch(() => {});
    }
  }

  handleExpired() {
    this.log('warn', '微信登录已过期，需要重新扫码');
    this.alerts.alert('session-expired', '微信登录已过期（bot_token 失效），通道已暂停，请在 DSH 面板重新扫码登录。');
    this.approvals.cancelAll();
    this.questions.cancelAll();
    this.typing.clear();
    this.loopRunning = false;
    this.state.token = '';
    this.state.cursor = '';
    this.store.save();
    this.login.stop();
    this.login.start().catch((error) => this.log('error', `重新登录失败：${error?.message ?? error}`));
  }

  isAllowed(from) {
    if (this.config.allowAllUsers) return true;
    if (this.config.allowedUsers.length) return this.config.allowedUsers.includes(from);
    if (this.state?.userId) return from === this.state.userId;
    return true;
  }

  accept(message) {
    if (!message || typeof message !== 'object') return;
    if (message.message_type !== 1) return;
    if (message.message_state === 1) return;
    if (message.to_user_id && !String(message.to_user_id).endsWith('@im.bot')) return;

    const id = String(message.message_id ?? message.msg_id ?? message.seq ?? '');
    if (id) {
      if (this.seen.has(id)) return;
      this.seen.set(id, Date.now());
      if (this.seen.size > MAX_SEEN) {
        const cutoff = Date.now() - 10 * 60_000;
        for (const [key, at] of this.seen) if (at < cutoff) this.seen.delete(key);
      }
    }

    const text = extractText(message);
    const trimmed = text.trim();
    const peer = this.peers.resolve(message, trimmed);
    if (peer.ignored) {
      if (peer.ignored !== 'group-disabled' && !String(peer.ignored).startsWith('not-mentioned')) {
        this.log('info', `忽略消息（${peer.ignored}）`);
      }
      return;
    }

    // 群聊：群策略已在 peers.resolve 里校验；单聊：走 allowedUsers。
    if (peer.kind === 'dm' && !this.isAllowed(peer.sender)) {
      this.deliver(peer.sendTo, `未授权。你的微信 ID 是：${peer.sender}\n只允许 bot 主人使用；管理员可在 allowedUsers 里加入你。`, message.context_token).catch(() => {});
      return;
    }
    if (peer.kind === 'group') {
      // 群内只允许被允许的成员（默认全部允许）
      const members = this.config.groups.allowedMembers;
      if (Array.isArray(members) && members.length && !members.includes(peer.sender)) {
        this.log('info', `忽略群 ${peer.groupTail} 中未授权成员 ${peer.senderTail}`);
        return;
      }
    }

    this.lastSeen.set(peer.key, Date.now());
    if (message.context_token) {
      this.state.contextTokens[peer.key] = message.context_token;
      this.store.save();
    }
    const token = message.context_token || this.state.contextTokens[peer.key] || '';

    // 群聊：把发言人带进正文，模型才知道是谁在说。
    const body = peer.kind === 'group' && trimmed
      ? `[群聊 ${peer.groupTail} · 成员 ${peer.senderTail}] ${trimmed}`
      : trimmed;
    const media = this.mediaOf(message);

    if (this.questions.has(peer.key)) {
      if (trimmed === '/stop') {
        this.questions.cancelQuestion(peer.key);
        this.stopCurrent(peer.key, token).catch(() => {});
        return;
      }
      if (trimmed) {
        this.questions.resolveQuestion(peer.key, trimmed);
        return;
      }
      this.reply(peer.sendTo, '请用文字回答上面的问题。', token).catch(() => {});
      return;
    }

    if (this.approvals.has(peer.key)) {
      if (trimmed === '/stop') {
        this.approvals.cancelApproval(peer.key, 'cancelled');
        this.stopCurrent(peer.key, token).catch(() => {});
        return;
      }
      if (this.approvals.resolveApproval(peer.key, trimmed)) return;
      if (trimmed || media.length) {
        this.reply(peer.sendTo, '现在有一条工具审批在等你：回复 1 允许一次，回复 2 拒绝。', token).catch(() => {});
      }
      return;
    }

    if (!trimmed && media.length === 0) {
      this.reply(peer.sendTo, '这条消息没有可读取的文字或媒体。', token).catch(() => {});
      return;
    }
    if (trimmed === '/help' || trimmed === '帮助') {
      this.reply(peer.sendTo, HELP_TEXT, token).catch(() => {});
      return;
    }
    if (trimmed === '/status') {
      this.reply(peer.sendTo, this.statusText(peer.key), token).catch(() => {});
      return;
    }
    if (trimmed === '/stop') {
      this.stopCurrent(peer.key, token).catch(() => {});
      return;
    }
    if (trimmed === '/new') {
      this.enqueue(peer.key, () => this.newChat(peer.key, token));
      return;
    }
    if (trimmed === '/ping') {
      this.reply(peer.sendTo, `长江收到 · ${new Date().toISOString()}`, token).catch(() => {});
      return;
    }
    const personaMatch = trimmed.match(/^\/(?:persona|role|人设)(?:\s+([\s\S]*))?$/i);
    if (personaMatch) {
      this.personaCommand(peer.key, (personaMatch[1] ?? '').trim(), token).catch(() => {});
      return;
    }

    this.enqueue(peer.key, () => this.handlePrompt(peer.key, body, token, media));
  }

  mediaOf(message) {
    try {
      return this.attachments.describeInbound(message);
    } catch {
      return [];
    }
  }

  enqueue(peer, task) {
    const previous = this.queues.get(peer) ?? Promise.resolve();
    const run = previous
      .then(task)
      .catch(async (error) => {
        this.log('error', `处理 ${this.peers.label(peer)} 的消息失败：${error?.message ?? error}`);
        await this.reply(peer, `处理失败：${error?.message ?? error}`, this.state.contextTokens[peer]).catch(() => {});
      })
      .finally(() => {
        if (this.queues.get(peer) === run) this.queues.delete(peer);
      });
    this.queues.set(peer, run);
  }

  async personaCommand(peer, value, token) {
    if (!value || value === 'show' || value === '查看') {
      const custom = this.state.personas?.[peer];
      const current = this.personaFor(peer);
      const source = typeof custom === 'string' && custom.trim() ? '当前会话单独设置' : (this.config.persona ? '插件默认人设' : '未设置');
      await this.reply(peer, current
        ? `当前人设（${source}）：\n${current}\n\n修改：/persona 你叫长江，语气...\n恢复默认：/persona reset`
        : '还没有设置人设。\n用法：/persona 你叫长江，说话像一位耐心幽默的老朋友；\n恢复默认：/persona reset', token);
      return;
    }
    if (value === 'reset' || value === 'clear' || value === '默认') {
      if (this.state.personas) delete this.state.personas[peer];
      this.store.save();
      const fallback = this.config.persona;
      await this.reply(peer, fallback ? `已清除单独设置，恢复插件默认人设：\n${fallback}` : '已清除人设，恢复默认的 DSH 助手语气。', token);
      return;
    }
    if (!this.state.personas) this.state.personas = {};
    this.state.personas[peer] = value.slice(0, 4000);
    this.store.save();
    await this.reply(peer, `人设已更新，下一条消息生效：\n${this.state.personas[peer]}`, token);
  }

  async newChat(peer, token) {
    if (this.state.sessionMap[peer]) {
      delete this.state.sessionMap[peer];
      this.store.save();
      await this.reply(peer, '已开始新会话。旧会话保留在 DSH 里，下一条消息进入全新的上下文。', token);
      return;
    }
    await this.reply(peer, '还没有旧会话，直接发消息就会创建新会话。', token);
  }

  async stopCurrent(peer, token) {
    const sessionId = this.state.sessionMap[peer];
    const agent = sessionId ? this.agents.get?.(sessionId) : undefined;
    if (!agent) {
      await this.reply(peer, '当前没有正在执行的任务。', token);
      return;
    }
    try {
      agent.cancel({ kind: 'user' });
      await this.reply(peer, '已请求停止当前任务。', token);
    } catch (error) {
      await this.reply(peer, `停止失败：${error?.message ?? error}`, token);
    }
  }

  statusText(peer) {
    const sessionId = this.state.sessionMap[peer];
    const agent = sessionId ? this.agents.get?.(sessionId) : undefined;
    const model = agent?.options?.provider && agent?.options?.model
      ? `${agent.options.provider}/${agent.options.model}`
      : '跟随 DSH 默认';
    return [
      '微信 iLink 状态',
      `主体：${this.peers.label(peer)}`,
      `连接：${this.loopRunning ? '已连接' : '未连接'}`,
      `微信 ID：${peer}`,
      `会话：${sessionId ?? '还没有（发一条消息创建）'}`,
      `状态：${agent?.status ?? '无'}`,
      `模型：${model}`,
      `排队：${this.queues.size} 个主体`,
      `审批等待：${this.approvals.size}`,
      `提问等待：${this.questions.size}`,
      `群聊：${this.config.groups.mode}`,
      `工作目录：${this.cwd}`,
    ].join('\n');
  }

  agentOptions() {
    if (this.config.provider && this.config.model) {
      return { provider: this.config.provider, model: this.config.model };
    }
    try {
      const selection = this.ctx.get?.('agentDefaultModel')?.currentSelection?.();
      if (selection?.provider && selection?.model) {
        return {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        };
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  async resolvePreset(explicit) {
    const presets = this.ctx.get?.('agentPresets');
    if (!presets?.resolve) return undefined;
    try {
      const resolved = await presets.resolve(explicit || this.config.agentPreset || undefined);
      return resolved?.id;
    } catch (error) {
      this.log('warn', `解析 Agent 预设失败：${error?.message ?? error}`);
      return undefined;
    }
  }

  async storedPreset(sessionId) {
    try {
      const query = this.ctx.get?.('sessionQuery');
      const observation = await query?.observeSession?.(sessionId);
      const value = observation?.projections?.values?.agentPreset;
      return typeof value === 'string' && value ? value : undefined;
    } catch {
      return undefined;
    }
  }

  personaFor(peer) {
    const custom = this.state?.personas?.[peer];
    if (typeof custom === 'string' && custom.trim()) return custom.trim();
    return this.config.persona || '';
  }

  async setupAgent(agentCtx, sessionId, presetId, peer) {
    if (presetId) {
      try {
        await this.ctx.get?.('agentPresets')?.mount?.(agentCtx, presetId);
      } catch (error) {
        this.log('warn', `挂载 Agent 预设「${presetId}」失败：${error?.message ?? error}`);
      }
    }
    try {
      agentCtx.systemPrompt?.section?.({
        name: 'dsh-wx-ilink:persona',
        order: 48,
        interpolate: false,
        text: () => {
          const persona = this.personaFor(peer);
          if (!persona) return '';
          return [
            '以下是微信用户为这个对话设定的角色与性格，请在微信回复中遵循。',
            '它优先于通用的编程助手语气，但不得改变工具使用、事实准确性和安全规则。',
            persona,
          ].join('\n\n');
        },
      });
    } catch (error) {
      this.log('warn', `注入人设失败：${error?.message ?? error}`);
    }
    try {
      const inGroup = isGroupKey(peer);
      agentCtx.systemPrompt?.section?.({
        name: 'dsh-wx-ilink:channel',
        order: 50,
        text: [
          inGroup
            ? '你正在一个微信群里与多位成员对话：消息会带上「[群聊 xx · 成员 xx]」前缀标明发言人。'
            : '你正在通过微信与用户对话：异步、回合式。',
          '你可以收发文字、图片、文件和视频。',
          '需要用户确认或选择时可以用 ask_user_question，DSH 会把问题转发到微信；能直接用文字问清时也可以直接问。',
          '需要用户授权时，DSH 会把审批请求发到微信，用户可用 1/2 回复；你只需正常调用工具。',
          '需要把图片、视频或文件发给用户时，先写到会话工作目录，再调用 send_weixin_file 工具。',
          inGroup ? '群里回复要简短，避免输出大段代码或日志。' : '回复要简洁，避免大段 Markdown。',
        ].join('\n'),
      });
    } catch (error) {
      this.log('warn', `注入通道提示失败：${error?.message ?? error}`);
    }
    try {
      if (this.config.forwardApprovals) {
        agentCtx.on?.('approval/request', (request, next) => {
          if (!request?.agent || request.agent.id !== sessionId) return next();
          return this.approvals.forwardApproval(request, peer);
        }, { prepend: true });
      }
    } catch (error) {
      this.log('warn', `注册审批转发失败：${error?.message ?? error}`);
    }
    try {
      if (this.config.forwardQuestions) {
        agentCtx.on?.('user-questions/request', (request, next) => {
          if (!request?.agent || request.agent.id !== sessionId) return next();
          if (!peer) return next();
          return this.questions.forwardQuestion(request, peer);
        }, { prepend: true });
      }
    } catch (error) {
      this.log('warn', `注册提问转发失败：${error?.message ?? error}`);
    }
  }

  registerSendTool() {
    try {
      this.ctx.tools?.register?.({
        name: 'send_weixin_file',
        description: '把本地图片、视频或文件发送到当前微信会话（联系人或群）。文件必须在会话工作目录或 DSH 附件目录内；发送前先用 write/bash 生成文件。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: '本地文件路径；相对路径以会话工作目录为基准。' },
          },
          required: ['path'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string' },
              name: { type: 'string' },
              kind: { type: 'string' },
              bytes: { type: 'integer' },
            },
            required: ['path', 'name', 'kind', 'bytes'],
          },
          render: (_args, value) => [{ type: 'text', text: `已发送微信文件「${value.name}」（${value.kind}，${value.bytes} 字节）` }],
        },
        execute: async (args, exec) => {
          const peer = this.peerOfSession(exec.agent?.id);
          if (!peer) throw new Error('send_weixin_file 只能用于微信会话');
          return this.sendLocalFile(peer, String(args?.path ?? ''), exec.signal);
        },
      });
    } catch (error) {
      this.log('warn', `注册 send_weixin_file 失败：${error?.message ?? error}`);
    }
  }

  registerControlTools() {
    try {
      this.control.register();
    } catch (error) {
      this.log('warn', `注册微信控制工具失败：${error?.message ?? error}`);
    }
  }

  peerOfSession(sessionId) {
    if (!sessionId) return undefined;
    return Object.keys(this.state?.sessionMap ?? {}).find((key) => this.state.sessionMap[key] === sessionId);
  }

  allowedFileRoots() {
    const roots = [this.cwd];
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    roots.push(path.join(home, 'attachments'));
    return roots;
  }

  async sendLocalFile(peer, requested, signal) {
    if (!this.state?.token) throw new Error('微信尚未登录');
    if (!requested || !requested.trim()) throw new Error('缺少文件路径');
    const target = path.resolve(this.cwd, requested);
    let real;
    try {
      real = await fs.promises.realpath(target);
    } catch {
      throw new Error(`文件不存在：${requested}`);
    }
    const roots = await Promise.all(this.allowedFileRoots().map(async (root) => {
      try {
        return await fs.promises.realpath(root);
      } catch {
        return path.resolve(root);
      }
    }));
    if (!roots.some((root) => real === root || real.startsWith(root + path.sep))) {
      throw new Error('只能发送会话工作目录或 DSH 附件目录内的文件');
    }
    const stat = await fs.promises.stat(real);
    if (!stat.isFile()) throw new Error(`不是普通文件：${requested}`);
    if (stat.size > this.config.maxMediaBytes) {
      throw new Error(`文件超过 ${Math.round(this.config.maxMediaBytes / 1024 / 1024)}MB 上限`);
    }
    const extension = path.extname(real).toLowerCase();
    const kind = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(extension)
      ? 'image'
      : ['.mp4', '.mov'].includes(extension) ? 'video' : 'file';
    const data = await fs.promises.readFile(real);
    const uploaded = await uploadMedia({
      baseUrl: this.baseUrl,
      token: this.state.token,
      to: this.peers.sendTarget(peer),
      data,
      mediaType: kind === 'image' ? 1 : kind === 'video' ? 2 : 3,
      botAgent: this.config.botAgent,
      signal,
    });
    await sendItems({
      baseUrl: this.baseUrl,
      token: this.state.token,
      to: this.peers.sendTarget(peer),
      items: [buildMediaItem(kind, uploaded, path.basename(real))],
      contextToken: this.state.contextTokens[peer] || '',
      botAgent: this.config.botAgent,
      signal,
    });
    this.log('info', `已向 ${this.peers.label(peer)} 发送${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '文件'}：${path.basename(real)}（${data.length} 字节）`);
    return { path: real, name: path.basename(real), kind, bytes: data.length };
  }

  applyApproval(agent) {
    const policy = this.config.forwardApprovals && this.config.approvalPolicy !== 'never' ? 'ask' : 'never';
    try {
      this.ctx.get?.('approval')?.setPolicy?.(agent, policy);
    } catch (error) {
      this.log('warn', `设置审批策略失败：${error?.message ?? error}`);
    }
  }

  /** 把会话挂进与 cwd 对应的工作区，并（仅新建时）设置标题。 */
  async attachWorkspace(agent, peer, setTitle) {
    try {
      const registry = this.ctx.get?.('workspaceRegistry');
      if (registry?.create) {
        const workspace = await registry.create(this.cwd, this.config.workspaceTitle);
        if (workspace && !workspace.sessionIds?.includes?.(agent.id)) {
          await workspace.attachSession?.(agent.id);
          this.log('info', `会话 ${agent.id} 已归入工作区「${workspace.title ?? ''}」`);
        }
      }
      if (setTitle) {
        const titles = this.ctx.get?.('sessionTitle');
        const prefix = isGroupKey(peer) ? '微信群' : '微信';
        await titles?.rename?.(agent.session, `${prefix}·${this.peers.titleSuffix(peer)}`);
      }
    } catch (error) {
      this.log('warn', `归入工作区/设置标题失败：${error?.message ?? error}`);
    }
  }

  async createAgent(peer) {
    const sessionId = `session-${randomUUID()}`;
    const options = this.agentOptions();
    const presetId = await this.resolvePreset();
    if (presetId) this.log('info', `新会话使用 Agent 预设「${presetId}」`);
    const handle = await this.agents.create({
      sessionId,
      meta: { cwd: this.cwd, ...(presetId ? { agentPreset: presetId } : {}) },
      ...(options ? { agentOptions: options } : {}),
      setup: (agentCtx) => this.setupAgent(agentCtx, sessionId, presetId, peer),
    });
    this.handles.set(sessionId, handle);
    this.state.sessionMap[peer] = sessionId;
    this.store.save();
    this.applyApproval(handle.agent);
    await this.attachWorkspace(handle.agent, peer, true);
    this.log('info', `为 ${this.peers.label(peer)} 新建会话 ${sessionId}`);
    return handle.agent;
  }

  async resumeAgent(sessionId, peer) {
    const options = this.agentOptions();
    const presetId = (await this.storedPreset(sessionId)) ?? (await this.resolvePreset());
    if (presetId) this.log('info', `恢复会话使用 Agent 预设「${presetId}」`);
    let lastError;
    for (let attempt = 0; attempt < WRITER_HELD_ATTEMPTS; attempt += 1) {
      const live = this.agents.get?.(sessionId);
      if (live) {
        this.applyApproval(live);
        await this.attachWorkspace(live, peer, false);
        return live;
      }
      try {
        const handle = await this.agents.resume({
          resumeSessionId: sessionId,
          ...(options ? { agentOptions: options } : {}),
          setup: (agentCtx) => this.setupAgent(agentCtx, sessionId, presetId, peer),
        });
        if (handle?.error) throw handle.error;
        if (!handle?.agent) throw new Error('恢复会话没有返回 agent');
        this.handles.set(sessionId, handle);
        this.applyApproval(handle.agent);
        await this.attachWorkspace(handle.agent, peer, false);
        return handle.agent;
      } catch (error) {
        lastError = error;
        if (!isWriterHeld(error) || attempt === WRITER_HELD_ATTEMPTS - 1) throw error;
        await sleep(WRITER_HELD_GAP_MS);
      }
    }
    throw lastError ?? new Error(`无法恢复会话 ${sessionId}`);
  }

  async ensureAgent(peer) {
    const mapped = this.state.sessionMap[peer];
    if (mapped) {
      try {
        return await this.resumeAgent(mapped, peer);
      } catch (error) {
        if (isWriterHeld(error)) {
          throw new Error('这个会话正在 DSH 网页端使用，请等那边结束后再发消息');
        }
        this.log('warn', `恢复会话 ${mapped} 失败，将新建：${error?.message ?? error}`);
      }
    }
    return this.createAgent(peer);
  }

  async waitForTurnStart(agent, firstSeq, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (agent.status === 'running' || agent.session.seq > firstSeq) return true;
      await sleep(25);
    }
    return false;
  }

  async waitIdle(agent, timeoutMs) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const idle = agent.whenIdle().then(() => true).catch(() => false);
    const ok = await Promise.race([idle, timeout]);
    if (timer) clearTimeout(timer);
    if (ok) return true;
    try {
      agent.cancel({ kind: 'hook', reason: 'dsh-wx-ilink: reply timeout' });
    } catch {
      /* ignore */
    }
    await Promise.race([agent.whenIdle().catch(() => {}), sleep(3000)]);
    return false;
  }

  async handlePrompt(peer, text, contextToken, mediaRefs = []) {
    const agent = await this.ensureAgent(peer);
    if (agent.status && agent.status !== 'idle') {
      const ok = await this.waitIdle(agent, 60_000);
      if (!ok) {
        await this.reply(peer, '这个会话正在执行别的任务，请稍后再试。', contextToken);
        return;
      }
    }

    const built = await this.attachments.buildParts(peer, mediaRefs, agent);
    const content = [];
    if (text) content.push({ type: 'text', text });
    if (built.parts.length) {
      if (!text) content.push({ type: 'text', text: `（用户通过微信发来了${built.label}，没有附带文字）` });
      content.push(...built.parts);
      if (built.notes.length) content.push({ type: 'text', text: built.notes.join('\n') });
    }
    if (!content.length) content.push({ type: 'text', text: '（空消息）' });

    const stopProgress = this.typing.progress(peer, contextToken);
    this.typing.start(peer, contextToken);
    try {
      const firstSeq = agent.session.seq;
      try {
        agent.followup(makeUserMessage(content, peer));
      } catch (error) {
        await this.reply(peer, `提交任务失败：${error?.message ?? error}`, contextToken);
        return;
      }
      await this.waitForTurnStart(agent, firstSeq, 3000);
      const finished = await this.waitIdle(agent, this.config.replyTimeoutMs);
      if (!finished) {
        stopProgress();
        await this.reply(peer, '处理超时，已经请求停止。可以稍后发 /status 查看，或发 /new 开新会话。', contextToken);
        return;
      }

      const { text: answer, reason } = summarizeTurn(agent.session, firstSeq);
      const body = answer.trim() || reasonText(reason) || '（这一轮没有产生文字回复）';
      stopProgress();
      await this.reply(peer, body, contextToken);
    } finally {
      stopProgress();
      this.typing.stop(peer);
      try {
        await this.sessions?.flush?.(agent.session);
      } catch {
        /* ignore */
      }
    }
  }

  /** 面向会话主体的回复：负责分片、限流间隔与失败告警。 */
  async reply(peer, text, contextToken) {
    try {
      await this.deliver(this.peers.sendTarget(peer), text, contextToken);
    } catch (error) {
      if (isSessionExpired(error)) {
        this.handleExpired();
        throw error;
      }
      this.alerts.alert('send-failed', `回复 ${this.peers.label(peer)} 失败：${error?.message ?? error}`);
      throw error;
    }
  }

  /** 直接向某个微信 id 发送（告警、未授权提示用，避免递归告警）。 */
  async deliver(target, text, contextToken) {
    if (!this.state?.token) {
      this.log('warn', `没有 bot_token，无法回复 ${String(target).slice(0, 12)}…`);
      return;
    }
    const plain = toPlainText(text);
    if (!plain) return;
    let parts = chunkText(plain, this.config.maxChunk);
    if (parts.length > this.config.maxMessages) {
      parts = parts.slice(0, this.config.maxMessages);
      parts[parts.length - 1] += '\n…（内容过长，已截断）';
    }
    for (let index = 0; index < parts.length; index += 1) {
      await this.sendPart(target, parts[index], contextToken);
      if (index < parts.length - 1 && this.config.sendIntervalMs > 0) {
        await sleep(this.config.sendIntervalMs);
      }
    }
  }

  async sendPart(target, text, contextToken) {
    try {
      await sendText({
        baseUrl: this.baseUrl,
        token: this.state.token,
        to: target,
        text,
        contextToken,
        botAgent: this.config.botAgent,
        onWarn: (message) => this.log('warn', message),
      });
    } catch (error) {
      if (isSessionExpired(error)) throw error;
      if (contextToken) {
        this.log('warn', `带 context_token 发送失败，重试一次：${error?.message ?? error}`);
        await sendText({
          baseUrl: this.baseUrl,
          token: this.state.token,
          to: target,
          text,
          botAgent: this.config.botAgent,
          onWarn: (message) => this.log('warn', message),
        });
        return;
      }
      throw error;
    }
  }
}

/* ------------------------------ 入口 ------------------------------ */

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const plugin = new WeixinIlinkPlugin(ctx, config);
  ctx.effect(() => {
    plugin.start().catch((error) => plugin.log('error', `启动失败：${error?.message ?? error}`));
    return () => plugin.stop();
  });
  return plugin;
}
