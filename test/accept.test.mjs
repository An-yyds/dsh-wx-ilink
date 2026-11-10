import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WeixinIlinkPlugin } from '../index.js';
import { normalizeConfig } from '../lib/config.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makePlugin(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wx-ilink-test-'));
  const replies = [];
  const prompts = [];
  const ctx = {
    agents: { get: () => undefined, create: async () => { throw new Error('not stubbed'); } },
    get: () => undefined,
    logger: null,
  };
  const plugin = new WeixinIlinkPlugin(ctx, normalizeConfig({
    stateDir: dir,
    cwd: path.join(dir, 'workspace'),
    ...overrides,
  }));
  plugin.state = {
    version: 1,
    token: 'token',
    baseUrl: '',
    botId: '',
    userId: 'owner@im.wechat',
    cursor: '',
    sessionMap: {},
    contextTokens: {},
    personas: {},
  };
  plugin.store.ensureDir();
  plugin.store.save();
  plugin.reply = async (peer, text) => { replies.push({ peer, text }); };
  plugin.deliver = async (to, text) => { replies.push({ peer: to, text }); };
  plugin.handlePrompt = async (peer, text, token, media) => { prompts.push({ peer, text, token, media }); };
  return { plugin, replies, prompts, dir };
}

function dm(text, from = 'owner@im.wechat') {
  return {
    message_id: `m-${Math.random()}`,
    message_type: 1,
    message_state: 2,
    from_user_id: from,
    to_user_id: 'bot@im.bot',
    context_token: 'ctx',
    item_list: [{ type: 1, text_item: { text } }],
  };
}

function group(text, groupId = 'g1@chatroom', from = 'owner@im.wechat') {
  return {
    message_id: `m-${Math.random()}`,
    message_type: 1,
    message_state: 2,
    from_user_id: from,
    to_user_id: 'bot@im.bot',
    group_id: groupId,
    context_token: 'ctx-group',
    item_list: [{ type: 1, text_item: { text } }],
  };
}

test('单聊消息进入 handlePrompt，peer 为联系人 id', async () => {
  const { plugin, prompts } = makePlugin();
  plugin.accept(dm('你好'));
  await tick();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].peer, 'owner@im.wechat');
  assert.equal(prompts[0].text, '你好');
});

test('群聊默认关闭时忽略', async () => {
  const { plugin, prompts } = makePlugin();
  plugin.accept(group('大家好'));
  await tick();
  assert.equal(prompts.length, 0);
});

test('群聊开启后消息带发言人头，peer 为 group:xxx', async () => {
  const { plugin, prompts } = makePlugin({ groups: { mode: 'all' } });
  plugin.accept(group('帮我看下构建'));
  await tick();
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].peer, 'group:g1@chatroom');
  assert.match(prompts[0].text, /\[群聊/);
  assert.match(prompts[0].text, /帮我看下构建/);
  assert.equal(plugin.state.sessionMap['group:g1@chatroom'], undefined);
});

test('群聊未授权时回一条提示，不进入处理', async () => {
  const { plugin, prompts, replies } = makePlugin({ groups: { mode: 'all', allowedGroups: ['other'] } });
  plugin.accept(group('hi', 'g1@chatroom'));
  await tick();
  assert.equal(prompts.length, 0);
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /群 ID/);
});

test('重复 message_id 只处理一次', async () => {
  const { plugin, prompts } = makePlugin();
  const message = dm('重复消息');
  plugin.accept(message);
  plugin.accept(message);
  await tick();
  assert.equal(prompts.length, 1);
});

test('/ping 直接回复，不进入 Agent', async () => {
  const { plugin, prompts, replies } = makePlugin();
  plugin.accept(dm('/ping'));
  await tick();
  assert.equal(prompts.length, 0);
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /^长江收到 · /);
});

test('非本人单聊被拒绝', async () => {
  const { plugin, prompts, replies } = makePlugin();
  plugin.accept(dm('你好', 'stranger@im.wechat'));
  await tick();
  assert.equal(prompts.length, 0);
  assert.match(replies[0].text, /未授权/);
});

test('机器人自己发的消息被忽略', async () => {
  const { plugin, prompts } = makePlugin();
  const message = dm('bot echo');
  message.message_type = 2;
  plugin.accept(message);
  await tick();
  assert.equal(prompts.length, 0);
});
