# Changelog

## 0.1.1 — 2026-11-10

### 新增

- 群聊接入（可选）：`groups.mode` 支持 `off` / `all` / `mention`，一个群对应一个 DSH 会话，回复发回群里；支持群白名单、成员白名单与自定义 @ 匹配正则。
- 关键错误告警：登录过期、连续拉取失败、回复发送失败、消息循环崩溃会主动推送微信；同类告警带冷却，登录成功后自动清空。

### 变更

- `index.js` 从 2117 行拆分为入口 + 13 个 `lib/` 模块（config / text / login / panel / approval / questions / attachments / typing / peers / alerts 等），行为保持不变。
- 群聊消息会以 `[群聊 xxx · 成员 xxx]` 前缀交给模型，便于区分发言人。
- `send_weixin_file` 在群里发送到群。

### 测试

- 新增群聊策略与告警单元测试，测试总数 31 项。

## 0.1.0 — 2026-11-09

Initial public release.

### Added

- WeChat iLink QR login with numeric verification code; persistent bot token and automatic reconnect.
- Long-poll `getupdates` message intake with cursor persistence, dedupe, and per-contact serial queues.
- Per-contact DSH sessions with resume, workspace attachment, and `微信·xxxx` titles.
- Text, voice-transcription, image, file, and video intake; DSH attachments and model-capability fallback.
- `send_weixin_file` tool for sending images, videos, and files back to WeChat.
- Tool approval forwarding with `1`/`2` replies and per-contact queues.
- `ask_user_question` forwarding with option, multi-select, and free-text answers.
- Default and per-contact persona, editable from the native drawer or `/persona`.
- Native DSH Web drawer: status badge, QR/code login, contacts, persona editor, re-login/logout.
- Owner-only allowlist by default; `allowedUsers` and `allowAllUsers` overrides.
- Typing indicator, progress notices, message chunking, and rate-limit backoff.
- Unit tests for protocol, media encryption, and upload, plus GitHub Actions CI.
