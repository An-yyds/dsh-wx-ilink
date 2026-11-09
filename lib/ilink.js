/**
 * iLink Bot 协议客户端（独立实现）。
 *
 * 协议事实参考腾讯官方 OpenClaw 微信通道
 * （@tencent-weixin/openclaw-weixin，MIT）：
 *   - 登录：POST ilink/bot/get_bot_qrcode → GET ilink/bot/get_qrcode_status
 *   - 收消息：POST ilink/bot/getupdates（长轮询，get_updates_buf 游标）
 *   - 发消息：POST ilink/bot/sendmessage（context_token 回显）
 * 代码为本项目自行编写，不复制上游实现。
 */

import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const APP_ID = 'bot';
/** 2.4.10 → 0x02040A；协议按客户端版本做兼容。 */
export const CLIENT_VERSION = (2 << 16) | (4 << 8) | 10;
export const CHANNEL_VERSION = '2.4.10';
export const DEFAULT_BOT_AGENT = 'DSH-ILink/0.1.0';
export const LONG_POLL_TIMEOUT_MS = 35_000;
export const API_TIMEOUT_MS = 15_000;

export class ILinkError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'ILinkError';
    Object.assign(this, info);
  }
}

/** bot_token 失效（官方 SESSION_EXPIRED_ERRCODE）。 */
export function isSessionExpired(error) {
  return error instanceof ILinkError && (error.errcode === -14 || error.ret === -14);
}

function isBadResponse(resp) {
  const ret = resp?.ret;
  const errcode = resp?.errcode;
  return (ret !== undefined && ret !== null && ret !== 0) || (errcode !== undefined && errcode !== null && errcode !== 0);
}

export function assertOk(endpoint, resp) {
  if (!isBadResponse(resp)) return resp;
  const fields = [endpoint];
  if (resp?.ret !== undefined && resp?.ret !== null) fields.push(`ret=${resp.ret}`);
  if (resp?.errcode !== undefined && resp?.errcode !== null) fields.push(`errcode=${resp.errcode}`);
  if (resp?.errmsg) fields.push(`errmsg=${resp.errmsg}`);
  throw new ILinkError(fields.join(' '), { ret: resp?.ret, errcode: resp?.errcode, errmsg: resp?.errmsg });
}

function buildHeaders(token) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': APP_ID,
    'iLink-App-ClientVersion': String(CLIENT_VERSION),
  };
  if (token && token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

function randomWechatUin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
}

function baseInfo(botAgent) {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: String(botAgent || DEFAULT_BOT_AGENT).slice(0, 200),
  };
}

function combineSignals(signals) {
  const list = signals.filter(Boolean);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) { controller.abort(); break; }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/**
 * 统一的 JSON 请求。超时或网络错误都会以 Error/AbortError 抛出；
 * 长轮询的调用方自行把「超时」当作空结果处理。
 */
export async function apiRequest({ baseUrl, method = 'POST', endpoint, body, token, timeoutMs = API_TIMEOUT_MS, signal, botAgent }) {
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '') + '/';
  const url = new URL(endpoint, base).toString();
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const response = await fetch(url, {
      method,
      headers: buildHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combineSignals([signal, controller.signal]),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ILinkError(`${endpoint} HTTP ${response.status}: ${text.slice(0, 200)}`, { status: response.status });
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ILinkError(`${endpoint} 返回的不是 JSON：${text.slice(0, 160)}`);
    }
    return json;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------ 登录 ------------------------------ */

/** 申请登录二维码。qrcode 是二维码票据，qrcode_img_content 是要编码进二维码的文本。 */
export async function getQrCode({ baseUrl, botType = '3', tokenList = [], signal }) {
  const resp = await apiRequest({
    baseUrl,
    method: 'POST',
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: { local_token_list: Array.isArray(tokenList) ? tokenList.slice(0, 10) : [] },
    timeoutMs: API_TIMEOUT_MS,
    signal,
  });
  if (!resp?.qrcode || !resp?.qrcode_img_content) {
    throw new ILinkError(`get_bot_qrcode 响应缺少字段：${JSON.stringify(resp).slice(0, 200)}`);
  }
  return { qrcode: resp.qrcode, content: resp.qrcode_img_content };
}

/**
 * 轮询扫码状态。服务端会 hold 35 秒；客户端超时按 wait 处理。
 * 返回 status：wait / scaned / need_verifycode / expired / scaned_but_redirect /
 * verify_code_blocked / binded_redirect / confirmed。
 */
export async function getQrStatus({ baseUrl, qrcode, verifyCode, timeoutMs = LONG_POLL_TIMEOUT_MS, signal }) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    return await apiRequest({ baseUrl, method: 'GET', endpoint, timeoutMs, signal });
  } catch (error) {
    if (error?.name === 'AbortError' && !signal?.aborted) return { status: 'wait' };
    throw error;
  }
}

/* ------------------------------ 消息 ------------------------------ */

/** 长轮询收消息；客户端超时返回空结果，调用方直接继续下一轮。 */
export async function getUpdates({ baseUrl, token, buf = '', timeoutMs = LONG_POLL_TIMEOUT_MS, signal, botAgent }) {
  try {
    const resp = await apiRequest({
      baseUrl,
      method: 'POST',
      endpoint: 'ilink/bot/getupdates',
      token,
      timeoutMs,
      signal,
      body: { get_updates_buf: buf ?? '', base_info: baseInfo(botAgent) },
    });
    return assertOk('getupdates', resp);
  } catch (error) {
    if (error?.name === 'AbortError' && !signal?.aborted) {
      return { ret: 0, msgs: [], get_updates_buf: buf ?? '' };
    }
    throw error;
  }
}

/** 发送单条文本；ret=-2 视为限流，指数退避重试。 */
export async function sendText({ baseUrl, token, to, text, contextToken, botAgent, signal, maxAttempts = 3, onWarn }) {
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: randomUUID(),
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
      ...(contextToken ? { context_token: contextToken } : {}),
    },
    base_info: baseInfo(botAgent),
  };
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await apiRequest({
        baseUrl,
        method: 'POST',
        endpoint: 'ilink/bot/sendmessage',
        token,
        body,
        signal,
        timeoutMs: API_TIMEOUT_MS,
      });
      const ret = resp?.ret ?? 0;
      const errcode = resp?.errcode ?? 0;
      if (ret === 0 && errcode === 0) return resp;
      lastError = new ILinkError(`sendmessage ret=${ret} errcode=${errcode} ${resp?.errmsg ?? ''}`.trim(), { ret, errcode, errmsg: resp?.errmsg });
      const rateLimited = ret === -2 || /rate|频繁|限流/i.test(String(resp?.errmsg ?? ''));
      if (rateLimited && attempt < maxAttempts) {
        const wait = Math.min(2 ** attempt, 8) * 1000;
        onWarn?.(`发送被限流（ret=${ret}），${wait / 1000}s 后重试`);
        await sleep(wait);
        continue;
      }
      throw lastError;
    } catch (error) {
      lastError = error;
      if (error instanceof ILinkError) throw error;
      if (attempt < maxAttempts) {
        const wait = Math.min(2 ** attempt, 8) * 1000;
        onWarn?.(`发送网络错误，${wait / 1000}s 后重试：${error?.message ?? error}`);
        await sleep(wait);
      }
    }
  }
  throw lastError ?? new Error('sendmessage 重试耗尽');
}

/** 通知服务端通道启动/停止；失败不影响主流程。 */
export async function notifyStart({ baseUrl, token, botAgent, signal }) {
  return apiRequest({
    baseUrl,
    method: 'POST',
    endpoint: 'ilink/bot/msg/notifystart',
    token,
    body: { base_info: baseInfo(botAgent) },
    timeoutMs: 10_000,
    signal,
  });
}

export async function notifyStop({ baseUrl, token, botAgent, signal }) {
  return apiRequest({
    baseUrl,
    method: 'POST',
    endpoint: 'ilink/bot/msg/notifystop',
    token,
    body: { base_info: baseInfo(botAgent) },
    timeoutMs: 10_000,
    signal,
  });
}


/** 取会话配置（主要是 typing_ticket，用于“正在输入”）。 */
export async function getConfig({ baseUrl, token, ilinkUserId, contextToken, botAgent, signal }) {
  const resp = await apiRequest({
    baseUrl,
    method: 'POST',
    endpoint: 'ilink/bot/getconfig',
    token,
    signal,
    timeoutMs: 10_000,
    body: {
      ilink_user_id: ilinkUserId,
      ...(contextToken ? { context_token: contextToken } : {}),
      base_info: baseInfo(botAgent),
    },
  });
  return resp;
}

/** 发送“正在输入”状态：1 = 开始，2 = 取消。 */
export async function sendTyping({ baseUrl, token, to, typingTicket, status, botAgent, signal }) {
  return apiRequest({
    baseUrl,
    method: 'POST',
    endpoint: 'ilink/bot/sendtyping',
    token,
    signal,
    timeoutMs: 10_000,
    body: {
      ilink_user_id: to,
      ...(typingTicket ? { typing_ticket: typingTicket } : {}),
      status,
      base_info: baseInfo(botAgent),
    },
  });
}


/* ------------------------------ 上行媒体 ------------------------------ */

export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const UPLOAD_TIMEOUT_MS = 60_000;

export function aesEcbPaddedSize(plainSize) {
  return Math.ceil((plainSize + 1) / 16) * 16;
}

export function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** 申请上传参数。 */
export async function getUploadUrl({ baseUrl, token, filekey, mediaType, toUserId, rawsize, rawfilemd5, filesize, aeskeyHex, botAgent, signal }) {
  const resp = await apiRequest({
    baseUrl,
    method: 'POST',
    endpoint: 'ilink/bot/getuploadurl',
    token,
    signal,
    timeoutMs: API_TIMEOUT_MS,
    body: {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskeyHex,
      base_info: baseInfo(botAgent),
    },
  });
  return assertOk('getuploadurl', resp);
}

function trustedCdnUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && (url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'));
  } catch {
    return false;
  }
}

export function cdnUploadUrl({ uploadParam, uploadFullUrl, filekey, cdnBaseUrl = CDN_BASE_URL }) {
  if (uploadFullUrl && trustedCdnUrl(uploadFullUrl)) return uploadFullUrl;
  if (!uploadParam) throw new ILinkError('getuploadurl 没有返回上传地址');
  const base = String(cdnBaseUrl || CDN_BASE_URL).replace(/\/+$/, '');
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

async function uploadCiphertext({ url, ciphertext, signal, maxAttempts = 3 }) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      if (response.status >= 400 && response.status < 500) {
        const message = response.headers.get('x-error-message') ?? (await response.text());
        throw new ILinkError(`CDN 上传被拒 HTTP ${response.status}: ${message}`);
      }
      if (response.status !== 200) throw new ILinkError(`CDN 上传失败 HTTP ${response.status}`);
      const param = response.headers.get('x-encrypted-param');
      if (!param) throw new ILinkError('CDN 上传响应缺少 x-encrypted-param');
      return param;
    } catch (error) {
      lastError = error;
      if (error instanceof ILinkError && /被拒/.test(error.message)) throw error;
      if (attempt < maxAttempts) await sleep(500 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new ILinkError('CDN 上传失败');
}

/**
 * 上传一个媒体到微信 CDN：明文 → AES-128-ECB → getuploadurl → POST CDN。
 * 返回的 aeskeyHex 在构建 item 时要 base64(hex 字符串) 填入 media.aes_key。
 */
export async function uploadMedia({ baseUrl, token, to, data, mediaType, botAgent, signal, cdnBaseUrl = CDN_BASE_URL }) {
  const plain = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const aeskey = randomBytes(16);
  const filekey = randomBytes(16).toString('hex');
  const rawfilemd5 = createHash('md5').update(plain).digest('hex');
  const cipherSize = aesEcbPaddedSize(plain.length);
  const resp = await getUploadUrl({
    baseUrl,
    token,
    filekey,
    mediaType,
    toUserId: to,
    rawsize: plain.length,
    rawfilemd5,
    filesize: cipherSize,
    aeskeyHex: aeskey.toString('hex'),
    botAgent,
    signal,
  });
  const url = cdnUploadUrl({ uploadParam: resp.upload_param, uploadFullUrl: resp.upload_full_url, filekey, cdnBaseUrl });
  const ciphertext = encryptAesEcb(plain, aeskey);
  const downloadParam = await uploadCiphertext({ url, ciphertext, signal });
  return { downloadParam, aeskeyHex: aeskey.toString('hex'), plainSize: plain.length, cipherSize: ciphertext.length };
}

/** 上传结果 → iLink 发送用的 item。 */
export function buildMediaItem(kind, uploaded, fileName) {
  const media = {
    encrypt_query_param: uploaded.downloadParam,
    aes_key: Buffer.from(uploaded.aeskeyHex, 'ascii').toString('base64'),
    encrypt_type: 1,
  };
  if (kind === 'image') return { type: 2, image_item: { media, mid_size: uploaded.cipherSize } };
  if (kind === 'video') return { type: 5, video_item: { media, video_size: uploaded.cipherSize } };
  return { type: 4, file_item: { media, file_name: String(fileName ?? 'file'), len: String(uploaded.plainSize) } };
}

/** 发送任意 item 列表（文本/图片/文件/视频）。 */
export async function sendItems({ baseUrl, token, to, items, contextToken, botAgent, signal }) {
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: randomUUID(),
      message_type: 2,
      message_state: 2,
      item_list: Array.isArray(items) ? items : [],
      ...(contextToken ? { context_token: contextToken } : {}),
    },
    base_info: baseInfo(botAgent),
  };
  const resp = await apiRequest({
    baseUrl,
    method: 'POST',
    endpoint: 'ilink/bot/sendmessage',
    token,
    body,
    signal,
    timeoutMs: API_TIMEOUT_MS,
  });
  return assertOk('sendmessage', resp);
}

/* ------------------------------ 工具 ------------------------------ */

/** 从一条 iLink 消息里取文字；语音消息优先用服务端转写文本。 */
export function extractText(msg) {
  const items = Array.isArray(msg?.item_list) ? msg.item_list : [];
  const texts = [];
  for (const item of items) {
    if (item?.type === 1 && typeof item.text_item?.text === 'string') texts.push(item.text_item.text);
  }
  if (texts.length) return texts.join('\n').trim();
  for (const item of items) {
    if (item?.type === 3 && typeof item.voice_item?.text === 'string' && item.voice_item.text.trim()) {
      return item.voice_item.text.trim();
    }
  }
  return '';
}

/** 按字符切分，优先在换行处断开，且不劈开 emoji 的代理对。 */
export function chunkText(text, max = 1500) {
  const limit = Math.max(1, Math.floor(Number(max) || 1500));
  const source = String(text ?? '');
  const parts = [];
  let rest = source;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    if (cut > 0 && cut < rest.length) {
      const prev = rest.charCodeAt(cut - 1);
      const next = rest.charCodeAt(cut);
      if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        cut = cut > 1 ? cut - 1 : cut + 1;
      }
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
