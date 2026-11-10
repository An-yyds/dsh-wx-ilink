/**
 * 控制类工具：让任何 DSH 界面（Web / 桌面端 / 终端）都能登录和管理微信，
 * 不依赖宿主是否提供 webServer。
 *
 * - weixin_login   生成登录二维码（图片）并返回状态
 * - weixin_verify  提交手机上的数字验证码
 * - weixin_status  连接与会话状态
 * - weixin_logout  退出登录
 *
 * @module dsh-wx-ilink/control
 */

import fs from 'node:fs';
import path from 'node:path';

import { sleep } from './ilink.js';
import { dataUrlBytes, qrDataUrl } from './qr.js';

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
};

function textOf(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

export class ControlTools {
  constructor(plugin) {
    this.plugin = plugin;
  }

  /** 二维码写一份文件到状态目录，任何界面都能直接打开。 */
  saveQrFile(content) {
    try {
      const dir = this.plugin.stateDir;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, 'login-qr.gif');
      fs.writeFileSync(file, dataUrlBytes(qrDataUrl(content)), { mode: 0o600 });
      return file;
    } catch (error) {
      this.plugin.log('warn', `二维码写文件失败：${error?.message ?? error}`);
      return undefined;
    }
  }

  /** 把二维码 data URL 存成图片附件；没有附件服务时返回 undefined。 */
  async saveQr(content) {
    const attachments = this.plugin.ctx.get?.('attachments') ?? this.plugin.ctx.attachments;
    if (!attachments?.saveImage) return undefined;
    try {
      const ref = await attachments.saveImage({
        data: dataUrlBytes(qrDataUrl(content)),
        mediaType: 'image/gif',
        name: 'weixin-login-qr.gif',
      });
      return {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name ? { name: ref.name } : {}),
      };
    } catch (error) {
      this.plugin.log('warn', `二维码转图片失败：${error?.message ?? error}`);
      return undefined;
    }
  }

  register() {
    this.registerLogin();
    this.registerVerify();
    this.registerStatus();
    this.registerLogout();
  }

  registerLogin() {
    const plugin = this.plugin;
    const tools = this;
    plugin.ctx.tools?.register?.({
      name: 'weixin_login',
      description: '生成微信 iLink 登录二维码并以图片返回，用户用手机微信扫码即可把微信接入 DSH。已登录时返回当前状态。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          timeout_seconds: {
            type: 'integer',
            description: '等待二维码生成的最长秒数，默认 20。',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            connected: { type: 'boolean' },
            state: { type: 'string' },
            message: { type: 'string' },
            needCode: { type: 'boolean' },
            botId: { type: 'string' },
            panelUrl: { type: 'string' },
            qrPath: { type: 'string' },
            image: IMAGE_SCHEMA,
          },
          required: ['connected', 'state'],
        },
        render: (args, value) => {
          const lines = [
            value.connected ? '微信已连接。' : `登录状态：${value.state}${value.message ? ` — ${value.message}` : ''}`,
            value.botId ? `机器人：${value.botId}` : '',
            value.needCode ? '手机微信显示了数字验证码，请调用 weixin_verify 提交。' : '',
            value.image ? '请用手机微信扫描下方二维码。' : '',
            value.qrPath ? `二维码文件：${value.qrPath}` : '',
            value.panelUrl ? `本地面板：${value.panelUrl}` : '',
          ].filter(Boolean);
          const content = [{ type: 'text', text: lines.join('\n') }];
          if (value.image) content.push({ type: 'image', attachment: value.image });
          return content;
        },
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        if (plugin.state?.token) {
          return {
            connected: true,
            state: 'connected',
            message: '已连接微信，无需重新扫码',
            needCode: false,
            botId: plugin.state.botId ?? '',
            panelUrl: plugin.pageUrl() ?? '',
          };
        }
        const seconds = Math.max(5, Math.min(90, Number(args?.timeout_seconds) || 20));
        if (!plugin.login.running) {
          plugin.login.stop();
          plugin.login.start().catch((error) => plugin.log('error', `启动登录失败：${error?.message ?? error}`));
        }
        const deadline = Date.now() + seconds * 1000;
        while (Date.now() < deadline) {
          if (plugin.login.qrContent || plugin.login.state === 'error') break;
          await sleep(200);
        }
        const snapshot = plugin.login.snapshot();
        const content = plugin.login.qrContent;
        const image = content ? await tools.saveQr(content) : undefined;
        const qrPath = content ? tools.saveQrFile(content) : undefined;
        return {
          connected: false,
          state: snapshot.state,
          message: snapshot.message ?? '',
          needCode: Boolean(snapshot.needCode),
          botId: '',
          panelUrl: plugin.pageUrl() ?? '',
          ...(qrPath ? { qrPath } : {}),
          ...(image ? { image } : {}),
        };
      },
    });
  }

  registerVerify() {
    const plugin = this.plugin;
    plugin.ctx.tools?.register?.({
      name: 'weixin_verify',
      description: '提交手机微信上显示的数字验证码，完成 iLink 登录验证。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string', description: '手机微信上显示的 6 位数字验证码。' },
        },
        required: ['code'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            state: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (args, value) => textOf(value.ok ? `验证码已提交：${value.message ?? ''}` : `提交失败：${value.message ?? ''}`),
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const result = plugin.login.submitCode(String(args?.code ?? ''));
        return { ok: result.ok, message: result.message ?? '', state: plugin.login.state };
      },
    });
  }

  registerStatus() {
    const plugin = this.plugin;
    plugin.ctx.tools?.register?.({
      name: 'weixin_status',
      description: '查看微信 iLink 通道的连接状态、会话数、审批/提问等待与当前配置。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            state: { type: 'string' },
            stateText: { type: 'string' },
            message: { type: 'string' },
            connected: { type: 'boolean' },
            botId: { type: 'string' },
            sessions: { type: 'integer' },
            approvals: { type: 'integer' },
            questions: { type: 'integer' },
            groups: { type: 'string' },
            alerts: { type: 'boolean' },
            cwd: { type: 'string' },
            panelUrl: { type: 'string' },
          },
          required: ['state', 'connected'],
        },
        render: (args, value) => textOf([
          `状态：${value.stateText ?? value.state}`,
          `连接：${value.connected ? '已连接' : '未连接'}`,
          value.botId ? `机器人：${value.botId}` : '',
          `会话：${value.sessions ?? 0} · 审批等待：${value.approvals ?? 0} · 提问等待：${value.questions ?? 0}`,
          `群聊：${value.groups ?? 'off'} · 告警：${value.alerts ? '开' : '关'}`,
          value.cwd ? `工作目录：${value.cwd}` : '',
          value.panelUrl ? `本地面板：${value.panelUrl}` : '',
        ].filter(Boolean).join('\n')),
      },
      isConcurrencySafe: () => true,
      async execute() {
        const status = plugin.statusPayload();
        return {
          state: status.state,
          stateText: status.stateText,
          message: status.message,
          connected: status.connected,
          botId: status.botId,
          sessions: status.sessions,
          approvals: status.approvals,
          questions: status.questions,
          groups: status.groups,
          alerts: status.alerts,
          cwd: status.cwd,
          panelUrl: plugin.pageUrl() ?? '',
        };
      },
    });
  }

  registerLogout() {
    const plugin = this.plugin;
    plugin.ctx.tools?.register?.({
      name: 'weixin_logout',
      description: '退出当前微信 iLink 登录，并清除本地 bot_token。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (args, value) => textOf(value.message || (value.ok ? '已退出登录' : '退出失败')),
      },
      isConcurrencySafe: () => false,
      async execute() {
        try {
          await plugin.logout();
          return { ok: true, message: '已退出微信登录，可重新调用 weixin_login 扫码。' };
        } catch (error) {
          return { ok: false, message: `退出失败：${error?.message ?? error}` };
        }
      },
    });
  }
}
