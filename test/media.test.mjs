import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCipheriv } from 'node:crypto';

import {
  parseAesKey,
  decryptAesEcb,
  sniffImageMime,
  describeMedia,
  mediaDownloadUrl,
  fetchMedia,
  MediaTooLargeError,
} from '../lib/media.js';

const KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

function encryptAesEcb(plain, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

test('aes_key 支持 base64(16字节) 与 base64(32位hex)', () => {
  assert.deepEqual(parseAesKey(KEY.toString('base64')), KEY);
  assert.deepEqual(parseAesKey(Buffer.from(KEY.toString('hex')).toString('base64')), KEY);
  assert.throws(() => parseAesKey(Buffer.from('short').toString('base64')));
});

test('AES-128-ECB 解密还原明文', () => {
  const plain = Buffer.from('你好，微信媒体', 'utf8');
  const encrypted = encryptAesEcb(plain, KEY);
  assert.deepEqual(decryptAesEcb(encrypted, KEY), plain);
});

test('图片类型嗅探', () => {
  assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(sniffImageMime(Buffer.from('RIFF0000WEBP')), 'image/webp');
});

test('describeMedia 提取图片/文件/视频', () => {
  const message = {
    item_list: [
      { type: 2, image_item: { media: { encrypt_query_param: 'img-q', full_url: 'https://novac2c.cdn.weixin.qq.com/x' }, aeskey: KEY.toString('hex') } },
      { type: 4, file_item: { media: { encrypt_query_param: 'file-q' }, file_name: '报告.pdf', len: '1234' } },
      { type: 5, video_item: { media: { encrypt_query_param: 'video-q' }, video_size: 999, thumb_media: { encrypt_query_param: 'thumb-q' } } },
    ],
  };
  const refs = describeMedia(message);
  assert.equal(refs.length, 3);
  assert.equal(refs[0].kind, 'image');
  assert.equal(refs[0].media.aesKey, KEY.toString('base64'));
  assert.equal(refs[1].name, '报告.pdf');
  assert.equal(refs[1].size, 1234);
  assert.equal(refs[2].kind, 'video');
  assert.equal(refs[2].thumb.media.encryptQueryParam, 'thumb-q');
});

test('mediaDownloadUrl 只信任微信域名', () => {
  assert.match(mediaDownloadUrl({ encryptQueryParam: 'q' }), /novac2c\.cdn\.weixin\.qq\.com\/c2c\/download\?encrypted_query_param=q/);
  assert.equal(mediaDownloadUrl({ encryptQueryParam: 'q', fullUrl: 'https://evil.example/x' }), 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=q');
  assert.equal(mediaDownloadUrl({ encryptQueryParam: 'q', fullUrl: 'https://novac2c.cdn.weixin.qq.com/x' }), 'https://novac2c.cdn.weixin.qq.com/x');
});

test('fetchMedia 下载并解密，超限报 MediaTooLargeError', async () => {
  const plain = Buffer.from('hello media', 'utf8');
  const encrypted = encryptAesEcb(plain, KEY);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(encrypted);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const bytes = await fetchMedia(
      { fullUrl: `http://127.0.0.1:${port}/media`, aesKey: KEY.toString('base64') },
      { maxBytes: 1024, cdnBaseUrl: `http://127.0.0.1:${port}` },
    );
    assert.deepEqual(bytes, plain);
    await assert.rejects(
      () => fetchMedia({ fullUrl: `http://127.0.0.1:${port}/media`, aesKey: KEY.toString('base64') }, { maxBytes: 3, cdnBaseUrl: `http://127.0.0.1:${port}` }),
      (error) => error instanceof MediaTooLargeError,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
