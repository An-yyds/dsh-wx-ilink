/**
 * 工具审批 → 微信 1/2 回复（同一联系人排队，超时按拒绝）。
 * @module dsh-wx-ilink/approval
 */

export class ApprovalCenter {
  constructor(plugin) {
    this.plugin = plugin;
    this.pending = new Map();
    this.seq = 0;
  }

  get size() {
    let count = 0;
    for (const list of this.pending.values()) count += list.length;
    return count;
  }

  has(peer) {
    return this.pending.has(peer);
  }

  async forwardApproval(request, explicitPeer) {
    const peer = explicitPeer
      ?? Object.keys(this.plugin.state.sessionMap).find((key) => this.plugin.state.sessionMap[key] === request?.agent?.id);
    if (!peer || !this.plugin.state.token) return 'unavailable';
    if (request.signal?.aborted) return 'cancelled';

    const contextToken = this.plugin.state.contextTokens[peer] || '';
    const id = (this.seq += 1);
    const prompt = [
      `需要你授权（#${id}）`,
      `工具：${request.toolName}`,
      request.reason ? `原因：${request.reason}` : '',
      `回复 1 允许一次，回复 2 拒绝；${Math.max(1, Math.round(this.plugin.config.approvalTimeoutMs / 1000))} 秒内有效。`,
    ].filter(Boolean).join('\n');

    return new Promise((resolve) => {
      const record = {
        id,
        toolName: request.toolName,
        prompt,
        contextToken,
        signal: request.signal,
        timer: null,
        onAbort: null,
        started: false,
        done: false,
        resolve,
        finish: null,
      };
      record.finish = (outcome) => {
        if (record.done) return;
        record.done = true;
        clearTimeout(record.timer);
        if (record.onAbort) record.signal?.removeEventListener?.('abort', record.onAbort);
        const list = this.pending.get(peer);
        const index = list ? list.indexOf(record) : -1;
        if (index >= 0) list.splice(index, 1);
        if (!list || list.length === 0) this.pending.delete(peer);
        else queueMicrotask(() => this.startApproval(peer, list[0]));
        resolve(outcome);
      };
      record.onAbort = () => record.finish('cancelled');
      request.signal?.addEventListener?.('abort', record.onAbort, { once: true });

      const list = this.pending.get(peer) ?? [];
      list.push(record);
      this.pending.set(peer, list);
      if (list.length === 1) this.startApproval(peer, record);
      else this.plugin.log('info', `审批 #${id} 已排队，前面还有 ${list.length - 1} 条`);
    });
  }

  async startApproval(peer, record) {
    if (!record || record.done || record.started) return;
    record.started = true;
    record.timer = setTimeout(() => {
      this.plugin.reply(peer, `审批 #${record.id} 超时，已按拒绝处理。`, record.contextToken).catch(() => {});
      record.finish('unavailable');
    }, this.plugin.config.approvalTimeoutMs);
    this.plugin.log('info', `等待 ${peer.slice(0, 12)} 审批 #${record.id}：${record.toolName}`);
    this.plugin.reply(peer, record.prompt, record.contextToken).catch(() => record.finish('unavailable'));
  }

  /** 处理微信里的 1/2 审批回复；返回是否命中。 */
  resolveApproval(peer, text) {
    const record = this.pending.get(peer)?.[0];
    if (!record?.finish) return false;
    const raw = String(text ?? '').trim().toLowerCase();
    const first = raw.split(/\s+/)[0];
    const yes = new Set(['1', 'y', 'yes', '允许', '同意', '批准', '可以', '好']);
    const no = new Set(['2', 'n', 'no', '拒绝', '不同意', '取消', '不行']);
    const allowed = yes.has(raw) || yes.has(first);
    const denied = no.has(raw) || no.has(first);
    if (!allowed && !denied) return false;
    record.finish(allowed ? 'allowed-once' : 'rejected');
    this.plugin.reply(peer, allowed ? `已允许 #${record.id}，继续执行。` : `已拒绝 #${record.id}。`, this.plugin.state.contextTokens[peer] || '').catch(() => {});
    return true;
  }

  cancelApproval(peer, outcome = 'cancelled') {
    const list = [...(this.pending.get(peer) ?? [])];
    for (const record of list) record.finish?.(outcome);
  }

  cancelAll(outcome = 'cancelled') {
    for (const peer of [...this.pending.keys()]) this.cancelApproval(peer, outcome);
  }
}
