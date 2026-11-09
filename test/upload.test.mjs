import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { uploadMedia, buildMediaItem } from '../lib/ilink.js';

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

test('uploadMedia 申请上传、加密上传并返回下载参数', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ url: req.url, method: req.method, body: body.length, headers: req.headers });
    if (req.url.startsWith('/ilink/bot/getuploadurl')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ret: 0, upload_param: 'upload-param' }));
      return;
    }
    if (req.url.startsWith('/upload?')) {
      res.writeHead(200, { 'x-encrypted-param': 'download-param' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const result = await uploadMedia({
      baseUrl,
      cdnBaseUrl: baseUrl,
      token: 'token',
      to: 'wxid_a',
      data: Buffer.from('hello media', 'utf8'),
      mediaType: 3,
      botAgent: 'test',
    });
    assert.equal(result.downloadParam, 'download-param');
    assert.equal(result.plainSize, 11);
    assert.equal(result.cipherSize, 16);
    const getUpload = requests.find((r) => r.url.includes('getuploadurl'));
    assert.ok(getUpload);
    const upload = requests.find((r) => r.url.startsWith('/upload?'));
    assert.ok(upload);
    assert.equal(upload.headers['content-type'], 'application/octet-stream');
    assert.equal(upload.body, 16);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('buildMediaItem 构造文件/图片/视频条目', () => {
  const uploaded = { downloadParam: 'dl', aeskeyHex: '00112233445566778899aabbccddeeff', plainSize: 5, cipherSize: 16 };
  const file = buildMediaItem('file', uploaded, 'a.txt');
  assert.equal(file.type, 4);
  assert.equal(file.file_item.file_name, 'a.txt');
  assert.equal(file.file_item.media.encrypt_query_param, 'dl');
  assert.equal(file.file_item.media.aes_key, Buffer.from(uploaded.aeskeyHex, 'ascii').toString('base64'));
  assert.equal(buildMediaItem('image', uploaded, 'a.jpg').type, 2);
  assert.equal(buildMediaItem('video', uploaded, 'a.mp4').type, 5);
});
