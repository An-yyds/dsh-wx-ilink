import test from 'node:test';
import assert from 'node:assert/strict';

import { StickerLibrary } from '../lib/stickers.js';

function fakePlugin() {
  const logs = [];
  return {
    logs,
    config: { botAgent: 'test', stickers: { enabled: true } },
    state: { token: 'token', contextTokens: { 'peer@im.wechat': 'ctx' } },
    baseUrl: 'https://example.invalid',
    peers: { sendTarget: (peer) => peer, label: (peer) => peer },
    log: (level, message) => logs.push(`${level}:${message}`),
  };
}

test('图库能加载内置索引', () => {
  const library = new StickerLibrary(fakePlugin());
  const list = library.list();
  assert.ok(list.length >= 8, `期望至少 8 张，实际 ${list.length}`);
  const moods = list.map((entry) => entry.mood);
  for (const expected of ['happy', 'thumbsUp', 'thinking', 'sad', 'celebrate', 'oops', 'cheer', 'question']) {
    assert.ok(moods.includes(expected), `缺少 ${expected}`);
  }
});

test('list 只返回元数据，不含图片字节', () => {
  const library = new StickerLibrary(fakePlugin());
  for (const entry of library.list()) {
    assert.deepEqual(Object.keys(entry).sort(), ['keywords', 'label', 'mood']);
    assert.ok(Array.isArray(entry.keywords));
  }
});

test('按 mood 精确解析', () => {
  const library = new StickerLibrary(fakePlugin());
  assert.equal(library.resolve('celebrate').mood, 'celebrate');
  assert.equal(library.resolve('oops').mood, 'oops');
});

test('未知 mood 用关键词兜底', () => {
  const library = new StickerLibrary(fakePlugin());
  assert.equal(library.resolve('unknown', '恭喜，全部通过').mood, 'celebrate');
  assert.equal(library.resolve('unknown', '抱歉出错了').mood, 'oops');
});

test('完全未知时回落到 happy', () => {
  const library = new StickerLibrary(fakePlugin());
  assert.equal(library.resolve('nope', 'zzz').mood, 'happy');
});

test('read 只在调用时读取 PNG 字节', () => {
  const library = new StickerLibrary(fakePlugin());
  const { entry, bytes } = library.read('happy');
  assert.equal(entry.mood, 'happy');
  assert.ok(bytes.length > 500);
  // PNG magic
  assert.equal(bytes[0], 0x89);
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG');
});

test('图库加载失败时降级为空且不抛错', () => {
  const plugin = fakePlugin();
  const library = new StickerLibrary(plugin);
  library.dir = '/nonexistent-sticker-dir';
  assert.deepEqual(library.list(), []);
  assert.equal(library.size, 0);
  assert.ok(plugin.logs.some((line) => line.includes('表情图库加载失败')));
});