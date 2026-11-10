# dsh-wx-ilink

[![npm](https://img.shields.io/npm/v/dsh-wx-ilink)](https://www.npmjs.com/package/dsh-wx-ilink)
[![CI](https://github.com/An-yyds/dsh-wx-ilink/actions/workflows/ci.yml/badge.svg)](https://github.com/An-yyds/dsh-wx-ilink/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-wx-ilink)](LICENSE)

当前版本：**0.2.1** · [更新记录](#版本更新) · [CHANGELOG](CHANGELOG.md)

把 **个人微信** 接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立插件：手机微信扫码登录后，微信消息进入独立的 DSH 会话；Agent 处理完，把结果发回微信。

> 仓库：<https://github.com/An-yyds/dsh-wx-ilink> · 这是一个第三方开源项目，不是腾讯官方产品。协议参考腾讯官方 [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)（MIT）所描述的 iLink Bot 接口；代码为独立实现。使用前请确认你的微信账号具备 iLink 入口，并自行评估账号与合规风险。

## 功能

- 手机微信扫码登录，支持手机上的数字验证码；凭据本地保存，重启后自动重连
- 长轮询收消息，不需要公网 IP、域名、回调地址或消息加解密
- 每个微信联系人一个独立 DSH 会话；重启后用 `agents.resume()` 接上
- 收文字、图片、文件、视频；语音使用微信服务端转写文字
- Agent 可通过 `send_weixin_file` 把图片、视频或文件发回微信
- 工具审批转发到微信：回复 `1` 允许一次、`2` 拒绝；多条审批排队
- `ask_user_question` 的问题和选项转发到微信，支持多选与自由文本
- 角色与性格：插件默认人设 + 每个联系人单独人设
- 会话归入对应 DSH 工作区，标题为 `微信·xxxx`
- 处理期间“正在输入”，长任务按间隔发进度提示
- 原生 Web 面板：右上角微信图标（连接状态点）、扫码/验证码、联系人、人设编辑、重新登录/退出
- 默认白名单：只允许扫码登录的本人微信号使用
- 群聊接入：可选开启，一个群一个 DSH 会话，支持 `all` / 仅被 @ 两种模式
- 关键错误告警：登录过期、收消息连续失败、回复发送失败、消息循环崩溃时主动推微信
- 跨端：不依赖 `webServer`，桌面端等没有本地 HTTP 服务的宿主也能用工具完成登录与状态查看

## 要求

| 组件 | 要求 |
|---|---|
| DSH | Web profile，`0.2.1-rc.5` 至 `0.2.x`（`0.3` 未验证） |
| Node.js | 20.3 或更高 |
| 微信 | 账号具备 iLink / ClawBot 扫码入口 |
| 网络 | 能访问 `ilinkai.weixin.qq.com` 与微信 CDN |

不需要公网 IP，也不需要反向代理；iLink 是出站长连接 + 长轮询。

## 安装

### 从 npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-wx-ilink@0.2.1
```

### 从 GitHub 安装

```bash
dsh plugin --profile web add github:An-yyds/dsh-wx-ilink#v0.2.1
```

### 从本地目录安装

```bash
dsh plugin --profile web add /absolute/path/to/dsh-wx-ilink
```

安装后**重启一次 DSH**（客户端入口在启动时扫描），然后硬刷新浏览器页面。

> 想跟随最新版可以用 `dsh-wx-ilink@latest`；生产环境建议固定版本号，避免自动升级带来行为变化。

## 快速开始

1. 重启 DSH，打开 Web 页面
2. 点会话右上角的微信图标
3. 手机微信扫码；如果手机显示数字验证码，在面板里输入提交
4. 面板显示“已连接”后，在微信里给机器人发 `/ping`
5. 收到 `长江收到 · ...` 说明通道打通

也可以使用兜底页面：启动日志里的 `http://127.0.0.1:3080/weixin?token=...`。

<img width="388" height="164" alt="image" src="https://github.com/user-attachments/assets/94d951dd-4fcc-473f-be29-3e1a328df1b8" />

重启将会在页面顶部栏出现插件标识

<img width="300" height="500" alt="image" src="https://github.com/user-attachments/assets/7e4c6f7b-68ac-40ea-a576-4966c698d391" />

打开可以进行连接和查看状态

<img width="300" height="550" alt="ffd929140d4fba5376e8f5f08d5d578c" src="https://github.com/user-attachments/assets/cecc5469-4040-4cac-a211-9d91686db0ca" />



## 命令

| 命令 | 作用 |
|---|---|
| `/new` | 开新会话，旧会话保留 |
| `/stop` | 立即停止当前任务（绕过队列） |
| `/status` | 连接、会话、模型、队列、审批/提问等待数 |
| `/ping` | 通道自检 |
| `/help` | 帮助 |
| `/persona` | 查看当前联系人的人设 |
| `/persona <角色/性格>` | 设置当前联系人的人设，下一条生效 |
| `/persona reset` | 清除单独设置，恢复默认人设 |

## 配置

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里覆盖：

```yaml
- id: weixin-ilink
  name: dsh-wx-ilink
  config:
    cwd: /home/you/project
    agentPreset: standard
    persona: |
      你叫「大鲸鱼」，性格温和幽默，回答简短直接。
    approvalPolicy: ask
    forwardApprovals: true
    forwardQuestions: true
```

| 配置 | 默认 | 说明 |
|---|---|---|
| `stateDir` | `$DSH_HOME/weixin-ilink` | 凭据、游标、会话映射、人设、日志 |
| `cwd` | `stateDir/workspace` | 微信会话工作目录；建议改到你的项目 |
| `baseUrl` | `https://ilinkai.weixin.qq.com` | iLink 服务地址（仅测试时改） |
| `provider` / `model` | 跟随 DSH 默认 | 微信会话使用的模型 |
| `agentPreset` | 跟随 profile 默认 | 建议 `standard` 或 `cordis`，否则工具可能不全 |
| `persona` | 空 | 默认角色/性格，作为系统提示注入 |
| `approvalPolicy` | `ask` | `ask` 转发审批；`never` 直接拒绝 |
| `forwardApprovals` | `true` | 关闭后等同 `never` |
| `forwardQuestions` | `true` | 把 `ask_user_question` 转发到微信 |
| `approvalTimeoutMs` | `120000` | 审批回复有效期；超时按拒绝 |
| `questionTimeoutMs` | `110000` | 单个问题等待回答时限 |
| `replyTimeoutMs` | `900000` | 单轮处理超时 |
| `maxChunk` | `1500` | 单条微信消息最大字符数 |
| `sendIntervalMs` | `1500` | 两条消息之间的最小间隔 |
| `maxMessages` | `8` | 一次回复最多分几条，超出截断 |
| `maxMediaBytes` | `20971520` | 单个媒体大小上限（20MB） |
| `typing` | `true` | 处理期间发送“正在输入” |
| `progressAfterMs` | `60000` | 超过多久开始发进度提示；`0` 关闭 |
| `progressEveryMs` | `120000` | 进度提示间隔 |
| `maxProgressMessages` | `2` | 单轮最多几条进度提示 |
| `workspaceTitle` | `微信` | 创建工作区时的标题（同目录已有工作区时沿用原名） |
| `allowedUsers` | `[]` | 非空时只允许这些微信 ID；为空时只允许扫码本人 |
| `allowAllUsers` | `false` | 设为 `true` 才允许任意联系人 |
| `adminToken` | 自动生成 | 兜底登录页 token；持久化在 state.json |
| `groups.mode` | `off` | 群聊开关：`off` / `all`（全部群消息）/ `mention`（仅被 @） |
| `groups.allowedGroups` | `[]` | 允许的群 ID；为空表示全部允许（仍需开启 mode） |
| `groups.mentionPattern` | 空 | `mention` 模式判断“被 @”的正则；默认只要文本含 `@` 就算 |
| `groups.allowedMembers` | `[]` | 群内允许的成员 ID；为空表示群内所有成员都可用 |
| `alerts.enabled` | `true` | 关键错误主动推送微信告警 |
| `alerts.includeOwner` | `true` | 告警推给扫码登录的主人 |
| `alerts.toUsers` | `[]` | 额外告警接收人 |
| `alerts.throttleMs` | `300000` | 同类告警的冷却时间（毫秒） |
| `botAgent` | `DSH-ILink/0.1.0` | 协议里的 bot_agent，仅用于观测 |

## 媒体

- 收到图片：模型支持图片输入时作为 image 内容块；不支持时保存为文件附件并说明
- 收到文件/视频：保存为 file 附件，模型可通过文件工具读取路径；视频不能直接播放
- 收到语音：使用微信服务端转写文字，不下载音频
- 发送：模型调用 `send_weixin_file`；只能发会话工作目录或 DSH 附件目录内的文件，按扩展名发成图片/视频/文件

## 审批与提问

模型调用需要审批的工具时，微信会收到：

```
需要你授权（#1）
工具：bash
原因：...
回复 1 允许一次，回复 2 拒绝；120 秒内有效。
```

- `1` / `允许` / `同意` → 允许一次
- `2` / `拒绝` / `不同意` → 拒绝
- 多条审批按联系人排队，一次只问一条
- `ask_user_question` 会逐题转发；回复编号或直接输入文字

## 跨端（Web / 桌面端 / 终端）

插件不强依赖任何 HTTP 服务：

| 宿主 | 入口 |
|---|---|
| DSH Web | 右上角微信图标抽屉；或 `/weixin?token=...` 页面 |
| 桌面端 / 终端等无 webServer 的宿主 | 让 Agent 调用工具：`weixin_login`（返回二维码图片）、`weixin_verify`、`weixin_status`、`weixin_logout` |

典型用法：在桌面端的会话里输入“帮我登录微信”，Agent 调用 `weixin_login`，界面直接显示二维码图片；如果界面不渲染图片，结果里会给出 `qrPath`（`login-qr.gif`），打开文件扫码即可。扫码后如需验证码，输入后让 Agent 调用 `weixin_verify`。

工具在 Web 端同样可用，作为面板之外的备用入口。

## 群聊

默认关闭。开启后，一个微信群对应一个 DSH 会话；回复发回群里。

```yaml
- id: weixin-ilink
  name: dsh-wx-ilink
  config:
    groups:
      mode: mention          # off / all / mention
      allowedGroups: []      # 空 = 全部群；建议填明确的群 ID
      mentionPattern: ''     # 留空则“文本含 @”即视为被叫到
```

- 群消息会以 `[群聊 xxxx · 成员 xxxx] 内容` 的格式交给模型，模型能区分发言人
- 未授权的群只会回复一次“群 ID + 如何授权”，不会刷屏
- 群内命令（`/new`、`/status`、`/persona` 等）与单聊一致
- 会话标题为 `微信群·xxxx`，可在 DSH 侧边栏直接看到
- `send_weixin_file` 在群里会把文件发到群

**注意**：iLink 群消息的字段行为需要以真实群验证；`mention` 模式默认用“文本里出现 `@`”判断，必要时用 `mentionPattern` 指定机器人昵称。

## 告警

关键错误会主动推送到微信（默认发给扫码登录的主人）：

| 告警类型 | 触发条件 |
|---|---|
| `session-expired` | bot_token 失效，需要重新扫码 |
| `poll-failed` | 连续 3 次拉取消息失败 |
| `send-failed` | 回复微信失败（重试后仍失败） |
| `loop-crashed` | 消息循环异常退出 |

- 同类告警在 `alerts.throttleMs`（默认 5 分钟）内只发一次
- 告警发送失败只写日志，不会递归告警
- 重新登录成功后自动清空冷却

## 安全

- 默认只允许扫码登录的微信号；`allowedUsers` 可增加，`allowAllUsers: true` 才会放开所有人
- `bot_token`、`context_token` 存在 `$DSH_HOME/weixin-ilink/state.json`（`0600`）
- 登录页/面板需要 DSH 登录态或 `adminToken`
- 媒体下载只允许微信域名/CDN
- 文件发送限制在工作区/附件目录，拒绝目录穿越
- 审批超时/取消按拒绝（fail closed）

## 实现

```
index.js             Host 插件入口：状态、长轮询、消息分发、命令、Agent 驱动
client.js            DSH Web 客户端：右上角图标 + 原生右侧抽屉
lib/config.js        配置解析、常量、帮助文本
lib/text.js          纯文本 / HTTP 小工具
lib/ilink.js         iLink HTTP 协议：登录、getupdates、sendmessage、typing、媒体上传
lib/media.js         CDN 下载、AES-128-ECB 解密、媒体描述
lib/login.js         扫码登录状态机
lib/panel.js         本机登录页与兜底路由
lib/approval.js      工具审批 → 微信 1/2（排队）
lib/questions.js     ask_user_question → 微信逐题问答
lib/attachments.js   媒体 → DSH 内容块
lib/typing.js        “正在输入”与进度提示
lib/peers.js         单聊 / 群聊主体解析与群策略
lib/alerts.js        关键错误主动告警
lib/state.js         原子状态存储
lib/qr.js            二维码 SVG
vendor/qrcode.mjs    qrcode-generator 2.0.4（MIT）
test/                协议 / 媒体 / 上传 / 群聊 / 告警单元测试
```

协议细节：`get_bot_qrcode` → `get_qrcode_status` → `getupdates` 长轮询 → `sendmessage`；媒体走 `getuploadurl` + CDN。

## 开发

```bash
npm test
```

无运行时依赖，测试使用 Node.js 内置 test runner。修改 `client.js` 后需要重启 DSH 或刷新页面才能看到面板变化。

## 已知限制

- 不支持发语音；收到语音只用转写文字
- 引用消息、名片、小程序未解析
- 图片理解取决于模型；文本模型只能拿到文件附件
- DSH 同一目录只能有一个工作区，微信会话会挂到现有同目录工作区，不能另建同目录「微信」分组
- 回复是整轮完成后的最终文本，没有流式逐字输出
- 单机器人/单微信账号

## 说明
做这个插件源于微信 ClawBot 插件，想着在手机端可以发消息给电脑端的DSH，帮助我处理一些文件什么的。本插件全程使用DSH的创造模式开发，我只协调测试和审查，确实提高了开发的速度。同时开发这个插件也是开到了一个wx的文章，该作者很强大也是开发了一个这样的插件，还支持群聊功能，大家可以去支持https://github.com/agi-redtea/dsh-weixin-web。我在此加了一个人设的配置，用户可以自由配置人设，这样感觉更好。后续也会继续开发，继续完善这个插件，后续可以补充发送表情什么的。

## 版本更新

完整记录见 [CHANGELOG.md](CHANGELOG.md)。

| 版本 | 日期 | 主要内容 |
|---|---|---|
| [0.2.1](https://www.npmjs.com/package/dsh-wx-ilink/v/0.2.1) | 2026-11-10 | `weixin_login` 增加二维码文件兜底（`login-qr.gif`），适配不渲染图片的界面 |
| [0.2.0](https://www.npmjs.com/package/dsh-wx-ilink/v/0.2.0) | 2026-11-10 | 跨端支持（`webServer` 变可选）、新增 `weixin_login` / `weixin_verify` / `weixin_status` / `weixin_logout` 控制工具、桌面端可用 |
| [0.1.1](https://www.npmjs.com/package/dsh-wx-ilink/v/0.1.1) | 2026-11-10 | 群聊接入（`off`/`all`/`mention`）、关键错误主动告警、`index.js` 拆分为 13 个模块、测试增至 39 项 |
| [0.1.0](https://www.npmjs.com/package/dsh-wx-ilink/v/0.1.0) | 2026-11-09 | 首个公开版本：扫码登录、长轮询、独立会话、媒体收发、审批与提问转发、人设、原生面板、白名单 |

升级方式：

```bash
# 固定版本
dsh plugin --profile web add dsh-wx-ilink@0.2.1

# 或跟随最新
dsh plugin --profile web add dsh-wx-ilink@latest
```

升级后重启一次 DSH。登录状态保存在 `$DSH_HOME/weixin-ilink/state.json`，不需要重新扫码。

## License

MIT。二维码库 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 也是 MIT，版权归其作者。
