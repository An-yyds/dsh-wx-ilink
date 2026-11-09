/**
 * dsh-wx-ilink — 独立的 DSH 微信 iLink 通道。
 *
 * 数据流：
 *   手机微信扫码 → iLink bot_token
 *   → getupdates 长轮询 → 按微信联系人映射/创建 DSH 会话
 *   → agent.followup() → whenIdle() → 从 session log 汇总最终 assistant 文本
 *   → sendmessage 回微信
 *
 * 登录页：GET /weixin?token=<adminToken>（token 在启动日志里，持久化在 state.json）。
 * 支持文字、图片、文件、视频；语音用微信服务端转写文本。工具审批可转发到微信。
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  DEFAULT_BASE_URL,
  ILinkError,
  isSessionExpired,
  getQrCode,
  getQrStatus,
  getUpdates,
  sendText,
  notifyStart,
  notifyStop,
  getConfig,
  sendTyping,
  sendItems,
  uploadMedia,
  buildMediaItem,
  extractText,
  chunkText,
  sleep,
} from './lib/ilink.js';
import { StateStore } from './lib/state.js';
import { qrSvg } from './lib/qr.js';
import {
  DEFAULT_MAX_MEDIA_BYTES,
  MediaTooLargeError,
  describeMedia,
  fetchMedia,
  sniffImageMime,
} from './lib/media.js';

export const name = 'dsh-wx-ilink';
export const inject = ['agents', 'sessions', 'webServer', 'tools'];

const LOGIN_PAGE = '/weixin';
const DEFAULT_STATE_DIRNAME = 'weixin-ilink';
const MAX_CHUNKS = 8;
const MAX_SEEN = 800;
const WRITER_HELD_ATTEMPTS = 40;
const WRITER_HELD_GAP_MS = 250;

const HELP_TEXT = [
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

function normalizeConfig(raw) {
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
  };
}

function defaultStateDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, DEFAULT_STATE_DIRNAME);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('body is not JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendTextResponse(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function isWriterHeld(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'SessionAlreadyOwnedError' || error.code === 'session/writer-held') return true;
  return /already owned by an active write handle|writer.?held/i.test(String(error.message ?? ''));
}

function makeUserMessage(content, peer) {
  return {
    id: `msg-${randomUUID()}`,
    role: 'user',
    content,
    source: { kind: 'user', channel: 'dsh-wx-ilink', peer },
  };
}

function sanitizeMediaName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 120);
  return cleaned || `weixin-media-${Date.now()}`;
}

/** 把模型常见的 Markdown 降到微信里可读的纯文本。 */
function toPlainText(text) {
  return String(text ?? '')
    .replace(/```[a-zA-Z0-9_+-]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .trim();
}

/** 汇总从 firstSeq 开始这一轮的最后一条 assistant 文本和 turn/end 原因。 */
function summarizeTurn(session, firstSeq) {
  const end = session.seq;
  let text = '';
  let reason;
  let started = false;
  for (let seq = firstSeq; seq < end; seq += 1) {
    const event = session.eventAt(seq);
    if (!event) continue;
    if (event.type === 'turn/start') {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content ?? [];
      const joined = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      if (joined) text = joined;
    }
    if (event.type === 'turn/end') reason = event.data?.reason;
  }
  return { text, reason };
}

function reasonText(reason) {
  if (!reason) return '';
  if (reason.kind === 'error') {
    const code = reason.error?.code ? `${reason.error.code}: ` : '';
    return `执行失败：${code}${reason.error?.message ?? '未知错误'}`;
  }
  if (reason.kind === 'aborted') return '任务已取消。';
  if (reason.kind === 'blocked') return '任务被阻塞。';
  return '';
}

/* ------------------------------ 登录 ------------------------------ */

class LoginSession {
  constructor(plugin) {
    this.plugin = plugin;
    this.state = 'idle';
    this.message = '未登录';
    this.qrCode = '';
    this.qrContent = '';
    this.qrAt = 0;
    this.pendingCode = '';
    this.running = false;
    this.runId = 0;
    this.pollingRunId = 0;
    this.controller = null;
    this.refreshes = 0;
  }

  snapshot() {
    return {
      state: this.state,
      message: this.message,
      hasQr: Boolean(this.qrContent) && this.state !== 'connected',
      qrAt: this.qrAt,
      needCode: this.state === 'need_code',
    };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.runId += 1;
    const runId = this.runId;
    this.pollingRunId = 0;
    this.state = 'starting';
    this.message = '正在获取登录二维码…';
    this.qrCode = '';
    this.qrContent = '';
    this.qrAt = 0;
    this.pendingCode = '';
    this.refreshes = 0;
    this.controller = new AbortController();
    this.plugin.log('info', '开始微信扫码登录');
    try {
      await this.loadQr();
      if (runId !== this.runId) return;
      this.state = 'wait';
      this.message = '请用手机微信扫一扫';
      this.launchPoll(runId);
    } catch (error) {
      if (runId !== this.runId) return;
      this.running = false;
      this.state = 'error';
      this.message = `获取二维码失败：${error?.message ?? error}`;
      this.plugin.log('error', this.message);
    }
  }

  async loadQr() {
    const result = await getQrCode({
      baseUrl: this.plugin.baseUrl,
      tokenList: this.plugin.state.token ? [this.plugin.state.token] : [],
      signal: this.controller?.signal,
    });
    this.qrCode = result.qrcode;
    this.qrContent = result.content;
    this.qrAt = Date.now();
  }

  stop() {
    this.running = false;
    this.runId += 1;
    this.pollingRunId = 0;
    this.state = 'idle';
    this.message = '未登录';
    this.qrCode = '';
    this.qrContent = '';
    this.qrAt = 0;
    try {
      this.controller?.abort();
    } catch {
      /* ignore */
    }
    this.controller = null;
  }

  submitCode(code) {
    const value = String(code ?? '').trim();
    if (!value) return { ok: false, message: '请输入手机微信上的数字验证码' };
    if (this.state !== 'need_code' && this.state !== 'waiting_code') {
      return { ok: false, message: '当前不需要验证码' };
    }
    this.pendingCode = value;
    this.state = 'waiting_code';
    this.message = '正在验证验证码…';
    this.launchPoll(this.runId);
    return { ok: true, message: '已提交验证码' };
  }

  launchPoll(runId) {
    if (runId !== this.runId || this.pollingRunId === runId) return;
    this.pollingRunId = runId;
    this.poll(runId)
      .catch((error) => {
        if (runId !== this.runId) return;
        this.state = 'error';
        this.message = `登录失败：${error?.message ?? error}`;
        this.running = false;
        this.plugin.log('error', this.message);
      })
      .finally(() => {
        if (this.pollingRunId === runId) this.pollingRunId = 0;
      });
  }

  async poll(runId) {
    let failures = 0;
    while (this.running && runId === this.runId && this.controller && !this.controller.signal.aborted) {
      let status;
      try {
        status = await getQrStatus({
          baseUrl: this.plugin.baseUrl,
          qrcode: this.qrCode,
          verifyCode: this.pendingCode,
          signal: this.controller.signal,
        });
        failures = 0;
      } catch (error) {
        if (runId !== this.runId) return;
        if (this.controller?.signal.aborted) return;
        failures += 1;
        if (failures >= 3) {
          this.state = 'error';
          this.message = `登录轮询失败：${error?.message ?? error}`;
          this.running = false;
          return;
        }
        await sleep(1000 * failures);
        continue;
      }

      const value = status?.status;
      if (value === 'wait') {
        this.state = 'wait';
        this.message = '请用手机微信扫一扫';
      } else if (value === 'scaned') {
        this.state = 'scanned';
        this.message = '已扫码，请在手机上确认登录';
      } else if (value === 'scaned_but_redirect') {
        if (status?.redirect_host) {
          const next = this.plugin.validateBaseUrl(`https://${status.redirect_host}`, this.plugin.baseUrl);
          this.plugin.baseUrl = next;
          this.plugin.log('info', `登录节点切换到 ${status.redirect_host}`);
        }
      } else if (value === 'need_verifycode') {
        this.state = 'need_code';
        this.message = this.pendingCode
          ? '验证码不正确，请重新输入手机微信上显示的数字'
          : '手机微信显示了数字验证码，请在下方输入';
        this.pendingCode = '';
        return;
      } else if (value === 'verify_code_blocked') {
        this.pendingCode = '';
        this.refreshes += 1;
        if (this.refreshes > 3) {
          this.state = 'error';
          this.message = '验证码错误次数过多，请点击“重新登录”';
          this.running = false;
          return;
        }
        await this.refreshQr('验证码错误次数过多，二维码已刷新，请重新扫码');
      } else if (value === 'expired') {
        this.refreshes += 1;
        if (this.refreshes > 3) {
          this.state = 'error';
          this.message = '二维码多次过期，请点击“重新登录”';
          this.running = false;
          return;
        }
        await this.refreshQr('二维码已刷新，请重新扫码');
      } else if (value === 'binded_redirect') {
        if (this.plugin.state.token) {
          this.state = 'connected';
          this.message = '这个微信已经绑定，沿用现有凭据';
          this.running = false;
          this.plugin.startLoop();
          return;
        }
        this.refreshes += 1;
        if (this.refreshes > 3) {
          this.state = 'error';
          this.message = '这个微信已绑定其它机器人，无法获取新凭据';
          this.running = false;
          return;
        }
        await this.refreshQr('该微信已绑定其它机器人，刷新二维码…');
      } else if (value === 'confirmed') {
        const token = status?.bot_token ?? status?.token;
        if (!token) {
          this.state = 'error';
          this.message = '服务端没有返回 bot_token';
          this.running = false;
          return;
        }
        const baseUrl = this.plugin.validateBaseUrl(status?.baseurl || this.plugin.baseUrl, this.plugin.baseUrl);
        await this.plugin.applyCredentials({
          token,
          baseUrl,
          botId: status?.ilink_bot_id ?? '',
          userId: status?.ilink_user_id ?? '',
        });
        this.qrContent = '';
        this.qrAt = 0;
        this.state = 'connected';
        this.message = '登录成功';
        this.running = false;
        this.plugin.log('info', `微信登录成功${this.plugin.state.botId ? `（${this.plugin.state.botId}）` : ''}`);
        return;
      } else {
        this.state = 'wait';
        this.message = '等待扫码…';
      }
    }
  }

  async refreshQr(message) {
    this.message = message;
    await this.loadQr();
    this.pendingCode = '';
    this.state = 'wait';
    this.message = message;
  }
}

/* ------------------------------ 插件主体 ------------------------------ */

class WeixinIlinkPlugin {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.stateDir = path.resolve(config.stateDir || defaultStateDir());
    this.cwd = path.resolve(config.cwd || path.join(this.stateDir, 'workspace'));
    this.store = new StateStore(this.stateDir);
    this.state = null;
    this.baseUrl = config.baseUrl;
    this.login = new LoginSession(this);
    this.routes = [];
    this.loopRunning = false;
    this.loopController = null;
    this.loopPromise = null;
    this.queues = new Map();
    this.lastSeen = new Map();
    this.handles = new Map();
    this.seen = new Map();
    this.pendingApprovals = new Map();
    this.approvalSeq = 0;
    this.questionQueues = new Map();
    this.activeQuestions = new Map();
    this.typingTickets = new Map();
    this.typingGen = new Map();
    this.visionCache = new Map();
    this.stopped = false;
    this.adminToken = '';
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

    this.registerRoutes();
    this.registerSendTool();
    this.log('info', `状态目录：${this.stateDir}`);
    this.log('info', `登录页：${this.pageUrl()}`);

    if (this.state.token) {
      this.startLoop();
    } else {
      this.login.start().catch((error) => this.log('error', `登录启动失败：${error?.message ?? error}`));
    }
  }

  cancelAllApprovals() {
    for (const peer of [...this.pendingApprovals.keys()]) this.cancelApproval(peer, 'cancelled');
    this.typingTickets.clear();
  }

  async stop() {
    this.stopped = true;
    this.cancelAllApprovals();
    this.cancelAllQuestions();
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
    let origin = 'http://127.0.0.1:3080';
    try {
      origin = this.ctx.webServer?.getOrigin?.() ?? origin;
    } catch {
      /* ignore */
    }
    return `${origin}${LOGIN_PAGE}?token=${encodeURIComponent(this.adminToken)}`;
  }

  registerRoutes() {
    const routes = [
      { kind: 'exact', path: LOGIN_PAGE, handler: (req, res) => this.handlePage(req, res) },
      { kind: 'exact', path: `${LOGIN_PAGE}/panel`, handler: (req, res) => this.handlePanel(req, res) },
      { kind: 'exact', path: `${LOGIN_PAGE}/status`, handler: (req, res) => this.handleStatus(req, res) },
      { kind: 'exact', path: `${LOGIN_PAGE}/contacts`, handler: (req, res) => this.handleContacts(req, res) },
      { kind: 'exact', path: `${LOGIN_PAGE}/persona`, handler: (req, res) => this.handlePersona(req, res) },
      { kind: 'exact', path: `${LOGIN_PAGE}/qr.svg`, handler: (req, res) => this.handleQr(req, res) },
      { kind: 'exact', path: `${LOGIN_PAGE}/verify`, handler: (req, res) => this.handleVerify(req, res) },
      { kind: 'exact', path: `${LOGIN_PAGE}/login`, handler: (req, res) => this.handleLogin(req, res) },
      { kind: 'exact', path: `${LOGIN_PAGE}/logout`, handler: (req, res) => this.handleLogout(req, res) },
    ];
    for (const route of routes) {
      this.routes.push(this.ctx.webServer.register(route));
    }
  }

  isAuthorized(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const queryToken = url.searchParams.get('token');
    const cookieToken = parseCookies(req.headers?.cookie)?.wx_ilink_admin;
    if (queryToken && safeEqual(queryToken, this.adminToken)) {
      res.setHeader('Set-Cookie', `wx_ilink_admin=${encodeURIComponent(this.adminToken)}; HttpOnly; SameSite=Strict; Path=${LOGIN_PAGE}`);
      return true;
    }
    if (cookieToken && safeEqual(cookieToken, this.adminToken)) return true;
    // 原生抽屉里的 iframe 使用 DSH 自己的登录态，不再需要单独带 token。
    try {
      const admission = this.ctx.get?.('connection')?.admit?.(req);
      if (admission && !('rejection' in admission)) return true;
    } catch {
      /* 没有 connection 服务时只认 adminToken */
    }
    return false;
  }

  handlePage(req, res) {
    if (!this.isAuthorized(req, res)) return sendTextResponse(res, 401, '未授权。请从 DSH 启动日志里复制带 token 的 /weixin 地址打开。');
    if (req.method !== 'GET') return sendTextResponse(res, 405, 'method not allowed');
    const body = renderPage(false);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  handlePanel(req, res) {
    if (!this.isAuthorized(req, res)) return sendTextResponse(res, 401, '未授权。请从 DSH 启动日志里复制带 token 的 /weixin 地址打开。');
    if (req.method !== 'GET') return sendTextResponse(res, 405, 'method not allowed');
    const body = renderPage(true);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  handleStatus(req, res) {
    if (!this.isAuthorized(req, res)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    sendJson(res, 200, this.statusPayload());
  }

  handleContacts(req, res) {
    if (!this.isAuthorized(req, res)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    const contacts = Object.entries(this.state?.sessionMap ?? {}).map(([id, sessionId]) => ({
      id,
      sessionId,
      tail: String(id).split('@')[0].slice(-4),
      persona: this.personaFor(id),
      custom: Boolean(this.state?.personas?.[id]),
      lastMessageAt: this.lastSeen.get(id) ?? null,
    })).sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0));
    sendJson(res, 200, { ok: true, contacts });
  }

  async handlePersona(req, res) {
    if (!this.isAuthorized(req, res)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET') {
      const peer = url.searchParams.get('peer') ?? '';
      if (!peer || !this.state?.sessionMap?.[peer]) return sendJson(res, 404, { ok: false, error: 'unknown peer' });
      return sendJson(res, 200, {
        ok: true,
        peer,
        persona: this.personaFor(peer),
        custom: Boolean(this.state?.personas?.[peer]),
        default: this.config.persona,
      });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    try {
      const body = await readJsonBody(req);
      const peer = String(body?.peer ?? '').trim();
      if (!peer || !this.state?.sessionMap?.[peer]) return sendJson(res, 404, { ok: false, error: 'unknown peer' });
      const text = String(body?.text ?? '').trim();
      if (!this.state.personas) this.state.personas = {};
      if (!text) delete this.state.personas[peer];
      else this.state.personas[peer] = text.slice(0, 4000);
      this.store.save();
      sendJson(res, 200, {
        ok: true,
        peer,
        persona: this.personaFor(peer),
        custom: Boolean(this.state.personas[peer]),
        default: this.config.persona,
      });
    } catch (error) {
      sendJson(res, error?.statusCode ?? 400, { ok: false, error: error?.message ?? String(error) });
    }
  }

  handleQr(req, res) {
    if (!this.isAuthorized(req, res)) return sendTextResponse(res, 401, 'unauthorized');
    if (req.method !== 'GET') return sendTextResponse(res, 405, 'method not allowed');
    if (!this.login.qrContent) return sendTextResponse(res, 404, 'no qr code');
    const body = qrSvg(this.login.qrContent);
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  async handleVerify(req, res) {
    if (!this.isAuthorized(req, res)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    try {
      const body = await readJsonBody(req);
      const result = this.login.submitCode(body?.code);
      sendJson(res, 200, { ...this.statusPayload(), ok: result.ok, message: result.message });
    } catch (error) {
      sendJson(res, error?.statusCode ?? 400, { ok: false, error: error?.message ?? String(error) });
    }
  }

  async handleLogin(req, res) {
    if (!this.isAuthorized(req, res)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    this.cancelAllApprovals();
    this.cancelAllQuestions();
    await this.stopLoop();
    this.state.token = '';
    this.state.cursor = '';
    this.store.save();
    this.login.stop();
    this.login.start().catch((error) => this.log('error', `重新登录失败：${error?.message ?? error}`));
    sendJson(res, 200, { ok: true, ...this.statusPayload() });
  }

  async handleLogout(req, res) {
    if (!this.isAuthorized(req, res)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    await this.logout();
    sendJson(res, 200, { ok: true, ...this.statusPayload() });
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
      approvals: this.approvalCount(),
      questions: this.activeQuestions.size,
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
    this.startLoop();
  }

  async logout() {
    this.log('info', '退出微信登录');
    this.cancelAllApprovals();
    this.cancelAllQuestions();
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
          await sleep(Math.min(1000 * 2 ** Math.min(failures, 5), 30_000));
        }
      }
    })()
      .catch((error) => {
        if (this.loopRunning) this.log('error', `消息循环异常退出：${error?.message ?? error}`);
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
    this.cancelAllApprovals();
    this.cancelAllQuestions();
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
    // 默认只允许扫码登录的那个微信号；state.userId 是 iLink 返回的本人 id。
    if (this.state?.userId) return from === this.state.userId;
    return true;
  }

  accept(message) {
    if (!message || typeof message !== 'object') return;
    if (message.message_type !== 1) return;
    if (message.message_state === 1) return;
    if (message.group_id) return;
    if (message.to_user_id && !String(message.to_user_id).endsWith('@im.bot')) return;
    const from = String(message.from_user_id ?? '').trim();
    if (!from) return;
    const id = String(message.message_id ?? message.msg_id ?? message.seq ?? '');
    if (id) {
      if (this.seen.has(id)) return;
      this.seen.set(id, Date.now());
      if (this.seen.size > MAX_SEEN) {
        const cutoff = Date.now() - 10 * 60_000;
        for (const [key, at] of this.seen) if (at < cutoff) this.seen.delete(key);
      }
    }

    if (!this.isAllowed(from)) {
      this.reply(from, `未授权。你的微信 ID 是：${from}\n只允许 bot 主人使用；管理员可在 allowedUsers 里加入你。`, message.context_token).catch(() => {});
      return;
    }
    this.lastSeen.set(from, Date.now());

    if (message.context_token) {
      this.state.contextTokens[from] = message.context_token;
      this.store.save();
    }
    const token = message.context_token || this.state.contextTokens[from] || '';

    const text = extractText(message);
    const media = describeMedia(message);
    const trimmed = text.trim();

    // 有提问在等：先把文字当作回答。
    if (this.activeQuestions.has(from)) {
      if (trimmed === '/stop') {
        this.cancelQuestion(from);
        this.stopCurrent(from, token).catch(() => {});
        return;
      }
      if (trimmed) {
        this.resolveQuestion(from, trimmed);
        return;
      }
      this.reply(from, '请用文字回答上面的问题。', token).catch(() => {});
      return;
    }

    // 有审批在等：先把它当作审批回复，避免和下一轮任务抢输入。
    if (this.pendingApprovals.has(from)) {
      if (trimmed === '/stop') {
        this.cancelApproval(from, 'cancelled');
        this.stopCurrent(from, token).catch(() => {});
        return;
      }
      if (this.resolveApproval(from, trimmed)) return;
      if (trimmed || media.length) {
        this.reply(from, '现在有一条工具审批在等你：回复 1 允许一次，回复 2 拒绝。', token).catch(() => {});
      }
      return;
    }

    if (!trimmed && media.length === 0) {
      this.reply(from, '这条消息没有可读取的文字或媒体。', token).catch(() => {});
      return;
    }
    if (trimmed === '/help' || trimmed === '帮助') {
      this.reply(from, HELP_TEXT, token).catch(() => {});
      return;
    }
    if (trimmed === '/status') {
      this.reply(from, this.statusText(from), token).catch(() => {});
      return;
    }
    if (trimmed === '/stop') {
      this.stopCurrent(from, token).catch(() => {});
      return;
    }
    if (trimmed === '/new') {
      this.enqueue(from, () => this.newChat(from, token));
      return;
    }
    if (trimmed === '/ping') {
      this.reply(from, `长江收到 · ${new Date().toISOString()}`, token).catch(() => {});
      return;
    }
    const personaMatch = trimmed.match(/^\/(?:persona|role|人设)(?:\s+([\s\S]*))?$/i);
    if (personaMatch) {
      this.personaCommand(from, (personaMatch[1] ?? '').trim(), token).catch(() => {});
      return;
    }

    this.enqueue(from, () => this.handlePrompt(from, trimmed, token, media));
  }

  enqueue(peer, task) {
    const previous = this.queues.get(peer) ?? Promise.resolve();
    const run = previous
      .then(task)
      .catch(async (error) => {
        this.log('error', `处理 ${peer.slice(0, 12)} 的消息失败：${error?.message ?? error}`);
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
      const source = typeof custom === 'string' && custom.trim() ? '当前联系人单独设置' : (this.config.persona ? '插件默认人设' : '未设置');
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
      `连接：${this.loopRunning ? '已连接' : '未连接'}`,
      `你的微信 ID：${peer}`,
      `会话：${sessionId ?? '还没有（发一条消息创建）'}`,
      `状态：${agent?.status ?? '无'}`,
      `模型：${model}`,
      `排队：${this.queues.size} 个联系人`,
      `审批等待：${this.approvalCount()}`,
      `提问等待：${this.activeQuestions.size}`,
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
      agentCtx.systemPrompt?.section?.({
        name: 'dsh-wx-ilink:channel',
        order: 50,
        text: [
          '你正在通过微信与用户对话：异步、回合式，可以收发文字、图片、文件和视频。',
          '需要用户确认或选择时可以用 ask_user_question，DSH 会把问题转发到微信；能直接用文字问清时也可以直接问。',
          '需要用户授权时，DSH 会把审批请求发到微信，用户可用 1/2 回复；你只需正常调用工具。',
          '需要把图片、视频或文件发给用户时，先写到会话工作目录，再调用 send_weixin_file 工具。',
          '回复要简洁，避免大段 Markdown。',
        ].join('\n'),
      });
    } catch (error) {
      this.log('warn', `注入通道提示失败：${error?.message ?? error}`);
    }
    try {
      if (this.config.forwardApprovals) {
        agentCtx.on?.('approval/request', (request, next) => {
          if (!request?.agent || request.agent.id !== sessionId) return next();
          return this.forwardApproval(request);
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
          return this.forwardQuestion(request, peer);
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
        description: '把本地图片、视频或文件发送到当前微信联系人。文件必须在会话工作目录或 DSH 附件目录内；发送前先用 write/bash 生成文件。',
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
          const peer = Object.keys(this.state?.sessionMap ?? {}).find((key) => this.state.sessionMap[key] === exec.agent?.id);
          if (!peer) throw new Error('send_weixin_file 只能用于微信会话');
          return this.sendLocalFile(peer, String(args?.path ?? ''), exec.signal);
        },
      });
    } catch (error) {
      this.log('warn', `注册 send_weixin_file 失败：${error?.message ?? error}`);
    }
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
      to: peer,
      data,
      mediaType: kind === 'image' ? 1 : kind === 'video' ? 2 : 3,
      botAgent: this.config.botAgent,
      signal,
    });
    await sendItems({
      baseUrl: this.baseUrl,
      token: this.state.token,
      to: peer,
      items: [buildMediaItem(kind, uploaded, path.basename(real))],
      contextToken: this.state.contextTokens[peer] || '',
      botAgent: this.config.botAgent,
      signal,
    });
    this.log('info', `已向 ${peer.slice(0, 12)}… 发送${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '文件'}：${path.basename(real)}（${data.length} 字节）`);
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

  /** 把会话挂进与 cwd 对应的工作区，并（仅新建时）设置“微信·xxxx”标题。 */
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
        const tail = String(peer).split('@')[0].slice(-4);
        await titles?.rename?.(agent.session, `微信·${tail || '会话'}`);
      }
    } catch (error) {
      this.log('warn', `归入工作区/设置标题失败：${error?.message ?? error}`);
    }
  }

  /** 把 ask_user_question 的请求转发到微信，逐题收集答案。 */
  forwardQuestion(request, peer) {
    if (!this.state.token) return Promise.reject(new Error('微信尚未登录'));
    return new Promise((resolve, reject) => {
      const queue = this.questionQueues.get(peer) ?? [];
      queue.push({ request, resolve, reject });
      this.questionQueues.set(peer, queue);
      if (queue.length === 1) this.startQuestion(peer);
      else this.log('info', `提问已排队，前面还有 ${queue.length - 1} 个请求`);
    });
  }

  startQuestion(peer) {
    if (this.activeQuestions.has(peer)) return;
    const queue = this.questionQueues.get(peer);
    const entry = queue?.[0];
    if (!entry) {
      this.questionQueues.delete(peer);
      return;
    }
    const questions = Array.isArray(entry.request?.questions) ? entry.request.questions : [];
    if (questions.length === 0) {
      queue.shift();
      entry.resolve({ answers: [] });
      if (queue.length) this.startQuestion(peer);
      else this.questionQueues.delete(peer);
      return;
    }
    const record = {
      entry,
      questions,
      index: 0,
      answers: [],
      current: null,
      timer: null,
      signal: entry.request?.signal,
      onAbort: null,
      done: false,
    };
    record.onAbort = () => this.finishQuestion(peer, 'cancelled');
    this.activeQuestions.set(peer, record);
    if (record.signal?.aborted) {
      this.finishQuestion(peer, 'cancelled');
      return;
    }
    record.signal?.addEventListener?.('abort', record.onAbort, { once: true });
    this.askNextQuestion(peer);
  }

  askNextQuestion(peer) {
    const record = this.activeQuestions.get(peer);
    if (!record) return;
    if (record.index >= record.questions.length) {
      this.finishQuestion(peer, 'answered');
      return;
    }
    const question = record.questions[record.index];
    record.current = question;
    const options = Array.isArray(question.options) ? question.options : [];
    const lines = [
      `问题 ${record.index + 1}/${record.questions.length}${question.header ? ` · ${question.header}` : ''}`,
      question.question,
    ];
    if (question.detail) lines.push('', question.detail);
    if (options.length) {
      lines.push('', ...options.map((option, index) => `${index + 1}) ${option.label}${option.description ? ` — ${option.description}` : ''}`));
      lines.push(question.multiSelect ? '回复编号（可多选，用逗号分隔），或直接输入文字。' : '回复编号，或直接输入文字。');
    } else {
      lines.push('', '直接回复文字。');
    }
    this.reply(peer, lines.join('\n'), this.state.contextTokens[peer] || '').catch(() => {});
    record.timer = setTimeout(() => {
      this.reply(peer, '问题超时未回答，已取消。', this.state.contextTokens[peer] || '').catch(() => {});
      this.finishQuestion(peer, 'timeout');
    }, this.config.questionTimeoutMs);
  }

  resolveQuestion(peer, text) {
    const record = this.activeQuestions.get(peer);
    const question = record?.current;
    if (!record || !question) return false;
    clearTimeout(record.timer);
    record.timer = null;
    const raw = String(text ?? '').trim();
    const options = Array.isArray(question.options) ? question.options : [];
    let selected = [];
    let custom;
    const numbers = raw.split(/[,，\s]+/).map((part) => Number(part)).filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length);
    if (options.length && numbers.length && (question.multiSelect || numbers.length === 1)) {
      selected = [...new Set(numbers.map((n) => options[n - 1].label))];
    } else if (options.length && options.some((option) => option.label === raw)) {
      selected = [raw];
    } else {
      custom = raw;
    }
    const answer = { id: question.id, selected };
    if (custom !== undefined) answer.custom = custom;
    record.answers.push(answer);
    record.index += 1;
    record.current = null;
    this.reply(peer, `已记录（${record.index}/${record.questions.length}）。`, this.state.contextTokens[peer] || '').catch(() => {});
    this.askNextQuestion(peer);
    return true;
  }

  finishQuestion(peer, outcome) {
    const record = this.activeQuestions.get(peer);
    if (!record || record.done) return;
    record.done = true;
    clearTimeout(record.timer);
    if (record.onAbort) record.signal?.removeEventListener?.('abort', record.onAbort);
    this.activeQuestions.delete(peer);
    const queue = this.questionQueues.get(peer);
    const entry = queue?.[0];
    if (!entry) return;
    queue.shift();
    if (outcome === 'answered') entry.resolve({ answers: record.answers });
    else entry.reject(new Error(outcome === 'timeout' ? '微信未在时限内回答问题' : '用户问题已取消'));
    if (queue.length) this.startQuestion(peer);
    else this.questionQueues.delete(peer);
  }

  cancelQuestion(peer) {
    this.finishQuestion(peer, 'cancelled');
  }

  cancelAllQuestions() {
    for (const peer of [...this.activeQuestions.keys()]) this.finishQuestion(peer, 'cancelled');
    this.questionQueues.clear();
  }

  /** 把一个工具审批请求转发到微信；同一联系人排队，一次只问一条。 */
  async forwardApproval(request) {
    const peer = Object.keys(this.state.sessionMap).find((key) => this.state.sessionMap[key] === request?.agent?.id);
    if (!peer || !this.state.token) return 'unavailable';
    if (request.signal?.aborted) return 'cancelled';

    const contextToken = this.state.contextTokens[peer] || '';
    const id = (this.approvalSeq += 1);
    const prompt = [
      `需要你授权（#${id}）`,
      `工具：${request.toolName}`,
      request.reason ? `原因：${request.reason}` : '',
      `回复 1 允许一次，回复 2 拒绝；${Math.max(1, Math.round(this.config.approvalTimeoutMs / 1000))} 秒内有效。`,
    ].filter(Boolean).join('\n');

    return new Promise((resolve) => {
      const record = {
        id,
        toolName: request.toolName,
        prompt,
        contextToken,
        signal: request.signal,
        timer: null,
        onAbort: null,
        started: false,
        done: false,
        resolve,
        finish: null,
      };
      record.finish = (outcome) => {
        if (record.done) return;
        record.done = true;
        clearTimeout(record.timer);
        if (record.onAbort) record.signal?.removeEventListener?.('abort', record.onAbort);
        const list = this.pendingApprovals.get(peer);
        const index = list ? list.indexOf(record) : -1;
        if (index >= 0) list.splice(index, 1);
        if (!list || list.length === 0) this.pendingApprovals.delete(peer);
        else queueMicrotask(() => this.startApproval(peer, list[0]));
        resolve(outcome);
      };
      record.onAbort = () => record.finish('cancelled');
      request.signal?.addEventListener?.('abort', record.onAbort, { once: true });

      const list = this.pendingApprovals.get(peer) ?? [];
      list.push(record);
      this.pendingApprovals.set(peer, list);
      if (list.length === 1) this.startApproval(peer, record);
      else this.log('info', `审批 #${id} 已排队，前面还有 ${list.length - 1} 条`);
    });
  }

  async startApproval(peer, record) {
    if (!record || record.done || record.started) return;
    record.started = true;
    record.timer = setTimeout(() => {
      this.reply(peer, `审批 #${record.id} 超时，已按拒绝处理。`, record.contextToken).catch(() => {});
      record.finish('unavailable');
    }, this.config.approvalTimeoutMs);
    this.log('info', `等待 ${peer.slice(0, 12)} 审批 #${record.id}：${record.toolName}`);
    this.reply(peer, record.prompt, record.contextToken).catch(() => record.finish('unavailable'));
  }

  /** 处理微信里的 1/2 审批回复；返回是否命中。 */
  resolveApproval(peer, text) {
    const record = this.pendingApprovals.get(peer)?.[0];
    if (!record?.finish) return false;
    const raw = String(text ?? '').trim().toLowerCase();
    const first = raw.split(/\s+/)[0];
    const yes = new Set(['1', 'y', 'yes', '允许', '同意', '批准', '可以', '好']);
    const no = new Set(['2', 'n', 'no', '拒绝', '不同意', '取消', '不行']);
    const allowed = yes.has(raw) || yes.has(first);
    const denied = no.has(raw) || no.has(first);
    if (!allowed && !denied) return false;
    record.finish(allowed ? 'allowed-once' : 'rejected');
    this.reply(peer, allowed ? `已允许 #${record.id}，继续执行。` : `已拒绝 #${record.id}。`, this.state.contextTokens[peer] || '').catch(() => {});
    return true;
  }

  cancelApproval(peer, outcome = 'cancelled') {
    const list = [...(this.pendingApprovals.get(peer) ?? [])];
    for (const record of list) record.finish?.(outcome);
  }

  approvalCount() {
    let count = 0;
    for (const list of this.pendingApprovals.values()) count += list.length;
    return count;
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
    this.log('info', `为 ${peer.slice(0, 12)}… 新建会话 ${sessionId}`);
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

  effectiveModel(agent) {
    const options = agent?.options ?? {};
    let selection = {};
    try {
      selection = this.ctx.get?.('agentDefaultModel')?.currentSelection?.() ?? {};
    } catch {
      selection = {};
    }
    return {
      provider: options.provider || selection.provider || '',
      model: options.model || selection.model || '',
    };
  }

  async supportsVision(agent) {
    try {
      const llm = this.ctx.get?.('llm');
      if (!llm?.resolveModelInfo) return false;
      const { provider, model } = this.effectiveModel(agent);
      if (!provider || !model) return false;
      const key = `${provider}:${model}`;
      if (this.visionCache.has(key)) return this.visionCache.get(key);
      const info = await llm.resolveModelInfo(provider, model);
      const supported = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image');
      this.visionCache.set(key, supported);
      return supported;
    } catch {
      return false;
    }
  }

  /** 下载微信媒体并转成 DSH 内容块；失败降级为文字提示，不中断整轮。 */
  async buildMediaParts(peer, refs, agent) {
    const parts = [];
    const notes = [];
    if (!Array.isArray(refs) || refs.length === 0) return { parts, notes, label: '' };
    const attachments = this.ctx.get?.('attachments') ?? this.ctx.attachments;
    const vision = await this.supportsVision(agent);
    const imageLimit = attachments?.imageLimits?.maxImageBytes || this.config.maxMediaBytes;
    const kinds = new Set(refs.map((ref) => ref.kind));
    const label = kinds.size === 1
      ? ({ image: '图片', file: '文件', video: '视频' }[[...kinds][0]] ?? '媒体文件')
      : '媒体文件';

    for (const [index, ref] of refs.slice(0, 8).entries()) {
      const kindLabel = { image: '图片', file: '文件', video: '视频' }[ref.kind] ?? '文件';
      const limit = ref.kind === 'image' ? Math.max(1, Math.min(this.config.maxMediaBytes, imageLimit)) : this.config.maxMediaBytes;
      if (!attachments?.saveFile) {
        parts.push({ type: 'text', text: `[${kindLabel}无法保存：DSH 附件服务不可用]` });
        continue;
      }
      if (ref.size && ref.size > limit + 16) {
        parts.push({ type: 'text', text: `[${kindLabel}超过 ${Math.round(limit / 1024 / 1024)}MB，未接收]` });
        continue;
      }
      try {
        const bytes = await fetchMedia(ref.media, { maxBytes: limit });
        if (ref.kind === 'image' && vision && attachments.saveImage) {
          const attachment = await attachments.saveImage({
            data: bytes,
            mediaType: sniffImageMime(bytes),
            name: `weixin-image-${Date.now()}-${index}`,
          });
          parts.push({ type: 'image', attachment });
        } else {
          const extension = ref.kind === 'image'
            ? `.${sniffImageMime(bytes).split('/')[1].replace('jpeg', 'jpg')}`
            : '';
          const name = sanitizeMediaName(ref.name || `weixin-${ref.kind}-${Date.now()}${extension}`);
          const attachment = await attachments.saveFile({ data: bytes, name });
          parts.push({ type: 'file', attachment });
          if (ref.kind === 'image') notes.push(`当前模型不支持看图，图片已保存为文件附件「${name}」。`);
          if (ref.kind === 'video') notes.push(`视频已保存为文件附件「${name}」，当前模型不能直接播放视频。`);
        }
      } catch (error) {
        if (error instanceof MediaTooLargeError) {
          parts.push({ type: 'text', text: `[${kindLabel}超过大小上限，未接收]` });
        } else {
          this.log('warn', `${kindLabel}接收失败：${error?.message ?? error}`);
          parts.push({ type: 'text', text: `[${kindLabel}接收失败]` });
        }
      }
    }
    if (refs.length > 8) notes.push(`一次最多接收 8 个媒体，其余 ${refs.length - 8} 个已忽略。`);
    return { parts, notes, label };
  }

  async getTypingTicket(peer, contextToken) {
    if (this.typingTickets.has(peer)) return this.typingTickets.get(peer);
    const response = await getConfig({
      baseUrl: this.baseUrl,
      token: this.state.token,
      ilinkUserId: peer,
      contextToken,
      botAgent: this.config.botAgent,
    });
    const ticket = response?.typing_ticket ?? '';
    this.typingTickets.set(peer, ticket);
    return ticket;
  }

  startTyping(peer, contextToken) {
    if (!this.config.typing || !this.state.token) return;
    const generation = (this.typingGen.get(peer) ?? 0) + 1;
    this.typingGen.set(peer, generation);
    this.getTypingTicket(peer, contextToken)
      .then((ticket) => {
        if (!ticket || this.typingGen.get(peer) !== generation) return;
        return sendTyping({
          baseUrl: this.baseUrl,
          token: this.state.token,
          to: peer,
          typingTicket: ticket,
          status: 1,
          botAgent: this.config.botAgent,
        });
      })
      .catch(() => {});
  }

  stopTyping(peer) {
    if (!this.config.typing) return;
    const generation = (this.typingGen.get(peer) ?? 0) + 1;
    this.typingGen.set(peer, generation);
    const ticket = this.typingTickets.get(peer);
    if (!ticket || !this.state.token) return;
    sendTyping({
      baseUrl: this.baseUrl,
      token: this.state.token,
      to: peer,
      typingTicket: ticket,
      status: 2,
      botAgent: this.config.botAgent,
    }).catch(() => {});
  }

  /** 长任务阶段性提示；返回一个幂等的 stop()。 */
  startProgress(peer, contextToken) {
    if (this.config.progressAfterMs <= 0 || this.config.maxProgressMessages <= 0) return () => {};
    let stopped = false;
    let count = 0;
    let interval;
    const startedAt = Date.now();
    const send = () => {
      if (stopped || count >= this.config.maxProgressMessages) return;
      count += 1;
      const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
      this.reply(peer, `还在处理，已用时约 ${minutes} 分钟…`, contextToken).catch(() => {});
    };
    const timer = setTimeout(() => {
      send();
      interval = setInterval(send, this.config.progressEveryMs);
    }, this.config.progressAfterMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (interval) clearInterval(interval);
    };
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

    const built = await this.buildMediaParts(peer, mediaRefs, agent);
    const content = [];
    if (text) content.push({ type: 'text', text });
    if (built.parts.length) {
      if (!text) content.push({ type: 'text', text: `（用户通过微信发来了${built.label}，没有附带文字）` });
      content.push(...built.parts);
      if (built.notes.length) content.push({ type: 'text', text: built.notes.join('\n') });
    }
    if (!content.length) content.push({ type: 'text', text: '（空消息）' });

    const stopProgress = this.startProgress(peer, contextToken);
    this.startTyping(peer, contextToken);
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
      this.stopTyping(peer);
      try {
        await this.sessions?.flush?.(agent.session);
      } catch {
        /* ignore */
      }
    }
  }

  async reply(peer, text, contextToken) {
    if (!this.state.token) {
      this.log('warn', `没有 bot_token，无法回复 ${peer.slice(0, 12)}…`);
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
      await this.sendPart(peer, parts[index], contextToken);
      if (index < parts.length - 1 && this.config.sendIntervalMs > 0) {
        await sleep(this.config.sendIntervalMs);
      }
    }
  }

  async sendPart(peer, text, contextToken) {
    try {
      await sendText({
        baseUrl: this.baseUrl,
        token: this.state.token,
        to: peer,
        text,
        contextToken,
        botAgent: this.config.botAgent,
        onWarn: (message) => this.log('warn', message),
      });
    } catch (error) {
      if (isSessionExpired(error)) {
        this.handleExpired();
        throw error;
      }
      if (contextToken) {
        this.log('warn', `带 context_token 发送失败，重试一次：${error?.message ?? error}`);
        await sendText({
          baseUrl: this.baseUrl,
          token: this.state.token,
          to: peer,
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

/* ------------------------------ 登录页 ------------------------------ */

function renderPage(embedded = false) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>微信 iLink · DSH</title>
<style>
  :root{color-scheme:light;--bg:#f5f6f8;--card:#fff;--text:#1c1f23;--muted:#6b7280;--line:#e5e7eb;--green:#07c160;--red:#dc2626}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  main{max-width:460px;margin:7vh auto 40px;padding:0 18px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px;box-shadow:0 10px 30px rgba(15,23,42,.06)}
  h1{font-size:20px;margin:0 0 4px;display:flex;align-items:center;gap:8px}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--muted)}
  .dot.on{background:var(--green);box-shadow:0 0 0 4px rgba(7,193,96,.12)}
  .dot.err{background:var(--red)}
  .sub{color:var(--muted);font-size:13px;margin:0 0 18px}
  .state{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;background:#f1f5f9;font-size:13px;font-weight:600}
  .qr{display:flex;justify-content:center;margin:20px 0 8px}
  .qr img{width:264px;height:264px;border:1px solid var(--line);border-radius:14px;background:#fff;padding:10px}
  .msg{color:var(--muted);font-size:13px;text-align:center;min-height:20px;margin:6px 0 0}
  .code{display:none;gap:8px;margin-top:14px}
  .code.show{display:flex}
  input{flex:1;min-width:0;border:1px solid var(--line);border-radius:10px;padding:11px 12px;font-size:15px;outline:none}
  input:focus{border-color:var(--green);box-shadow:0 0 0 3px rgba(7,193,96,.12)}
  button{border:0;border-radius:10px;padding:11px 16px;font-size:14px;font-weight:600;cursor:pointer;background:var(--green);color:#fff}
  button.secondary{background:#eef2f6;color:#334155}
  button:disabled{opacity:.55;cursor:default}
  .row{display:flex;gap:10px;margin-top:16px}
  .meta{display:none;margin-top:18px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:13px;word-break:break-all}
  .meta.show{display:block}
  .hint{margin-top:14px;color:var(--muted);font-size:12px;line-height:1.6}
  .err{color:var(--red)}
  body.embedded{background:transparent}
  body.embedded main{margin:0;max-width:none;padding:0}
  body.embedded .card{border:0;border-radius:0;box-shadow:none;padding:16px}
  body.embedded h1,body.embedded .sub,body.embedded .hint{display:none}
  body.embedded .qr img{width:236px;height:236px}
</style>
</head>
<body class="${embedded ? 'embedded' : ''}">
<main>
  <div class="card">
    <h1><span id="dot" class="dot"></span> 微信 iLink</h1>
    <p class="sub">扫码登录后，微信消息会进入你的 DSH 会话，处理完自动回发结果。</p>
    <span id="state" class="state">加载中…</span>
    <div id="qrWrap" class="qr" style="display:none"><img id="qr" alt="微信登录二维码"></div>
    <p id="message" class="msg"></p>
    <div id="codeBox" class="code">
      <input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="手机微信上的数字验证码">
      <button id="verify">提交</button>
    </div>
    <div class="row">
      <button id="login" class="secondary">重新登录</button>
      <button id="logout" class="secondary">退出登录</button>
    </div>
    <div id="meta" class="meta"></div>
    <p class="hint">这个页面只用于本机扫码和状态查看；登录凭据保存在 DSH 状态目录，不会显示在页面上。关闭本页不影响通道运行。</p>
  </div>
</main>
<script>
(function () {
  var stateEl = document.getElementById('state');
  var dot = document.getElementById('dot');
  var msgEl = document.getElementById('message');
  var qrWrap = document.getElementById('qrWrap');
  var qrEl = document.getElementById('qr');
  var codeBox = document.getElementById('codeBox');
  var codeEl = document.getElementById('code');
  var metaEl = document.getElementById('meta');
  var lastQr = 0;
  var busy = false;

  function apply(value) {
    stateEl.textContent = value.stateText || value.state || '未知';
    dot.className = 'dot' + (value.connected ? ' on' : value.state === 'error' ? ' err' : '');
    msgEl.textContent = value.message || '';
    msgEl.className = 'msg' + (value.state === 'error' ? ' err' : '');
    if (value.hasQr && value.qrAt !== lastQr) {
      lastQr = value.qrAt;
      qrEl.src = '/weixin/qr.svg?ts=' + lastQr;
    }
    qrWrap.style.display = value.hasQr ? 'flex' : 'none';
    codeBox.className = 'code' + (value.needCode ? ' show' : '');
    if (value.needCode) setTimeout(function () { codeEl.focus(); }, 50);
    metaEl.className = 'meta' + (value.connected ? ' show' : '');
    if (value.connected) {
      metaEl.textContent = '机器人：' + (value.botId || '未知') + ' · 联系人会话：' + value.sessions + ' · 已连接。';
    }
  }

  function load() {
    fetch('/weixin/status', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('unauthorized');
        return response.json();
      })
      .then(apply)
      .catch(function () {
        stateEl.textContent = '页面已失效';
        msgEl.textContent = '请从 DSH 启动日志里复制带 token 的 /weixin 地址重新打开。';
      });
  }

  document.getElementById('verify').addEventListener('click', function () {
    var code = codeEl.value.trim();
    if (!code || busy) return;
    busy = true;
    fetch('/weixin/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code })
    }).then(function (response) { return response.json(); }).then(function (value) {
      if (value && value.ok === false) { msgEl.textContent = value.error || value.message || '验证码提交失败'; }
      codeEl.value = '';
      load();
    }).catch(function () { msgEl.textContent = '验证码提交失败'; }).finally(function () { busy = false; });
  });

  document.getElementById('code').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') document.getElementById('verify').click();
  });

  document.getElementById('login').addEventListener('click', function () {
    if (busy) return;
    busy = true;
    fetch('/weixin/login', { method: 'POST' }).then(function () { lastQr = 0; load(); }).finally(function () { busy = false; });
  });

  document.getElementById('logout').addEventListener('click', function () {
    if (busy || !confirm('确定退出当前微信登录？')) return;
    busy = true;
    fetch('/weixin/logout', { method: 'POST' }).then(function () { lastQr = 0; load(); }).finally(function () { busy = false; });
  });

  load();
  setInterval(load, 2000);
})();
</script>
</body>
</html>`;
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
