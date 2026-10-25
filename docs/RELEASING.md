# Releasing and publishing

This project is distributed as a **DSH plugin bundle** and an **npm package** named
`dsh-apk-vm`, following the DSH plugin naming convention. The primary install command is
`dsh plugin --profile web add dsh-apk-vm`; the bundle patch installs from the npm package.
Repository: <https://github.com/yuxiaole-bili/dsh-apk-vm>.

## Publish to npm

The package is intentionally public and has no build step; publishing the repository directory is
enough:

```bash
npm login                      # once per machine, as the npm account that owns dsh-apk-vm
npm publish --access public    # prepublish uses the packed file list
npm view dsh-apk-vm version    # verify the published version
```

The GitHub release tarball and the npm tarball are produced from the same `npm pack` output.
If the version already exists on npm, bump `version` and `CHANGELOG.md` together before publishing.
For a manual GitHub Actions path, add an `NPM_TOKEN` repository secret (npm automation token that
can publish `dsh-apk-vm`) and run the **Publish to npm** workflow
([.github/workflows/npm-publish.yml](../.github/workflows/npm-publish.yml)).

## Suggested GitHub repository description

> Preview and debug Android APKs inside DeepSeek Harness: a local rooted AOSP VM with up to 60 fps
> H.264/WebCodecs streaming, drag-and-drop install, UIAutomator automation, and isolated VMs per
> Agent.

Suggested topics:

```text
dsh, deepseek-harness, android, android-emulator, apk, scrcpy, webcodecs, ai-agents, ui-automation
```

The in-app Plugin Manager title/description comes from `locale/en.json` and `locale/zh.json`
(`meta.title` / `meta.description`); keep those in sync with this description.

## Before the first public push

0. **Publish a clean history if the development history contains local paths.** This repository
   may include an `open-source` branch with a single initial commit and no local development
   history; push that branch (or create your own orphan branch) instead of the full dev history:

   ```bash
   git push -u origin open-source:main
   ```

1. Repository metadata is already configured in `package.json` (`repository`, `homepage`,
   `bugs`) and the README has the matching badges. Update these only if the project moves or is
   forked.
2. Check the tree for personal paths, screenshots, recordings, emulator logs and AVD dumps:

   ```bash
   git grep -n -I -E 'D:\\\\|C:\\\\Users|/Users/|/home/[^ ]+/.android'
   git status --ignored --short
   ```

   Also scan for your own hostname, private-network IPs and usernames. The repository ships a
   tracked-tree scanner: `npm run privacy` (use `node scripts/privacy-scan.mjs --all` only to
   inspect development history locally; the full history is not part of the clean release
   branch).

3. Run the full headless suite:

   ```bash
   npm ci --ignore-scripts   # or: npm install --ignore-scripts
   npm run check
   npm test
   ```

4. Re-test the live paths on a real host and update the verification notes:
   boot/quick boot, H.264 60 fps, input mapping, multi-instance, physical-device attach,
   APK upload/install, APK icon/info, clipboard (optional), pinch.

## Versioning

- `package.json` and `CHANGELOG.md` move together.
- Use `0.x.y` while the plugin API/route surface may still change.
- Keep `SECURITY.md` supported-version table in sync.
- Tag the release (`git tag -a v0.3.12 -m ...`) and attach the tarball produced by
  `npm pack --pack-destination dist`.

## GitHub release checklist

- [ ] LICENSE and NOTICE present and accurate (no unbundled upstream sources claimed)
- [ ] CODE_OF_CONDUCT.md, CONTRIBUTING.md, SECURITY.md present
- [ ] Issue templates and PR template present
- [ ] CI green (headless suite; Windows cross-platform job is optional)
- [ ] No secrets, tokens, personal paths, AVDs, logs, recordings or `dist/` committed
- [ ] Demo media (if any) recorded on a real host and listed in `docs/README.md`
- [ ] README install instructions use `<path-to-repo>` / user-chosen paths
- [ ] Release notes call out known limitations (Windows E2E only, no audio, etc.)

## Known limitations to state in the release

- Windows x64 is the only platform verified end-to-end for boot/stream/debug; macOS/Linux are
  covered by headless detection/CI but have not been live-verified.
- No audio forwarding.
- Physical-device attach is implemented; a real USB phone was not available for validation in
  the reference environment.
- Clipboard support is optional and uses scrcpy control messages; it requires a running H.264
  stream.
