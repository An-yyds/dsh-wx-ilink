import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ControlTools } from '../lib/control.js';

function makePlugin(overrides = {}) {
  const tools = new Map();
  const plugin = {
    state: { token: 'token', botId: 'bot@im.bot', userId: 'owner@im.wechat' },
    login: {
      running: false,
      state: 'wait',
      qrContent: 'qr-content',
      message: '请用手机微信扫一扫',
      snapshot: () => ({ state: 'wait', message: '请用手机微信扫一扫', hasQr: true, needCode: false }),
      start: async () => {},
      stop: () => {},
      submitCode: (code) => ({ ok: code === '123456', message: code === '123456' ? '已提交' : '验证码不正确' }),
    },
    ctx: {
      tools: {
        register: (definition) => {
          tools.set(definition.name, definition);
          return () => {};
        },
      },
      get: () => undefined,
    },
    log: () => {},
    pageUrl: () => 'http://127.0.0.1:3080/weixin?token=x',
    peerOfSession: () => 'owner@im.wechat',
    stickers: {
      send: async (peer, mood) => ({ mood: mood || 'happy', label: '开心', bytes: 2837 }),
    },
    statusPayload: () => ({
      ok: true,
      state: 'connected',
      stateText: '已连接',
      message: '等待消息',
      connected: true,
      botId: 'bot@im.bot',
      sessions: 1,
      approvals: 0,
      questions: 0,
      groups: 'off',
      alerts: true,
      cwd: '/tmp',
      hasQr: false,
      qrAt: 0,
      needCode: false,
      userId: 'owner@im.wechat',
      queue: 0,
      hasCursor: true,
    }),
    logout: async () => { plugin.state.token = ''; },
    ...overrides,
  };
  return { plugin, tools };
}

test('注册四个控制工具', () => {
  const { plugin, tools } = makePlugin();
  new ControlTools(plugin).register();
  assert.deepEqual([...tools.keys()].sort(), ['weixin_login', 'weixin_logout', 'weixin_status', 'weixin_sticker', 'weixin_verify']);
});

test('weixin_status 只返回 schema 声明的字段', async () => {
  const { plugin, tools } = makePlugin();
  new ControlTools(plugin).register();
  const tool = tools.get('weixin_status');
  const value = await tool.execute({}, { signal: new AbortController().signal });
  const declared = Object.keys(tool.output.schema.properties);
  for (const key of Object.keys(value)) {
    assert.ok(declared.includes(key), `${key} 不在输出 schema 里`);
  }
  assert.equal(value.state, 'connected');
  assert.equal(value.connected, true);
});

test('weixin_login 已登录时直接返回状态', async () => {
  const { plugin, tools } = makePlugin();
  new ControlTools(plugin).register();
  const value = await tools.get('weixin_login').execute({}, { signal: new AbortController().signal });
  assert.equal(value.connected, true);
  assert.equal(value.state, 'connected');
});

test('weixin_login 未登录时返回二维码状态（无附件服务则无 image）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wx-qr-'));
  const { plugin, tools } = makePlugin({ state: { token: '', botId: '', userId: 'owner' }, stateDir: dir });
  new ControlTools(plugin).register();
  const value = await tools.get('weixin_login').execute({ timeout_seconds: 5 }, { signal: new AbortController().signal });
  assert.equal(value.connected, false);
  assert.equal(value.state, 'wait');
  assert.equal(value.image, undefined);
  assert.ok(value.qrPath, '应把二维码写到文件');
  assert.ok(fs.existsSync(value.qrPath));
  assert.ok(fs.statSync(value.qrPath).size > 0);
});

test('weixin_verify 透传登录状态机结果', async () => {
  const { plugin, tools } = makePlugin();
  new ControlTools(plugin).register();
  const tool = tools.get('weixin_verify');
  assert.equal((await tool.execute({ code: '123456' }, {})).ok, true);
  assert.equal((await tool.execute({ code: '000000' }, {})).ok, false);
});

test('weixin_logout 调用插件退出', async () => {
  const { plugin, tools } = makePlugin();
  new ControlTools(plugin).register();
  const value = await tools.get('weixin_logout').execute({}, {});
  assert.equal(value.ok, true);
  assert.equal(plugin.state.token, '');
});

test('输出 schema 使用标准 required 数组', () => {
  const { plugin, tools } = makePlugin();
  new ControlTools(plugin).register();
  for (const [name, tool] of tools) {
    const schema = tool.output.schema;
    assert.ok(Array.isArray(schema.required), `${name} 缺少 required 数组`);
    for (const [key, spec] of Object.entries(schema.properties ?? {})) {
      assert.notEqual(spec.required, true, `${name}.${key} 不应在属性里写 required: true（应由对象的 required 数组表达）`);
    }
  }
});
