import test from 'node:test';
import assert from 'node:assert/strict';

import { Panel } from '../lib/panel.js';

function makePlugin(overrides = {}) {
  const calls = [];
  return {
    calls,
    adminToken: 'admin-token',
    state: { sessionMap: {}, personas: {}, contextTokens: {} },
    store: { save: () => calls.push('save') },
    config: { persona: '内置人设' },
    lastSeen: new Map(),
    login: {
      qrContent: 'qr',
      snapshot: () => ({ state: 'wait', message: '等待扫码', hasQr: true, qrAt: 1, needCode: false }),
      stop: () => calls.push('login.stop'),
      start: async () => { calls.push('login.start'); },
      submitCode: () => ({ ok: true, message: 'ok' }),
    },
    approvals: { cancelAll: () => calls.push('approvals.cancelAll') },
    questions: { cancelAll: () => calls.push('questions.cancelAll') },
    typing: { clear: () => {} },
    stopLoop: async () => { calls.push('stopLoop'); },
    logout: async () => { calls.push('logout'); },
    statusPayload: () => ({ ok: true, state: 'wait', connected: false }),
    personaFor: () => '内置人设',
    log: () => {},
    ...overrides,
  };
}

function mockRes() {
  return {
    headersSent: false,
    statusCode: 0,
    body: '',
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status) { this.statusCode = status; this.headersSent = true; return this; },
    end(body) { this.body = body ?? ''; return this; },
  };
}

function mockReq(url, method = 'POST') {
  return { url, method, headers: { cookie: 'wx_ilink_admin=admin-token' }, on() {}, destroy() {} };
}

function routeFor(panel, path) {
  return panel.routes().find((route) => route.path === path).handler;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('POST /weixin/login 返回 200 并重置登录状态（回归：重构后调用已删除方法导致 400）', async () => {
  const plugin = makePlugin();
  const panel = new Panel(plugin);
  const res = mockRes();
  routeFor(panel, '/weixin/login')(mockReq('/weixin/login'), res);
  await tick();
  assert.equal(res.statusCode, 200);
  assert.ok(plugin.calls.includes('approvals.cancelAll'));
  assert.ok(plugin.calls.includes('questions.cancelAll'));
  assert.ok(plugin.calls.includes('login.start'));
  assert.ok(plugin.calls.includes('stopLoop'));
});

test('处理函数抛错时返回 500 而不是静默 400', async () => {
  const plugin = makePlugin({ stopLoop: async () => { throw new Error('boom'); } });
  const panel = new Panel(plugin);
  const res = mockRes();
  routeFor(panel, '/weixin/login')(mockReq('/weixin/login'), res);
  await tick();
  assert.equal(res.statusCode, 500);
  assert.match(res.body, /boom/);
});

test('未授权请求返回 401', async () => {
  const plugin = makePlugin();
  const panel = new Panel(plugin);
  const res = mockRes();
  routeFor(panel, '/weixin/login')({ url: '/weixin/login', method: 'POST', headers: {} }, res);
  await tick();
  assert.equal(res.statusCode, 401);
});

test('错误方法返回 405', async () => {
  const plugin = makePlugin();
  const panel = new Panel(plugin);
  const res = mockRes();
  routeFor(panel, '/weixin/login')(mockReq('/weixin/login', 'GET'), res);
  await tick();
  assert.equal(res.statusCode, 405);
});

test('GET /weixin/status 返回状态 JSON', async () => {
  const plugin = makePlugin();
  const panel = new Panel(plugin);
  const res = mockRes();
  routeFor(panel, '/weixin/status')(mockReq('/weixin/status', 'GET'), res);
  await tick();
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /"state"/);
});
