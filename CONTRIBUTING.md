# Contributing

Thanks for improving `dsh-wx-ilink`.

## Before opening a PR

```bash
npm test
```

The project has no runtime dependencies; tests use the Node.js built-in test runner.

## Rules

- Do not commit `state.json`, `plugin.log`, `bots.json`, bot tokens, cookies, or any real WeChat identifiers.
- Keep `index.js` (Host) and `client.js` (browser) in sync when changing RPC, panel state, or user-visible text.
- The plugin targets the DSH Web profile and the iLink bot protocol; keep changes compatible with `engines.dsh`.
- For security issues, do not open a public issue; see `SECURITY.md`.
