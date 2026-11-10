/**
 * 关键错误主动告警：登录过期、收发失败、轮询崩溃、审批/提问异常。
 *
 * 设计要点：
 * - 只推给「主人」(`state.userId`) 和 `alerts.toUsers` 里明确列出的人；
 * - 同一类错误在 `alerts.throttleMs` 内只推一次，避免刷屏；
 * - 告警发送自身失败只写日志，绝不递归告警。
 *
 * @module dsh-wx-ilink/alerts
 */

const SEVERITY = {
  error: '⚠️',
  warn: '⚡',
};

export class AlertCenter {
  constructor(plugin) {
    this.plugin = plugin;
    this.lastSent = new Map();
    this.sending = false;
    this.queue = [];
  }

  get enabled() {
    const config = this.plugin.config.alerts;
    return config?.enabled !== false;
  }

  recipients() {
    const plugin = this.plugin;
    const config = plugin.config.alerts;
    const list = new Set();
    if (config?.includeOwner !== false && plugin.state?.userId) list.add(plugin.state.userId);
    for (const user of config?.toUsers ?? []) {
      const value = String(user ?? '').trim();
      if (value) list.add(value);
    }
    return [...list];
  }

  /**
   * 记录并推送一条告警。
   * @param {string} kind - 去重键，例如 `session-expired`、`send-failed`。
   * @param {string} message - 人类可读内容。
   * @param {'error'|'warn'} [level]
   * @returns {boolean} 是否真的入队发送。
   */
  alert(kind, message, level = 'error') {
    if (!this.enabled) return false;
    const plugin = this.plugin;
    const throttle = plugin.config.alerts?.throttleMs ?? 300_000;
    const now = Date.now();
    const last = this.lastSent.get(kind) ?? 0;
    if (now - last < throttle) {
      plugin.log('info', `告警「${kind}」在冷却期内，跳过：${message}`);
      return false;
    }
    if (!plugin.state?.token) {
      plugin.log('warn', `告警无法发送（未登录）：${message}`);
      return false;
    }
    const targets = this.recipients();
    if (targets.length === 0) {
      plugin.log('info', `没有告警接收人，只记日志：${message}`);
      return false;
    }
    this.lastSent.set(kind, now);
    const icon = SEVERITY[level] ?? SEVERITY.error;
    const text = `${icon} DSH 微信通道告警\n${message}\n时间：${new Date().toISOString()}`;
    for (const peer of targets) this.queue.push({ peer, text });
    plugin.log('warn', `告警「${kind}」→ ${targets.length} 个接收人：${message}`);
    this.drain();
    return true;
  }

  /** 串行发送，避免并发打爆限流；自身失败只记日志。 */
  async drain() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        try {
          await this.plugin.deliver(job.peer, job.text, this.plugin.state.contextTokens?.[job.peer] || '');
        } catch (error) {
          this.plugin.log('warn', `告警发送失败（${job.peer.slice(0, 12)}…）：${error?.message ?? error}`);
        }
      }
    } finally {
      this.sending = false;
    }
  }

  reset(kind) {
    if (kind) this.lastSent.delete(kind);
    else this.lastSent.clear();
  }
}
