# Changelog

## 0.3.0 — 2026-11-11

### 新增

- **内置表情包图库**：8 张自绘鲸鱼表情（开心/点赞/思考/难过/庆祝/抱歉/加油/疑问），随包发布，MIT 授权。
- **Noisy-OR 发送决策**（`lib/sticker-decision.js`）：
  - 特征归一化后按 `P_raw = 1 − (1 − p₀) · Π(1 − p_i)` 合成；
  - 已带图片作为抑制特征（因子 0.3），再 `clamp(P_raw · s, pMin, pMax)`；
  - 三层后处理：冷却时间、连续触发惩罚 `α^m`、全局触发率控制（滑动窗口 + 目标 15%）；
  - 随机源可注入、种子可配置，同输入同种子结果可复现。
- **`weixin_sticker` 工具**：用户明确要求时显式发表情，跳过错率，仍受开关与冷却约束。
- 表情以图片消息发送（iLink 无贴纸类型），模型全程看不到图片字节。

### 变更

- 每轮回复结束后自动评估是否附带表情；决策日志输出 `P`、`r`、是否发送与情绪标签。
- `weixin_status` 增加 `stickers` 字段（可用表情数量）。

### 修复

- 从未发送过表情时（`lastSentAt = 0`）误判为冷却中，导致概率恒为 0。

### 测试

- 新增决策模型 15 项、图库 7 项测试，总数 77 项。

## 0.2.3 — 2026-11-10

### 修复

- 面板「重新登录 / 重新生成二维码」返回 HTTP 400：0.1.1 拆分模块时 `handleLogin` 仍调用已重命名的 `cancelAllApprovals` / `cancelAllQuestions`，异常被 HTTP 层转成 400。现已改为调用 `approvals.cancelAll()` / `questions.cancelAll()`。
- 面板路由增加错误兜底：处理函数抛错时返回 500 并记录日志，不再静默变成 400。

### 测试

- 新增面板路由回归测试 5 项，总数 55 项。

## 0.2.2 — 2026-11-10

### 新增

- 内置默认人设「大鲸鱼」：安装后开箱即有角色与语气，不需要额外配置。
- `personaEnabled: false` 可关闭内置人设，回到中性的助手语气。

### 变更

- `config.persona` 为空时使用内置人设；显式配置仍然优先。
- 面板人设输入框的占位文案改为说明内置人设。

### 测试

- 新增配置默认值测试 4 项，总数 50 项。

### 文档

- README 补充桌面版安装命令（`--profile desktop`）与安装包自带 CLI 路径。
- 要求一节说明同时支持 DSH Web 端与桌面版。

## 0.2.1 — 2026-11-10

### 修复

- `weixin_login` 在不渲染工具图片的界面（如部分桌面端）上无法扫码：现在除返回图片附件外，还会把二维码写到 `$DSH_HOME/weixin-ilink/login-qr.gif`，并在结果里给出 `qrPath`，可直接打开文件扫码。

## 0.2.0 — 2026-11-10

### 新增

- 跨端支持：`webServer` 不再是硬依赖。宿主没有 HTTP 服务（例如桌面端）时，通道照常收发消息，只是跳过本地网页面板。
- 四个控制工具，任何 DSH 界面都能用：
  - `weixin_login`：生成登录二维码并以图片返回，手机扫码即可
  - `weixin_verify`：提交手机上的数字验证码
  - `weixin_status`：连接、会话、审批/提问、群聊与告警状态
  - `weixin_logout`：退出登录

### 变更

- `inject` 从 `['agents','sessions','webServer','tools']` 改为 `['agents','sessions','tools']`；面板路由改用可选注入。
- Web 端行为不变：有 `webServer` 时仍注册 `/weixin/*` 面板。

### 测试

- 新增控制工具测试 7 项，总数 46 项。

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
