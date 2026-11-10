import test from 'node:test';
import assert from 'node:assert/strict';

import { AlertCenter } from '../lib/alerts.js';
import { normalizeConfig } from '../lib/config.js';

function fakePlugin(overrides = {}) {
  const delivered = [];
  const logs = [];
  return {
    delivered,
    logs,
    config: normalizeConfig(overrides),
    state: { userId: 'owner@im.wechat', token: 'bot-token', contextTokens: {} },
    log: (level, message) => logs.push(`${level}:${message}`),
    deliver: (to, text) => { delivered.push({ to, text }); return Promise.resolve(); },
    reply: () => Promise.reject(new Error('alert 不应走 reply')),
  };
}

test('默认推给扫码主人', async () => {
  const plugin = fakePlugin();
  const alerts = new AlertCenter(plugin);
  assert.equal(alerts.enabled, true);
  assert.deepEqual(alerts.recipients(), ['owner@im.wechat']);
  const queued = alerts.alert('session-expired', '登录过期');
  assert.equal(queued, true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(plugin.delivered.length, 1);
  assert.equal(plugin.delivered[0].to, 'owner@im.wechat');
  assert.match(plugin.delivered[0].text, /登录过期/);
});

test('同类告警在冷却期内只发一次', async () => {
  const plugin = fakePlugin({ alerts: { throttleMs: 60_000 } });
  const alerts = new AlertCenter(plugin);
  assert.equal(alerts.alert('send-failed', '第一次'), true);
  assert.equal(alerts.alert('send-failed', '第二次'), false);
  assert.equal(alerts.alert('other', '另一类'), true);
});

test('关闭告警后不发送', () => {
  const plugin = fakePlugin({ alerts: { enabled: false } });
  const alerts = new AlertCenter(plugin);
  assert.equal(alerts.enabled, false);
  assert.equal(alerts.alert('x', 'y'), false);
});

test('未登录时只记日志', () => {
  const plugin = fakePlugin();
  plugin.state.token = '';
  const alerts = new AlertCenter(plugin);
  assert.equal(alerts.alert('x', 'y'), false);
  assert.ok(plugin.logs.some((line) => line.includes('未登录')));
});

test('可以追加额外接收人并排除主人', () => {
  const plugin = fakePlugin({ alerts: { includeOwner: false, toUsers: ['a@im.wechat', 'b@im.wechat'] } });
  const alerts = new AlertCenter(plugin);
  assert.deepEqual(alerts.recipients(), ['a@im.wechat', 'b@im.wechat']);
});

test('告警发送失败不会抛出', async () => {
  const plugin = fakePlugin();
  plugin.deliver = () => Promise.reject(new Error('网络错误'));
  const alerts = new AlertCenter(plugin);
  alerts.alert('x', 'y');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(plugin.logs.some((line) => line.includes('告警发送失败')));
});

test('reset 清空冷却', () => {
  const plugin = fakePlugin({ alerts: { throttleMs: 600_000 } });
  const alerts = new AlertCenter(plugin);
  assert.equal(alerts.alert('k', '1'), true);
  assert.equal(alerts.alert('k', '2'), false);
  alerts.reset('k');
  assert.equal(alerts.alert('k', '3'), true);
});
