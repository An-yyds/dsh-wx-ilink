/**
 * ask_user_question → 微信逐题问答（同一联系人的请求排队）。
 * @module dsh-wx-ilink/questions
 */

export class QuestionCenter {
  constructor(plugin) {
    this.plugin = plugin;
    this.queues = new Map();
    this.active = new Map();
  }

  get size() {
    return this.active.size;
  }

  has(peer) {
    return this.active.has(peer);
  }

  /** 把 ask_user_question 的请求转发到微信，逐题收集答案。 */
  forwardQuestion(request, peer) {
    if (!this.plugin.state.token) return Promise.reject(new Error('微信尚未登录'));
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(peer) ?? [];
      queue.push({ request, resolve, reject });
      this.queues.set(peer, queue);
      if (queue.length === 1) this.startQuestion(peer);
      else this.plugin.log('info', `提问已排队，前面还有 ${queue.length - 1} 个请求`);
    });
  }

  startQuestion(peer) {
    if (this.active.has(peer)) return;
    const queue = this.queues.get(peer);
    const entry = queue?.[0];
    if (!entry) {
      this.queues.delete(peer);
      return;
    }
    const questions = Array.isArray(entry.request?.questions) ? entry.request.questions : [];
    if (questions.length === 0) {
      queue.shift();
      entry.resolve({ answers: [] });
      if (queue.length) this.startQuestion(peer);
      else this.queues.delete(peer);
      return;
    }
    const record = {
      entry,
      questions,
      index: 0,
      answers: [],
      current: null,
      timer: null,
      signal: entry.request?.signal,
      onAbort: null,
      done: false,
    };
    record.onAbort = () => this.finishQuestion(peer, 'cancelled');
    this.active.set(peer, record);
    if (record.signal?.aborted) {
      this.finishQuestion(peer, 'cancelled');
      return;
    }
    record.signal?.addEventListener?.('abort', record.onAbort, { once: true });
    this.askNextQuestion(peer);
  }

  askNextQuestion(peer) {
    const record = this.active.get(peer);
    if (!record) return;
    if (record.index >= record.questions.length) {
      this.finishQuestion(peer, 'answered');
      return;
    }
    const question = record.questions[record.index];
    record.current = question;
    const options = Array.isArray(question.options) ? question.options : [];
    const lines = [
      `问题 ${record.index + 1}/${record.questions.length}${question.header ? ` · ${question.header}` : ''}`,
      question.question,
    ];
    if (question.detail) lines.push('', question.detail);
    if (options.length) {
      lines.push('', ...options.map((option, index) => `${index + 1}) ${option.label}${option.description ? ` — ${option.description}` : ''}`));
      lines.push(question.multiSelect ? '回复编号（可多选，用逗号分隔），或直接输入文字。' : '回复编号，或直接输入文字。');
    } else {
      lines.push('', '直接回复文字。');
    }
    this.plugin.reply(peer, lines.join('\n'), this.plugin.state.contextTokens[peer] || '').catch(() => {});
    record.timer = setTimeout(() => {
      this.plugin.reply(peer, '问题超时未回答，已取消。', this.plugin.state.contextTokens[peer] || '').catch(() => {});
      this.finishQuestion(peer, 'timeout');
    }, this.plugin.config.questionTimeoutMs);
  }

  resolveQuestion(peer, text) {
    const record = this.active.get(peer);
    const question = record?.current;
    if (!record || !question) return false;
    clearTimeout(record.timer);
    record.timer = null;
    const raw = String(text ?? '').trim();
    const options = Array.isArray(question.options) ? question.options : [];
    let selected = [];
    let custom;
    const numbers = raw.split(/[,，\s]+/).map((part) => Number(part)).filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length);
    if (options.length && numbers.length && (question.multiSelect || numbers.length === 1)) {
      selected = [...new Set(numbers.map((n) => options[n - 1].label))];
    } else if (options.length && options.some((option) => option.label === raw)) {
      selected = [raw];
    } else {
      custom = raw;
    }
    const answer = { id: question.id, selected };
    if (custom !== undefined) answer.custom = custom;
    record.answers.push(answer);
    record.index += 1;
    record.current = null;
    this.plugin.reply(peer, `已记录（${record.index}/${record.questions.length}）。`, this.plugin.state.contextTokens[peer] || '').catch(() => {});
    this.askNextQuestion(peer);
    return true;
  }

  finishQuestion(peer, outcome) {
    const record = this.active.get(peer);
    if (!record || record.done) return;
    record.done = true;
    clearTimeout(record.timer);
    if (record.onAbort) record.signal?.removeEventListener?.('abort', record.onAbort);
    this.active.delete(peer);
    const queue = this.queues.get(peer);
    const entry = queue?.[0];
    if (!entry) return;
    queue.shift();
    if (outcome === 'answered') entry.resolve({ answers: record.answers });
    else entry.reject(new Error(outcome === 'timeout' ? '微信未在时限内回答问题' : '用户问题已取消'));
    if (queue.length) this.startQuestion(peer);
    else this.queues.delete(peer);
  }

  cancelQuestion(peer) {
    this.finishQuestion(peer, 'cancelled');
  }

  cancelAll() {
    for (const peer of [...this.active.keys()]) this.finishQuestion(peer, 'cancelled');
    this.queues.clear();
  }
}
