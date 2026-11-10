/**
 * “正在输入”状态与长任务进度提示。
 * @module dsh-wx-ilink/typing
 */

import { getConfig, sendTyping } from './ilink.js';

export class TypingCenter {
  constructor(plugin) {
    this.plugin = plugin;
    this.tickets = new Map();
    this.generations = new Map();
  }

  async ticket(peer, contextToken) {
    if (this.tickets.has(peer)) return this.tickets.get(peer);
    const plugin = this.plugin;
    const response = await getConfig({
      baseUrl: plugin.baseUrl,
      token: plugin.state.token,
      ilinkUserId: peer,
      contextToken,
      botAgent: plugin.config.botAgent,
    });
    const ticket = response?.typing_ticket ?? '';
    this.tickets.set(peer, ticket);
    return ticket;
  }

  start(peer, contextToken) {
    const plugin = this.plugin;
    if (!plugin.config.typing || !plugin.state.token) return;
    const generation = (this.generations.get(peer) ?? 0) + 1;
    this.generations.set(peer, generation);
    this.ticket(peer, contextToken)
      .then((ticket) => {
        if (!ticket || this.generations.get(peer) !== generation) return;
        return sendTyping({
          baseUrl: plugin.baseUrl,
          token: plugin.state.token,
          to: peer,
          typingTicket: ticket,
          status: 1,
          botAgent: plugin.config.botAgent,
        });
      })
      .catch(() => {});
  }

  stop(peer) {
    const plugin = this.plugin;
    if (!plugin.config.typing) return;
    const generation = (this.generations.get(peer) ?? 0) + 1;
    this.generations.set(peer, generation);
    const ticket = this.tickets.get(peer);
    if (!ticket || !plugin.state.token) return;
    sendTyping({
      baseUrl: plugin.baseUrl,
      token: plugin.state.token,
      to: peer,
      typingTicket: ticket,
      status: 2,
      botAgent: plugin.config.botAgent,
    }).catch(() => {});
  }

  clear() {
    this.tickets.clear();
  }

  /** 长任务阶段性提示；返回一个幂等的 stop()。 */
  progress(peer, contextToken) {
    const plugin = this.plugin;
    const { progressAfterMs, progressEveryMs, maxProgressMessages } = plugin.config;
    if (progressAfterMs <= 0 || maxProgressMessages <= 0) return () => {};
    let stopped = false;
    let count = 0;
    let interval;
    const startedAt = Date.now();
    const send = () => {
      if (stopped || count >= maxProgressMessages) return;
      count += 1;
      const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
      plugin.reply(peer, `还在处理，已用时约 ${minutes} 分钟…`, contextToken).catch(() => {});
    };
    const timer = setTimeout(() => {
      send();
      interval = setInterval(send, progressEveryMs);
    }, progressAfterMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (interval) clearInterval(interval);
    };
  }
}
