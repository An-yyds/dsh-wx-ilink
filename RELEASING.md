# Releasing

The package is published to the public npm registry, not the local Tencent mirror.

## Checks

```bash
npm test
npm pack --dry-run
npm publish --dry-run
```

## Publish

```bash
npm login --registry=https://registry.npmjs.org/
npm publish --registry=https://registry.npmjs.org/ --access public
```

`package.json` already pins `publishConfig.registry`, so `npm publish` without `--registry` also targets npmjs.

## GitHub release

```bash
git push origin master
git push origin v0.1.0
```

Then create a GitHub Release from tag `v0.1.0`, using the matching section of `CHANGELOG.md` (add one when the first release is cut).

## Versioning

- Patch: bug fixes, documentation
- Minor: new compatible features
- Major: breaking config, state, or DSH compatibility changes
