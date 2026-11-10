/**
 * 入站消息 → 会话主体（peer）解析，包含群聊策略。
 *
 * peer 键约定（保持向后兼容）：
 * - 单聊：`<from_user_id>@im.wechat`，与 0.1.0 相同，历史 sessionMap 可直接复用；
 * - 群聊：`group:<group_id>`，一个群一个 DSH 会话。
 *
 * @module dsh-wx-ilink/peers
 */

export const GROUP_PREFIX = 'group:';

export function isGroupMessage(message) {
  return Boolean(message?.group_id);
}

export function groupKey(groupId) {
  return `${GROUP_PREFIX}${groupId}`;
}

export function isGroupKey(key) {
  return typeof key === 'string' && key.startsWith(GROUP_PREFIX);
}

/** 取 id 的本地部分末 4 位，用于显示。 */
export function tailOf(id, size = 4) {
  const local = String(id ?? '').split('@')[0];
  return local.slice(-size);
}

export class PeerRouter {
  constructor(plugin) {
    this.plugin = plugin;
    this.announced = new Set();
  }

  get config() {
    return this.plugin.config.groups;
  }

  /** 群聊是否启用。 */
  get groupsEnabled() {
    return this.config?.mode && this.config.mode !== 'off';
  }

  /** 该群是否在白名单内；`allowedGroups` 为空表示全部允许。 */
  isGroupAllowed(groupId) {
    const list = this.config?.allowedGroups ?? [];
    if (list.length === 0) return true;
    return list.includes(groupId);
  }

  /**
   * 群聊里是否提到了机器人。
   * iLink 不下发机器人昵称，默认用 “文本里出现 @” 判断；可用 `mentionPattern` 覆盖。
   */
  isMentioned(text) {
    const pattern = this.config?.mentionPattern;
    if (!pattern) return String(text ?? '').includes('@');
    try {
      return new RegExp(pattern, 'i').test(String(text ?? ''));
    } catch {
      return String(text ?? '').includes('@');
    }
  }

  /**
   * 把一条入站消息解析成会话主体。
   * @param {object} message - iLink 原始消息。
   * @param {string} text - 已提取的文本。
   * @returns {{ignored?: string, key?: string, kind?: 'dm'|'group', sendTo?: string,
   *   sender?: string, groupId?: string, senderTail?: string, groupTail?: string}}
   */
  resolve(message, text) {
    const from = String(message?.from_user_id ?? '').trim();
    if (!from) return { ignored: 'no-sender' };
    if (!isGroupMessage(message)) {
      return {
        key: from,
        kind: 'dm',
        sendTo: from,
        sender: from,
        senderTail: tailOf(from),
      };
    }

    const groupId = String(message.group_id).trim();
    if (!this.groupsEnabled) return { ignored: 'group-disabled' };
    if (!this.isGroupAllowed(groupId)) {
      this.announceOnce(groupId, 'unauthorized',
        `这个群还没有授权使用 DSH。\n群 ID：${groupId}\n管理员把它加入 groups.allowedGroups 后即可使用。`,
        message.context_token);
      return { ignored: 'group-not-allowed' };
    }
    if (this.config.mode === 'mention' && !this.isMentioned(text)) {
      return { ignored: 'not-mentioned' };
    }
    return {
      key: groupKey(groupId),
      kind: 'group',
      sendTo: groupId,
      sender: from,
      senderTail: tailOf(from),
      groupId,
      groupTail: tailOf(groupId),
    };
  }

  /** 未授权群只提示一次，避免刷屏。 */
  announceOnce(groupId, kind, text, contextToken) {
    const key = `${groupId}:${kind}`;
    if (this.announced.has(key)) return;
    this.announced.add(key);
    const sendTo = groupId;
    this.plugin.deliver(sendTo, text, contextToken).catch(() => {});
  }

  /** 显示名：单聊用 id 末位，群聊用群 id 末位。 */
  label(key) {
    if (isGroupKey(key)) return `微信群 ${tailOf(key.slice(GROUP_PREFIX.length))}`;
    return `微信用户 ${tailOf(key)}`;
  }

  /** 会话标题后缀。 */
  titleSuffix(key) {
    if (isGroupKey(key)) return `群${tailOf(key.slice(GROUP_PREFIX.length))}`;
    return tailOf(key) || '会话';
  }

  /** 实际发送目标：群聊发到群 id，单聊发到联系人 id。 */
  sendTarget(key) {
    return isGroupKey(key) ? key.slice(GROUP_PREFIX.length) : key;
  }
}
