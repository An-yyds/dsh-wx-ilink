# dsh-wx-ilink

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

## 要求

| 组件 | 要求 |
|---|---|
| DSH | Web profile，`0.2.1-rc.5` 至 `0.2.x`（`0.3` 未验证） |
| Node.js | 20.3 或更高 |
| 微信 | 账号具备 iLink / ClawBot 扫码入口 |
| 网络 | 能访问 `ilinkai.weixin.qq.com` 与微信 CDN |

不需要公网 IP，也不需要反向代理；iLink 是出站长连接 + 长轮询。

## 安装

### 从 npm 安装（发布后）

```bash
dsh plugin --profile web add dsh-wx-ilink@0.1.0
```

### 从 GitHub 安装

```bash
dsh plugin --profile web add github:An-yyds/dsh-wx-ilink#v0.1.0
```

### 从本地目录安装

```bash
dsh plugin --profile web add /absolute/path/to/dsh-wx-ilink
```

安装后**重启一次 DSH**（客户端入口在启动时扫描），然后硬刷新浏览器页面。

## 快速开始

1. 重启 DSH，打开 Web 页面
2. 点会话右上角的微信图标
3. 手机微信扫码；如果手机显示数字验证码，在面板里输入提交
4. 面板显示“已连接”后，在微信里给机器人发 `/ping`
5. 收到 `长江收到 · ...` 说明通道打通

也可以使用兜底页面：启动日志里的 `http://127.0.0.1:3080/weixin?token=...`。

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

## 安全

- 默认只允许扫码登录的微信号；`allowedUsers` 可增加，`allowAllUsers: true` 才会放开所有人
- `bot_token`、`context_token` 存在 `$DSH_HOME/weixin-ilink/state.json`（`0600`）
- 登录页/面板需要 DSH 登录态或 `adminToken`
- 媒体下载只允许微信域名/CDN
- 文件发送限制在工作区/附件目录，拒绝目录穿越
- 审批超时/取消按拒绝（fail closed）

## 实现

```
index.js          Host 插件：路由、登录、长轮询、会话映射、Agent 驱动、审批、提问、人设
client.js         DSH Web 客户端：右上角图标 + 原生右侧抽屉
lib/ilink.js      iLink HTTP 协议：登录、getupdates、sendmessage、typing、媒体上传
lib/media.js      CDN 下载、AES-128-ECB 解密、媒体描述
lib/state.js      原子状态存储
lib/qr.js         二维码 SVG
vendor/qrcode.mjs qrcode-generator 2.0.4（MIT）
test/             协议/媒体/上传单元测试
```

协议细节：`get_bot_qrcode` → `get_qrcode_status` → `getupdates` 长轮询 → `sendmessage`；媒体走 `getuploadurl` + CDN。

## 开发

```bash
npm test
```

无运行时依赖，测试使用 Node.js 内置 test runner。修改 `client.js` 后需要重启 DSH 或刷新页面才能看到面板变化。

## 已知限制

- 只处理单聊，群聊消息忽略
- 不支持发语音；收到语音只用转写文字
- 引用消息、名片、小程序未解析
- 图片理解取决于模型；文本模型只能拿到文件附件
- DSH 同一目录只能有一个工作区，微信会话会挂到现有同目录工作区，不能另建同目录「微信」分组
- 回复是整轮完成后的最终文本，没有流式逐字输出
- 单机器人/单微信账号

## License

MIT。二维码库 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 也是 MIT，版权归其作者。
