import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  getQrCode,
  getQrStatus,
  getUpdates,
  sendText,
  extractText,
  chunkText,
  isSessionExpired,
  ILinkError,
} from '../lib/ilink.js';

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

test('getQrCode 请求头与响应解析', async () => {
  let seen;
  await withServer(async (req, res) => {
    seen = { url: req.url, method: req.method, headers: req.headers, body: await readBody(req) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ qrcode: 'qr-ticket', qrcode_img_content: 'https://weixin.qq.com/x/abc' }));
  }, async (baseUrl) => {
    const result = await getQrCode({ baseUrl, tokenList: ['old-token'] });
    assert.equal(result.qrcode, 'qr-ticket');
    assert.equal(result.content, 'https://weixin.qq.com/x/abc');
    assert.equal(seen.method, 'POST');
    assert.match(seen.url, /get_bot_qrcode\?bot_type=3/);
    assert.equal(seen.headers['ilink-app-id'], 'bot');
    assert.match(seen.headers['x-wechat-uin'], /^[A-Za-z0-9+/=]+$/);
    assert.deepEqual(JSON.parse(seen.body), { local_token_list: ['old-token'] });
  });
});

test('getQrStatus 处理 need_verifycode', async () => {
  let seenUrl;
  await withServer(async (req, res) => {
    seenUrl = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'need_verifycode' }));
  }, async (baseUrl) => {
    const result = await getQrStatus({ baseUrl, qrcode: 'ticket', verifyCode: '123456' });
    assert.equal(result.status, 'need_verifycode');
    assert.match(seenUrl, /verify_code=123456/);
  });
});

test('getUpdates 返回消息与游标', async () => {
  await withServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    assert.ok('get_updates_buf' in body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ret: 0,
      get_updates_buf: 'cursor-2',
      msgs: [{ message_id: 'm1', from_user_id: 'wxid_a', message_type: 1, message_state: 2, context_token: 'ct', item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
    }));
  }, async (baseUrl) => {
    const result = await getUpdates({ baseUrl, token: 'tok', buf: 'cursor-1' });
    assert.equal(result.get_updates_buf, 'cursor-2');
    assert.equal(result.msgs[0].message_id, 'm1');
  });
});

test('getUpdates 透传 -14 会话过期', async () => {
  await withServer(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errcode: -14, errmsg: 'session timeout' }));
  }, async (baseUrl) => {
    await assert.rejects(() => getUpdates({ baseUrl, token: 'tok', buf: '' }), (error) => {
      assert.ok(error instanceof ILinkError);
      assert.equal(isSessionExpired(error), true);
      return true;
    });
  });
});

test('sendText 构造正确的文本消息并带 context_token', async () => {
  let seen;
  await withServer(async (req, res) => {
    seen = { headers: req.headers, body: JSON.parse(await readBody(req)) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ret: 0, message_id: 'server-1' }));
  }, async (baseUrl) => {
    await sendText({ baseUrl, token: 'bot-token', to: 'wxid_a', text: '你好', contextToken: 'ctx-1' });
    assert.equal(seen.headers.authorization, 'Bearer bot-token');
    assert.equal(seen.body.msg.to_user_id, 'wxid_a');
    assert.equal(seen.body.msg.message_type, 2);
    assert.equal(seen.body.msg.message_state, 2);
    assert.equal(seen.body.msg.context_token, 'ctx-1');
    assert.deepEqual(seen.body.msg.item_list, [{ type: 1, text_item: { text: '你好' } }]);
    assert.equal(seen.body.base_info.channel_version, '2.4.10');
  });
});

test('extractText 支持文本与语音转写', () => {
  assert.equal(extractText({ item_list: [{ type: 1, text_item: { text: 'a' } }, { type: 1, text_item: { text: 'b' } }] }), 'a\nb');
  assert.equal(extractText({ item_list: [{ type: 2 }] }), '');
  assert.equal(extractText({ item_list: [{ type: 3, voice_item: { text: '语音转文字' } }] }), '语音转文字');
});

test('chunkText 不劈开代理对且保留全部字符', () => {
  const source = 'a'.repeat(10) + '😀' + 'b'.repeat(10);
  const parts = chunkText(source, 12);
  assert.equal(parts.join(''), source);
  for (const part of parts) {
    assert.ok(!/^[\uDC00-\uDFFF]/.test(part), '不能以低代理项开头');
    assert.ok(!/[\uD800-\uDBFF]$/.test(part), '不能以高代理项结尾');
  }
});
