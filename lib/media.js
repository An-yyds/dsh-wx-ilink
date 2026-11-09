/** iLink 媒体：CDN 下载、AES-128-ECB 解密、类型嗅探。 */

import { createDecipheriv } from 'node:crypto';

export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const DEFAULT_MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 60_000;

export const ITEM = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };

export class MediaTooLargeError extends Error {
  constructor(bytes, maxBytes) {
    super(`媒体超过大小上限（${bytes ?? '未知'}B > ${maxBytes}B）`);
    this.name = 'MediaTooLargeError';
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

/** 从 base64 的 aes_key 解析 16 字节密钥；兼容 base64(16 字节) 与 base64(32 位 hex 字符串)。 */
export function parseAesKey(value) {
  const decoded = Buffer.from(String(value ?? ''), 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`aes_key 无法解析为 16 字节密钥（解码长度=${decoded.length}）`);
}

export function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function sniffImageMime(buf) {
  if (buf?.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf?.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf?.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf?.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

function mediaRef(media, aesKeyOverride) {
  if (!media || (!media.encrypt_query_param && !media.full_url)) return null;
  return {
    encryptQueryParam: media.encrypt_query_param ?? '',
    fullUrl: media.full_url ?? '',
    aesKey: aesKeyOverride ?? media.aes_key ?? '',
  };
}

function toSize(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

/**
 * 从一条 iLink 消息里提取可下载的媒体描述。
 * 只处理图片/文件/视频；语音用服务端转写文本，不下载。
 */
export function describeMedia(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  const out = [];
  for (const item of items) {
    if (item?.type === ITEM.IMAGE) {
      const data = item.image_item ?? {};
      const aesKey = data.aeskey ? Buffer.from(String(data.aeskey), 'hex').toString('base64') : undefined;
      const media = mediaRef(data.media, aesKey);
      if (media) out.push({ kind: 'image', media, name: '', size: 0 });
    } else if (item?.type === ITEM.FILE) {
      const data = item.file_item ?? {};
      const media = mediaRef(data.media);
      if (media) {
        out.push({
          kind: 'file',
          media,
          name: String(data.file_name ?? '').trim() || 'weixin-file',
          size: toSize(data.len),
        });
      }
    } else if (item?.type === ITEM.VIDEO) {
      const data = item.video_item ?? {};
      const media = mediaRef(data.media);
      if (media) {
        const thumb = mediaRef(data.thumb_media, data.thumb_media?.aes_key || data.media?.aes_key || '');
        out.push({
          kind: 'video',
          media,
          name: 'weixin-video.mp4',
          size: toSize(data.video_size),
          thumb: thumb ? { media: thumb, name: 'weixin-video-thumb.jpg', size: 0 } : undefined,
        });
      }
    }
  }
  return out;
}

export function hasMedia(message) {
  return describeMedia(message).length > 0;
}

function isTrustedUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:') return false;
    return url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com');
  } catch {
    return false;
  }
}

export function mediaDownloadUrl(media, cdnBaseUrl = CDN_BASE_URL) {
  if (media?.fullUrl && isTrustedUrl(media.fullUrl)) return media.fullUrl;
  const base = String(cdnBaseUrl || CDN_BASE_URL).replace(/\/+$/, '');
  return `${base}/download?encrypted_query_param=${encodeURIComponent(media?.encryptQueryParam ?? '')}`;
}

async function readBodyCapped(response, limit, abort) {
  const declared = Number(response.headers?.get?.('content-length') ?? NaN);
  if (limit && Number.isFinite(declared) && declared > limit + 16) {
    abort?.();
    throw new MediaTooLargeError(declared, limit);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (limit && buffer.length > limit + 16) throw new MediaTooLargeError(buffer.length, limit);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (limit && total > limit + 16) {
      await reader.cancel().catch(() => {});
      abort?.();
      throw new MediaTooLargeError(total, limit);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** 下载并解密一个媒体，返回明文字节；超限抛 MediaTooLargeError。 */
export async function fetchMedia(media, { maxBytes = DEFAULT_MAX_MEDIA_BYTES, signal, fetchImpl = fetch, timeoutMs = MEDIA_TIMEOUT_MS, cdnBaseUrl = CDN_BASE_URL } = {}) {
  if (!media?.encryptQueryParam && !media?.fullUrl) throw new Error('媒体缺少下载地址');
  const url = mediaDownloadUrl(media, cdnBaseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined = signal
    ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, controller.signal]) : controller.signal)
    : controller.signal;
  try {
    const response = await fetchImpl(url, { signal: combined, redirect: 'follow' });
    if (!response.ok) throw new Error(`CDN 下载 HTTP ${response.status}`);
    const encrypted = await readBodyCapped(response, maxBytes, () => controller.abort());
    const plain = media.aesKey ? decryptAesEcb(encrypted, parseAesKey(media.aesKey)) : encrypted;
    if (maxBytes && plain.length > maxBytes) throw new MediaTooLargeError(plain.length, maxBytes);
    return plain;
  } finally {
    clearTimeout(timer);
  }
}
