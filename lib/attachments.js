/**
 * 微信媒体 → DSH 内容块：下载、解密、存附件、按模型能力降级。
 * @module dsh-wx-ilink/attachments
 */

import {
  MediaTooLargeError,
  describeMedia,
  fetchMedia,
  sniffImageMime,
} from './media.js';
import { sanitizeMediaName } from './text.js';

export class AttachmentPipeline {
  constructor(plugin) {
    this.plugin = plugin;
    this.visionCache = new Map();
  }

  /** 入站消息里的可下载媒体描述。 */
  describeInbound(message) {
    try {
      return describeMedia(message);
    } catch {
      return [];
    }
  }

  effectiveModel(agent) {
    const options = agent?.options ?? {};
    let selection = {};
    try {
      selection = this.plugin.ctx.get?.('agentDefaultModel')?.currentSelection?.() ?? {};
    } catch {
      selection = {};
    }
    return {
      provider: options.provider || selection.provider || '',
      model: options.model || selection.model || '',
    };
  }

  async supportsVision(agent) {
    try {
      const llm = this.plugin.ctx.get?.('llm');
      if (!llm?.resolveModelInfo) return false;
      const { provider, model } = this.effectiveModel(agent);
      if (!provider || !model) return false;
      const key = `${provider}:${model}`;
      if (this.visionCache.has(key)) return this.visionCache.get(key);
      const info = await llm.resolveModelInfo(provider, model);
      const supported = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image');
      this.visionCache.set(key, supported);
      return supported;
    } catch {
      return false;
    }
  }

  /** 下载微信媒体并转成 DSH 内容块；失败降级为文字提示，不中断整轮。 */
  async buildParts(peer, refs, agent) {
    const parts = [];
    const notes = [];
    if (!Array.isArray(refs) || refs.length === 0) return { parts, notes, label: '' };
    const plugin = this.plugin;
    const attachments = plugin.ctx.get?.('attachments') ?? plugin.ctx.attachments;
    const vision = await this.supportsVision(agent);
    const imageLimit = attachments?.imageLimits?.maxImageBytes || plugin.config.maxMediaBytes;
    const kinds = new Set(refs.map((ref) => ref.kind));
    const label = kinds.size === 1
      ? ({ image: '图片', file: '文件', video: '视频' }[[...kinds][0]] ?? '媒体文件')
      : '媒体文件';

    for (const [index, ref] of refs.slice(0, 8).entries()) {
      const kindLabel = { image: '图片', file: '文件', video: '视频' }[ref.kind] ?? '文件';
      const limit = ref.kind === 'image'
        ? Math.max(1, Math.min(plugin.config.maxMediaBytes, imageLimit))
        : plugin.config.maxMediaBytes;
      if (!attachments?.saveFile) {
        parts.push({ type: 'text', text: `[${kindLabel}无法保存：DSH 附件服务不可用]` });
        continue;
      }
      if (ref.size && ref.size > limit + 16) {
        parts.push({ type: 'text', text: `[${kindLabel}超过 ${Math.round(limit / 1024 / 1024)}MB，未接收]` });
        continue;
      }
      try {
        const bytes = await fetchMedia(ref.media, { maxBytes: limit });
        if (ref.kind === 'image' && vision && attachments.saveImage) {
          const attachment = await attachments.saveImage({
            data: bytes,
            mediaType: sniffImageMime(bytes),
            name: `weixin-image-${Date.now()}-${index}`,
          });
          parts.push({ type: 'image', attachment });
        } else {
          const extension = ref.kind === 'image'
            ? `.${sniffImageMime(bytes).split('/')[1].replace('jpeg', 'jpg')}`
            : '';
          const name = sanitizeMediaName(ref.name || `weixin-${ref.kind}-${Date.now()}${extension}`);
          const attachment = await attachments.saveFile({ data: bytes, name });
          parts.push({ type: 'file', attachment });
          if (ref.kind === 'image') notes.push(`当前模型不支持看图，图片已保存为文件附件「${name}」。`);
          if (ref.kind === 'video') notes.push(`视频已保存为文件附件「${name}」，当前模型不能直接播放视频。`);
        }
      } catch (error) {
        if (error instanceof MediaTooLargeError) {
          parts.push({ type: 'text', text: `[${kindLabel}超过大小上限，未接收]` });
        } else {
          plugin.log('warn', `${kindLabel}接收失败：${error?.message ?? error}`);
          parts.push({ type: 'text', text: `[${kindLabel}接收失败]` });
        }
      }
    }
    if (refs.length > 8) notes.push(`一次最多接收 8 个媒体，其余 ${refs.length - 8} 个已忽略。`);
    return { parts, notes, label };
  }
}
