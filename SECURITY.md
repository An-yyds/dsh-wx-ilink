# Security

`dsh-wx-ilink` connects a personal WeChat account to a DSH Agent. Treat it as a remote-control channel.

## Sensitive data

- `bot_token`, `context_token`, and the WeChat user id live in `$DSH_HOME/weixin-ilink/state.json` (mode `0600`).
- The login page token and logs live beside it. Do not commit or share the state directory.
- The plugin never sends the bot token to the browser panel.

## Defaults

- Only the WeChat account that scanned the bot is allowed by default. Add other users explicitly with `allowedUsers`; `allowAllUsers: true` disables this protection.
- File sending is restricted to the session working directory and the DSH attachment directory.
- Media downloads are restricted to WeChat-owned hosts.
- Tool approvals are forwarded to WeChat and fail closed on timeout.

## Report a vulnerability

Open a private security advisory on the repository or contact the maintainers directly. Do not include real tokens, QR payloads, or chat content in a public issue.
