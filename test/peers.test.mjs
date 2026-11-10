import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PeerRouter,
  groupKey,
  isGroupKey,
  isGroupMessage,
  tailOf,
} from '../lib/peers.js';
import { normalizeConfig } from '../lib/config.js';

function fakePlugin(overrides = {}) {
  const sent = [];
  return {
    sent,
    config: normalizeConfig({ ...overrides }),
    state: { userId: 'owner@im.wechat', contextTokens: {}, sessionMap: {} },
    log: () => {},
    deliver: (to, text) => { sent.push({ to, text }); return Promise.resolve(); },
  };
}

test('单聊解析为联系人 id，可与 0.1.0 会话映射兼容', () => {
  const plugin = fakePlugin();
  const router = new PeerRouter(plugin);
  const peer = router.resolve({ from_user_id: 'wxid_a@im.wechat', to_user_id: 'bot@im.bot' }, '你好');
  assert.equal(peer.kind, 'dm');
  assert.equal(peer.key, 'wxid_a@im.wechat');
  assert.equal(peer.sendTo, 'wxid_a@im.wechat');
  assert.equal(peer.senderTail, 'id_a');
  assert.equal(tailOf('wxid_a@im.wechat'), 'id_a');
});

test('群聊默认关闭', () => {
  const plugin = fakePlugin();
  const router = new PeerRouter(plugin);
  const peer = router.resolve({ from_user_id: 'wxid_a@im.wechat', group_id: 'g1@chatroom' }, 'hi');
  assert.equal(peer.ignored, 'group-disabled');
});

test('群聊开启后按群聚合，回复目标为群 id', () => {
  const plugin = fakePlugin({ groups: { mode: 'all' } });
  const router = new PeerRouter(plugin);
  assert.equal(plugin.config.groups.mode, 'all');
  const peer = router.resolve({ from_user_id: 'wxid_a@im.wechat', group_id: 'g1@chatroom' }, 'hi');
  assert.equal(peer.kind, 'group');
  assert.equal(peer.key, 'group:g1@chatroom');
  assert.equal(peer.sendTo, 'g1@chatroom');
  assert.equal(peer.sender, 'wxid_a@im.wechat');
});

test('群白名单生效，未授权群只提示一次', async () => {
  const plugin = fakePlugin({ groups: { mode: 'all', allowedGroups: ['g-ok'] } });
  const router = new PeerRouter(plugin);
  const denied = router.resolve({ from_user_id: 'u', group_id: 'g-bad' }, 'hi');
  assert.equal(denied.ignored, 'group-not-allowed');
  router.resolve({ from_user_id: 'u', group_id: 'g-bad' }, 'hi again');
  await Promise.resolve();
  assert.equal(plugin.sent.length, 1, '未授权提示只发一次');
  assert.match(plugin.sent[0].text, /g-bad/);
  assert.equal(plugin.sent[0].to, 'g-bad');

  const allowed = router.resolve({ from_user_id: 'u', group_id: 'g-ok' }, 'hi');
  assert.equal(allowed.kind, 'group');
});

test('mention 模式只处理带 @ 的消息', () => {
  const plugin = fakePlugin({ groups: { mode: 'mention' } });
  const router = new PeerRouter(plugin);
  assert.equal(router.resolve({ from_user_id: 'u', group_id: 'g1' }, '随便说点什么').ignored, 'not-mentioned');
  assert.equal(router.resolve({ from_user_id: 'u', group_id: 'g1' }, '@机器人 帮我看下').kind, 'group');
});

test('mention 模式支持自定义正则', () => {
  const plugin = fakePlugin({ groups: { mode: 'mention', mentionPattern: '小助手' } });
  const router = new PeerRouter(plugin);
  assert.equal(router.resolve({ from_user_id: 'u', group_id: 'g1' }, '小助手 在吗').kind, 'group');
  assert.equal(router.resolve({ from_user_id: 'u', group_id: 'g1' }, '@别人 你好').ignored, 'not-mentioned');
});

test('群成员白名单', () => {
  const plugin = fakePlugin({ groups: { mode: 'all', allowedMembers: ['vip@im.wechat'] } });
  const router = new PeerRouter(plugin);
  const peer = router.resolve({ from_user_id: 'vip@im.wechat', group_id: 'g1' }, 'hi');
  assert.equal(peer.kind, 'group');
});

test('sendTarget / label / titleSuffix', () => {
  const plugin = fakePlugin();
  const router = new PeerRouter(plugin);
  assert.equal(router.sendTarget('group:abc123'), 'abc123');
  assert.equal(router.sendTarget('wxid_a@im.wechat'), 'wxid_a@im.wechat');
  assert.match(router.label('group:abc123'), /微信群/);
  assert.match(router.label('wxid_a@im.wechat'), /微信用户/);
  assert.equal(router.titleSuffix('group:abc123'), '群c123');
});

test('键工具函数', () => {
  assert.equal(groupKey('g1'), 'group:g1');
  assert.ok(isGroupKey('group:g1'));
  assert.ok(!isGroupKey('wxid_a@im.wechat'));
  assert.ok(isGroupMessage({ group_id: 'g1' }));
  assert.ok(!isGroupMessage({}));
  assert.equal(tailOf('wxid_abcdef@im.wechat'), 'cdef');
});
