import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StickerLibrary } from '../lib/stickers.js';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' +
  '0d0a2db40000000049454e44ae426082',
  'hex',
);

function fakePlugin(overrides = {}) {
  const logs = [];
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wx-stickers-'));
  return {
    logs,
    stateDir,
    config: {
      botAgent: 'test',
      maxMediaBytes: 20 * 1024 * 1024,
      stickers: { enabled: true, includeBuiltin: true, dir: '' },
      ...overrides,
    },
    state: { token: 'token', contextTokens: {} },
    baseUrl: 'https://example.invalid',
    peers: { sendTarget: (peer) => peer, label: (peer) => peer },
    log: (level, message) => logs.push(`${level}:${message}`),
  };
}

function makeUserDir(plugin, files = {}) {
  const dir = path.join(plugin.stateDir, 'stickers');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), data);
  }
  return dir;
}

test('内置图库可加载', () => {
  const library = new StickerLibrary(fakePlugin());
  assert.ok(library.size >= 8);
  assert.ok(library.moods().includes('happy'));
});

test('用户目录按文件名加入新情绪', () => {
  const plugin = fakePlugin();
  makeUserDir(plugin, { 'sparkle.png': PNG, 'angry.gif': PNG, 'notes.txt': 'ignored' });
  const library = new StickerLibrary(plugin);
  const moods = library.moods();
  assert.ok(moods.includes('sparkle'));
  assert.ok(moods.includes('angry'));
  assert.ok(!moods.some((mood) => mood === 'notes'));
});

test('用户图覆盖内置同名情绪，并记录来源', () => {
  const plugin = fakePlugin();
  makeUserDir(plugin, { 'happy.png': PNG });
  const library = new StickerLibrary(plugin);
  const entry = library.resolve('happy');
  assert.equal(entry.source, 'user');
  assert.ok(plugin.logs.some((line) => line.includes('用户表情覆盖内置')));
});

test('index.json 可补充标签与关键词', () => {
  const plugin = fakePlugin();
  makeUserDir(plugin, {
    'party.png': PNG,
    'index.json': JSON.stringify({ party: { label: '派对', keywords: ['生日', '开趴'] } }),
  });
  const library = new StickerLibrary(plugin);
  assert.equal(library.resolve('party').label, '派对');
  assert.equal(library.resolve('unknown', '祝你生日快乐').mood, 'party');
});

test('includeBuiltin=false 只用用户图库', () => {
  const plugin = fakePlugin({ stickers: { enabled: true, includeBuiltin: false, dir: '' } });
  makeUserDir(plugin, { 'only.png': PNG });
  const library = new StickerLibrary(plugin);
  assert.deepEqual(library.moods(), ['only']);
});

test('自定义 dir 支持绝对路径与 ~', () => {
  const plugin = fakePlugin();
  const custom = path.join(plugin.stateDir, 'my-stickers');
  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(path.join(custom, 'cool.png'), PNG);
  plugin.config.stickers = { enabled: true, includeBuiltin: false, dir: custom };
  const library = new StickerLibrary(plugin);
  assert.deepEqual(library.moods(), ['cool']);

  plugin.config.stickers = { enabled: true, includeBuiltin: false, dir: '~/nonexistent-sticker-dir-xyz' };
  const homeLibrary = new StickerLibrary(plugin);
  assert.equal(homeLibrary.userDir, path.join(os.homedir(), 'nonexistent-sticker-dir-xyz'));
});

test('reload 能发现新增图片', () => {
  const plugin = fakePlugin();
  const dir = makeUserDir(plugin, {});
  const library = new StickerLibrary(plugin);
  assert.ok(!library.moods().includes('later'));
  fs.writeFileSync(path.join(dir, 'later.png'), PNG);
  library.reload();
  assert.ok(library.moods().includes('later'));
});

test('list 不含图片字节，且带来源', () => {
  const plugin = fakePlugin();
  makeUserDir(plugin, { 'mine.png': PNG });
  const library = new StickerLibrary(plugin);
  for (const entry of library.list()) {
    assert.deepEqual(Object.keys(entry).sort(), ['keywords', 'label', 'mood', 'source']);
  }
  assert.equal(library.list().find((entry) => entry.mood === 'mine').source, 'user');
});

test('read 读取用户图库的真实文件', () => {
  const plugin = fakePlugin();
  makeUserDir(plugin, { 'mine.png': PNG });
  const library = new StickerLibrary(plugin);
  const { entry, bytes } = library.read('mine');
  assert.equal(entry.source, 'user');
  assert.equal(bytes[0], 0x89);
});

test('超过 maxMediaBytes 的表情拒绝发送', async () => {
  const plugin = fakePlugin({ maxMediaBytes: 10 });
  makeUserDir(plugin, { 'huge.png': PNG });
  const library = new StickerLibrary(plugin);
  await assert.rejects(() => library.send('peer@im.wechat', 'huge'), /上限/);
});