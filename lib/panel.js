/**
 * 本机登录页与面板 HTTP 路由（兜底入口，DSH 原生抽屉不经过这里）。
 * @module dsh-wx-ilink/panel
 */

import {
  LOGIN_PAGE,
} from './config.js';
import {
  parseCookies,
  readJsonBody,
  safeEqual,
  sendJson,
  sendTextResponse,
} from './text.js';
import { qrSvg } from './qr.js';

export class Panel {
  constructor(plugin) {
    this.plugin = plugin;
  }

  routes() {
    return [
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
  }

  isAuthorized(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const queryToken = url.searchParams.get('token');
    const cookieToken = parseCookies(req.headers?.cookie)?.wx_ilink_admin;
    if (queryToken && safeEqual(queryToken, this.plugin.adminToken)) {
      res.setHeader('Set-Cookie', `wx_ilink_admin=${encodeURIComponent(this.plugin.adminToken)}; HttpOnly; SameSite=Strict; Path=${LOGIN_PAGE}`);
      return true;
    }
    if (cookieToken && safeEqual(cookieToken, this.plugin.adminToken)) return true;
    // 原生抽屉里的 iframe 使用 DSH 自己的登录态，不再需要单独带 token。
    try {
      const admission = this.plugin.ctx.get?.('connection')?.admit?.(req);
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
    sendJson(res, 200, this.plugin.statusPayload());
  }

  handleContacts(req, res) {
    if (!this.isAuthorized(req, res)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    const contacts = Object.entries(this.plugin.state?.sessionMap ?? {}).map(([id, sessionId]) => ({
      id,
      sessionId,
      tail: String(id).split('@')[0].slice(-4),
      persona: this.plugin.personaFor(id),
      custom: Boolean(this.plugin.state?.personas?.[id]),
      lastMessageAt: this.plugin.lastSeen.get(id) ?? null,
    })).sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0));
    sendJson(res, 200, { ok: true, contacts });
  }

  async handlePersona(req, res) {
    if (!this.isAuthorized(req, res)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET') {
      const peer = url.searchParams.get('peer') ?? '';
      if (!peer || !this.plugin.state?.sessionMap?.[peer]) return sendJson(res, 404, { ok: false, error: 'unknown peer' });
      return sendJson(res, 200, {
        ok: true,
        peer,
        persona: this.plugin.personaFor(peer),
        custom: Boolean(this.plugin.state?.personas?.[peer]),
        default: this.plugin.config.persona,
      });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    try {
      const body = await readJsonBody(req);
      const peer = String(body?.peer ?? '').trim();
      if (!peer || !this.plugin.state?.sessionMap?.[peer]) return sendJson(res, 404, { ok: false, error: 'unknown peer' });
      const text = String(body?.text ?? '').trim();
      if (!this.plugin.state.personas) this.plugin.state.personas = {};
      if (!text) delete this.plugin.state.personas[peer];
      else this.plugin.state.personas[peer] = text.slice(0, 4000);
      this.plugin.store.save();
      sendJson(res, 200, {
        ok: true,
        peer,
        persona: this.plugin.personaFor(peer),
        custom: Boolean(this.plugin.state.personas[peer]),
        default: this.plugin.config.persona,
      });
    } catch (error) {
      sendJson(res, error?.statusCode ?? 400, { ok: false, error: error?.message ?? String(error) });
    }
  }

  handleQr(req, res) {
    if (!this.isAuthorized(req, res)) return sendTextResponse(res, 401, 'unauthorized');
    if (req.method !== 'GET') return sendTextResponse(res, 405, 'method not allowed');
    if (!this.plugin.login.qrContent) return sendTextResponse(res, 404, 'no qr code');
    const body = qrSvg(this.plugin.login.qrContent);
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
      const result = this.plugin.login.submitCode(body?.code);
      sendJson(res, 200, { ...this.plugin.statusPayload(), ok: result.ok, message: result.message });
    } catch (error) {
      sendJson(res, error?.statusCode ?? 400, { ok: false, error: error?.message ?? String(error) });
    }
  }

  async handleLogin(req, res) {
    if (!this.isAuthorized(req, res)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    this.plugin.cancelAllApprovals();
    this.plugin.cancelAllQuestions();
    await this.plugin.stopLoop();
    this.plugin.state.token = '';
    this.plugin.state.cursor = '';
    this.plugin.store.save();
    this.plugin.login.stop();
    this.plugin.login.start().catch((error) => this.plugin.log('error', `重新登录失败：${error?.message ?? error}`));
    sendJson(res, 200, { ok: true, ...this.plugin.statusPayload() });
  }

  async handleLogout(req, res) {
    if (!this.isAuthorized(req, res)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    await this.plugin.logout();
    sendJson(res, 200, { ok: true, ...this.plugin.statusPayload() });
  }
}

export function renderPage(embedded = false) {
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
