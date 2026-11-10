/**
 * 纯文本与 HTTP 工具函数。
 * @module dsh-wx-ilink/text
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';

export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('body is not JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendTextResponse(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

export function isWriterHeld(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'SessionAlreadyOwnedError' || error.code === 'session/writer-held') return true;
  return /already owned by an active write handle|writer.?held/i.test(String(error.message ?? ''));
}

export function makeUserMessage(content, peer) {
  return {
    id: `msg-${randomUUID()}`,
    role: 'user',
    content,
    source: { kind: 'user', channel: 'dsh-wx-ilink', peer },
  };
}

export function sanitizeMediaName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 120);
  return cleaned || `weixin-media-${Date.now()}`;
}

/** 把模型常见的 Markdown 降到微信里可读的纯文本。 */
export function toPlainText(text) {
  return String(text ?? '')
    .replace(/```[a-zA-Z0-9_+-]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .trim();
}

/** 汇总从 firstSeq 开始这一轮的最后一条 assistant 文本和 turn/end 原因。 */
export function summarizeTurn(session, firstSeq) {
  const end = session.seq;
  let text = '';
  let reason;
  let started = false;
  for (let seq = firstSeq; seq < end; seq += 1) {
    const event = session.eventAt(seq);
    if (!event) continue;
    if (event.type === 'turn/start') {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content ?? [];
      const joined = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      if (joined) text = joined;
    }
    if (event.type === 'turn/end') reason = event.data?.reason;
  }
  return { text, reason };
}

export function reasonText(reason) {
  if (!reason) return '';
  if (reason.kind === 'error') {
    const code = reason.error?.code ? `${reason.error.code}: ` : '';
    return `执行失败：${code}${reason.error?.message ?? '未知错误'}`;
  }
  if (reason.kind === 'aborted') return '任务已取消。';
  if (reason.kind === 'blocked') return '任务被阻塞。';
  return '';
}
