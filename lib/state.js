/**
 * 插件状态：凭据、游标、微信用户 → DSH 会话映射、最近 context_token。
 * 原子写入；POSIX 上目录 0700、文件 0600。损坏时保留原文件并报错，绝不用空状态覆盖。
 */

import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;

function emptyState() {
  return {
    version: VERSION,
    token: '',
    baseUrl: '',
    botId: '',
    userId: '',
    cursor: '',
    sessionMap: {},
    contextTokens: {},
    personas: {},
    updatedAt: 0,
  };
}

export class StateStore {
  constructor(directory) {
    this.dir = directory;
    this.file = path.join(directory, 'state.json');
    this.data = null;
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  load() {
    this.ensureDir();
    if (!fs.existsSync(this.file)) {
      this.data = emptyState();
      return this.data;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      throw new Error(`微信状态文件损坏，已保留原文件 ${this.file}：${error.message}`);
    }
    const base = emptyState();
    this.data = {
      ...base,
      ...parsed,
      sessionMap: parsed?.sessionMap && typeof parsed.sessionMap === 'object' ? { ...parsed.sessionMap } : {},
      contextTokens: parsed?.contextTokens && typeof parsed.contextTokens === 'object' ? { ...parsed.contextTokens } : {},
      personas: parsed?.personas && typeof parsed.personas === 'object' ? { ...parsed.personas } : {},
    };
    return this.data;
  }

  get() {
    if (!this.data) this.load();
    return this.data;
  }

  update(patch) {
    Object.assign(this.get(), patch, { updatedAt: Date.now() });
    this.save();
  }

  save() {
    this.ensureDir();
    const data = this.get();
    data.updatedAt = Date.now();
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* 非 POSIX 平台忽略 */
    }
  }
}
