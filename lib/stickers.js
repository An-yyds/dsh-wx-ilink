/**
 * 内置表情包图库：只索引元数据，图片字节仅在发送时读取。
 *
 * 设计约束：模型永远看不到图片内容，工具只返回 mood / 文件名 / 字节数，
 * 避免把二进制塞进上下文。
 *
 * @module dsh-wx-ilink/stickers
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMediaItem, sendItems, uploadMedia } from './ilink.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const STICKER_DIR = path.join(here, '..', 'stickers');

/** 兜底情绪：索引里找不到时用它。 */
const FALLBACK_MOOD = 'happy';

export class StickerLibrary {
  constructor(plugin) {
    this.plugin = plugin;
    this.dir = STICKER_DIR;
    this.index = null;
  }

  /** 读取 `stickers/index.json`；失败时返回空库并记日志。 */
  load() {
    if (this.index) return this.index;
    try {
      const raw = fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8');
      const parsed = JSON.parse(raw);
      const index = {};
      for (const [mood, entry] of Object.entries(parsed ?? {})) {
        if (!entry?.file) continue;
        if (!fs.existsSync(path.join(this.dir, entry.file))) continue;
        index[mood] = {
          mood,
          file: entry.file,
          label: entry.label ?? mood,
          keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
        };
      }
      this.index = index;
      return index;
    } catch (error) {
      this.plugin.log('warn', `表情图库加载失败：${error?.message ?? error}`);
      this.index = {};
      return this.index;
    }
  }

  get size() {
    return Object.keys(this.load()).length;
  }

  /** 元数据列表，供工具与状态展示；不含图片字节。 */
  list() {
    return Object.values(this.load()).map(({ mood, label, keywords }) => ({ mood, label, keywords }));
  }

  /**
   * 把情绪解析成图库里的条目：精确匹配 → 关键词匹配 → 兜底。
   * @param {string} mood - 决策模型给出的情绪标签。
   * @param {string} [text] - 回复正文，用于关键词兜底。
   * @returns {object|undefined} 图库条目。
   */
  resolve(mood, text) {
    const index = this.load();
    if (mood && index[mood]) return index[mood];
    const source = String(text ?? '');
    for (const entry of Object.values(index)) {
      if (entry.keywords.some((word) => word && source.includes(word))) return entry;
    }
    return index[FALLBACK_MOOD] ?? Object.values(index)[0];
  }

  /** 读取某条表情的 PNG 字节（只在发送时调用）。 */
  read(mood, text) {
    const entry = this.resolve(mood, text);
    if (!entry) throw new Error('表情图库为空');
    const file = path.join(this.dir, entry.file);
    return { entry, bytes: fs.readFileSync(file) };
  }

  /**
   * 发送一张表情到微信会话。
   * @param {string} peer - 会话主体（联系人 id 或 group:xxx）。
   * @param {string} mood - 情绪标签。
   * @param {object} options - contextToken / signal / text。
   * @returns {Promise<object>} 发送结果（不含图片内容）。
   */
  async send(peer, mood, { contextToken, signal, text } = {}) {
    const plugin = this.plugin;
    if (!plugin.state?.token) throw new Error('微信尚未登录');
    const { entry, bytes } = this.read(mood, text);
    const target = plugin.peers.sendTarget(peer);
    const uploaded = await uploadMedia({
      baseUrl: plugin.baseUrl,
      token: plugin.state.token,
      to: target,
      data: bytes,
      mediaType: 1,
      botAgent: plugin.config.botAgent,
      signal,
    });
    await sendItems({
      baseUrl: plugin.baseUrl,
      token: plugin.state.token,
      to: target,
      items: [buildMediaItem('image', uploaded, entry.file)],
      contextToken: contextToken || plugin.state.contextTokens?.[peer] || '',
      botAgent: plugin.config.botAgent,
      signal,
    });
    plugin.log('info', `已向 ${plugin.peers.label(peer)} 发送表情「${entry.label}」（${bytes.length} 字节）`);
    return { mood: entry.mood, label: entry.label, file: entry.file, bytes: bytes.length };
  }
}