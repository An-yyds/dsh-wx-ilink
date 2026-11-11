/**
 * 表情包图库：内置图库 + 用户自定义目录，按情绪合并。
 *
 * 只索引元数据，图片字节仅在发送时读取；模型永远看不到图片内容。
 *
 * 用户目录约定（默认为 `$stateDir/stickers`）：
 * - 文件名即情绪：`happy.png` → `happy`，`celebrate.gif` → `celebrate`；
 * - 支持 png / jpg / jpeg / gif / webp；
 * - 可选的 `index.json` 用来补充中文标签与关键词，格式同内置索引；
 * - 同名情绪覆盖内置图，`includeBuiltin: false` 时只用用户图库。
 *
 * @module dsh-wx-ilink/stickers
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMediaItem, sendItems, uploadMedia } from './ilink.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = path.join(here, '..', 'stickers');

/** 兜底情绪：索引里找不到时用它。 */
const FALLBACK_MOOD = 'happy';

/** 允许的表情图片扩展名。 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** 单张表情的告警阈值，超过只提示不建议拒绝。 */
const LARGE_FILE_BYTES = 512 * 1024;

/** 从文件名解析情绪：`thumbs-up.png` → `thumbs-up`。 */
function moodFromFile(name) {
  const extension = path.extname(name).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) return undefined;
  const base = path.basename(name, extension).trim();
  return base || undefined;
}

function readIndex(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export class StickerLibrary {
  constructor(plugin) {
    this.plugin = plugin;
    this.builtinDir = BUILTIN_DIR;
    this.index = null;
  }

  /** 用户自定义图库目录；未配置时用状态目录下的 `stickers`。 */
  get userDir() {
    const config = this.plugin.config.stickers ?? {};
    const raw = String(config.dir ?? '').trim();
    if (!raw) return path.join(this.plugin.stateDir, 'stickers');
    if (raw === '~') return os.homedir();
    if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
    return path.resolve(this.plugin.stateDir, raw);
  }

  get includeBuiltin() {
    return this.plugin.config.stickers?.includeBuiltin !== false;
  }

  /** 扫描一个目录，返回 { mood: entry }。 */
  scanDir(dir, source) {
    const result = {};
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return result;
    }
    const meta = readIndex(dir);
    for (const name of names) {
      const mood = moodFromFile(name);
      if (!mood) continue;
      const file = path.join(dir, name);
      try {
        if (!fs.statSync(file).isFile()) continue;
      } catch {
        continue;
      }
      const extra = meta[mood] ?? {};
      result[mood] = {
        mood,
        file: name,
        dir,
        source,
        label: typeof extra.label === 'string' && extra.label ? extra.label : mood,
        keywords: Array.isArray(extra.keywords) ? extra.keywords.filter((word) => typeof word === 'string') : [],
      };
    }
    return result;
  }

  /** 合并内置与用户图库；用户同名情绪覆盖内置。 */
  load() {
    if (this.index) return this.index;
    const merged = {};
    if (this.includeBuiltin) Object.assign(merged, this.scanDir(this.builtinDir, 'builtin'));
    const userEntries = this.scanDir(this.userDir, 'user');
    const overridden = Object.keys(userEntries).filter((mood) => merged[mood]);
    if (overridden.length) {
      this.plugin.log('info', `用户表情覆盖内置：${overridden.join(', ')}`);
    }
    Object.assign(merged, userEntries);
    const large = Object.values(merged).filter((entry) => {
      try {
        return fs.statSync(path.join(entry.dir, entry.file)).size > LARGE_FILE_BYTES;
      } catch {
        return false;
      }
    });
    if (large.length) {
      this.plugin.log('warn', `以下表情超过 512KB，建议压缩：${large.map((entry) => entry.file).join(', ')}`);
    }
    this.index = merged;
    return this.index;
  }

  /** 重新扫描（用户新增图片后无需重启插件）。 */
  reload() {
    this.index = null;
    return this.load();
  }

  get size() {
    return Object.keys(this.load()).length;
  }

  /** 元数据列表，供工具与状态展示；不含图片字节。 */
  list() {
    return Object.values(this.load()).map(({ mood, label, keywords, source }) => ({ mood, label, keywords, source }));
  }

  /** 所有可用情绪名。 */
  moods() {
    return Object.keys(this.load());
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
    const lowered = String(mood ?? '').toLowerCase();
    for (const key of Object.keys(index)) {
      if (key.toLowerCase() === lowered) return index[key];
    }
    const source = String(text ?? '');
    for (const entry of Object.values(index)) {
      if (entry.keywords.some((word) => word && source.includes(word))) return entry;
    }
    return index[FALLBACK_MOOD] ?? Object.values(index)[0];
  }

  /** 读取某条表情的图片字节（只在发送时调用）。 */
  read(mood, text) {
    const entry = this.resolve(mood, text);
    if (!entry) throw new Error('表情图库为空');
    return { entry, bytes: fs.readFileSync(path.join(entry.dir, entry.file)) };
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
    if (bytes.length > plugin.config.maxMediaBytes) {
      throw new Error(`表情「${entry.file}」超过 ${Math.round(plugin.config.maxMediaBytes / 1024 / 1024)}MB 上限`);
    }
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
    plugin.log('info', `已向 ${plugin.peers.label(peer)} 发送表情「${entry.label}」（${entry.file}，${bytes.length} 字节）`);
    return { mood: entry.mood, label: entry.label, file: entry.file, bytes: bytes.length };
  }
}