/**
 * iLink 扫码登录状态机：二维码、验证码、节点重定向、过期刷新。
 * @module dsh-wx-ilink/login
 */

import {
  getQrCode,
  getQrStatus,
  sleep,
} from './ilink.js';

export class LoginSession {
  constructor(plugin) {
    this.plugin = plugin;
    this.state = 'idle';
    this.message = '未登录';
    this.qrCode = '';
    this.qrContent = '';
    this.qrAt = 0;
    this.pendingCode = '';
    this.running = false;
    this.runId = 0;
    this.pollingRunId = 0;
    this.controller = null;
    this.refreshes = 0;
  }

  snapshot() {
    return {
      state: this.state,
      message: this.message,
      hasQr: Boolean(this.qrContent) && this.state !== 'connected',
      qrAt: this.qrAt,
      needCode: this.state === 'need_code',
    };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.runId += 1;
    const runId = this.runId;
    this.pollingRunId = 0;
    this.state = 'starting';
    this.message = '正在获取登录二维码…';
    this.qrCode = '';
    this.qrContent = '';
    this.qrAt = 0;
    this.pendingCode = '';
    this.refreshes = 0;
    this.controller = new AbortController();
    this.plugin.log('info', '开始微信扫码登录');
    try {
      await this.loadQr();
      if (runId !== this.runId) return;
      this.state = 'wait';
      this.message = '请用手机微信扫一扫';
      this.launchPoll(runId);
    } catch (error) {
      if (runId !== this.runId) return;
      this.running = false;
      this.state = 'error';
      this.message = `获取二维码失败：${error?.message ?? error}`;
      this.plugin.log('error', this.message);
    }
  }

  async loadQr() {
    const result = await getQrCode({
      baseUrl: this.plugin.baseUrl,
      tokenList: this.plugin.state.token ? [this.plugin.state.token] : [],
      signal: this.controller?.signal,
    });
    this.qrCode = result.qrcode;
    this.qrContent = result.content;
    this.qrAt = Date.now();
  }

  stop() {
    this.running = false;
    this.runId += 1;
    this.pollingRunId = 0;
    this.state = 'idle';
    this.message = '未登录';
    this.qrCode = '';
    this.qrContent = '';
    this.qrAt = 0;
    try {
      this.controller?.abort();
    } catch {
      /* ignore */
    }
    this.controller = null;
  }

  submitCode(code) {
    const value = String(code ?? '').trim();
    if (!value) return { ok: false, message: '请输入手机微信上的数字验证码' };
    if (this.state !== 'need_code' && this.state !== 'waiting_code') {
      return { ok: false, message: '当前不需要验证码' };
    }
    this.pendingCode = value;
    this.state = 'waiting_code';
    this.message = '正在验证验证码…';
    this.launchPoll(this.runId);
    return { ok: true, message: '已提交验证码' };
  }

  launchPoll(runId) {
    if (runId !== this.runId || this.pollingRunId === runId) return;
    this.pollingRunId = runId;
    this.poll(runId)
      .catch((error) => {
        if (runId !== this.runId) return;
        this.state = 'error';
        this.message = `登录失败：${error?.message ?? error}`;
        this.running = false;
        this.plugin.log('error', this.message);
      })
      .finally(() => {
        if (this.pollingRunId === runId) this.pollingRunId = 0;
      });
  }

  async poll(runId) {
    let failures = 0;
    while (this.running && runId === this.runId && this.controller && !this.controller.signal.aborted) {
      let status;
      try {
        status = await getQrStatus({
          baseUrl: this.plugin.baseUrl,
          qrcode: this.qrCode,
          verifyCode: this.pendingCode,
          signal: this.controller.signal,
        });
        failures = 0;
      } catch (error) {
        if (runId !== this.runId) return;
        if (this.controller?.signal.aborted) return;
        failures += 1;
        if (failures >= 3) {
          this.state = 'error';
          this.message = `登录轮询失败：${error?.message ?? error}`;
          this.running = false;
          return;
        }
        await sleep(1000 * failures);
        continue;
      }

      const value = status?.status;
      if (value === 'wait') {
        this.state = 'wait';
        this.message = '请用手机微信扫一扫';
      } else if (value === 'scaned') {
        this.state = 'scanned';
        this.message = '已扫码，请在手机上确认登录';
      } else if (value === 'scaned_but_redirect') {
        if (status?.redirect_host) {
          const next = this.plugin.validateBaseUrl(`https://${status.redirect_host}`, this.plugin.baseUrl);
          this.plugin.baseUrl = next;
          this.plugin.log('info', `登录节点切换到 ${status.redirect_host}`);
        }
      } else if (value === 'need_verifycode') {
        this.state = 'need_code';
        this.message = this.pendingCode
          ? '验证码不正确，请重新输入手机微信上显示的数字'
          : '手机微信显示了数字验证码，请在下方输入';
        this.pendingCode = '';
        return;
      } else if (value === 'verify_code_blocked') {
        this.pendingCode = '';
        this.refreshes += 1;
        if (this.refreshes > 3) {
          this.state = 'error';
          this.message = '验证码错误次数过多，请点击“重新登录”';
          this.running = false;
          return;
        }
        await this.refreshQr('验证码错误次数过多，二维码已刷新，请重新扫码');
      } else if (value === 'expired') {
        this.refreshes += 1;
        if (this.refreshes > 3) {
          this.state = 'error';
          this.message = '二维码多次过期，请点击“重新登录”';
          this.running = false;
          return;
        }
        await this.refreshQr('二维码已刷新，请重新扫码');
      } else if (value === 'binded_redirect') {
        if (this.plugin.state.token) {
          this.state = 'connected';
          this.message = '这个微信已经绑定，沿用现有凭据';
          this.running = false;
          this.plugin.startLoop();
          return;
        }
        this.refreshes += 1;
        if (this.refreshes > 3) {
          this.state = 'error';
          this.message = '这个微信已绑定其它机器人，无法获取新凭据';
          this.running = false;
          return;
        }
        await this.refreshQr('该微信已绑定其它机器人，刷新二维码…');
      } else if (value === 'confirmed') {
        const token = status?.bot_token ?? status?.token;
        if (!token) {
          this.state = 'error';
          this.message = '服务端没有返回 bot_token';
          this.running = false;
          return;
        }
        const baseUrl = this.plugin.validateBaseUrl(status?.baseurl || this.plugin.baseUrl, this.plugin.baseUrl);
        await this.plugin.applyCredentials({
          token,
          baseUrl,
          botId: status?.ilink_bot_id ?? '',
          userId: status?.ilink_user_id ?? '',
        });
        this.qrContent = '';
        this.qrAt = 0;
        this.state = 'connected';
        this.message = '登录成功';
        this.running = false;
        this.plugin.log('info', `微信登录成功${this.plugin.state.botId ? `（${this.plugin.state.botId}）` : ''}`);
        return;
      } else {
        this.state = 'wait';
        this.message = '等待扫码…';
      }
    }
  }

  async refreshQr(message) {
    this.message = message;
    await this.loadQr();
    this.pendingCode = '';
    this.state = 'wait';
    this.message = message;
  }
}
