import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PERSONA, normalizeConfig } from '../lib/config.js';

test('默认人设内置，安装即有内容', () => {
  const config = normalizeConfig({});
  assert.equal(config.persona, DEFAULT_PERSONA);
  assert.match(config.persona, /大鲸鱼/);
});

test('config.persona 可以覆盖内置人设', () => {
  assert.equal(normalizeConfig({ persona: '你是一个冷静的助手' }).persona, '你是一个冷静的助手');
});

test('personaEnabled:false 关闭内置人设', () => {
  assert.equal(normalizeConfig({ personaEnabled: false }).persona, '');
});

test('群聊与告警默认值', () => {
  const config = normalizeConfig({});
  assert.equal(config.groups.mode, 'off');
  assert.deepEqual(config.groups.allowedGroups, []);
  assert.equal(config.alerts.enabled, true);
  assert.equal(config.alerts.throttleMs, 300_000);
});
