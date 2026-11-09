# Changelog

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
