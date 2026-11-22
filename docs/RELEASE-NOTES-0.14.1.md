# dsh-apk-vm 0.14.1

Release date: 2026-11-22

## Highlights

- **Update checks in the APK VM panel.** The page asks the npm registry (npmjs,
  falling back to npmmirror, 1-hour cache) whether a newer release exists and
  shows a banner with **Update now** / **Plugin settings** shortcuts that open
  this plugin's page in the DSH plugin manager.
- **Plugin settings page.** Thirteen runtime settings can be edited from the
  plugin page (`plugins.bundle.config` slot) instead of hand-editing
  `cordis.patch.yml`: `autoStart`, `prewarm`, `frameFps`, `autoSetup`,
  `autoReinstall`, `memoryGuard`, `maxInstances`, `sharedResident`,
  `sharedSuspendAfterMs`, `sharedStopAfterMs`, `armTranslation`,
  `lockEnforcement`, `lockControl`. Saving goes through the DSH config editor
  (the plugin restarts to apply).
- **Full Chinese documentation.** `README.zh-CN.md` is a complete Chinese guide
  (install, panel, configuration, ownership/locks, resident VM, ARM
  translation, update/settings, agent playbook, API, storage, troubleshooting).

## Added

- `GET /apk-vm/version` — npm latest-version lookup with a one-hour cache and an
  8-second timeout; returns `{current, latest, updateAvailable, checkedAt}`.
- `GET /apk-vm/settings` — current values, defaults, bounds and whether the
  profile can edit plugin configuration.
- `POST /apk-vm/settings` — validates a `{patch:{key:value}}` body (booleans,
  number min/max, enums, unknown keys rejected) and writes it through
  `configEditor`, then reports `{saved, restartRequired}`.
- Panel update banner and plugin-settings link in the APK VM page.
- Plugin settings panel registered in `plugins.bundle.config`, with grouped
  controls, read-only explanation when the profile cannot edit configuration,
  and an "Open plugin page" shortcut.
- `README.zh-CN.md` plus cross-links from the README, both changelogs and the
  npm `files` list.

## Changed

- Saving settings restarts the plugin (and therefore cold-boots the VM, about
  20–30 s); the panel reconnects automatically. This is documented in the
  settings page and the Chinese README.

## Verification

- `node --check index.js` / `client.js` / all `lib/*.js` pass.
- `npm run check` exit 0 (`check-version: ok (0.14.1)`).
- `npm test` exit 0 (full suite: UI smoke with 3-slot assertion, ownership 126
  checks, storage clean 16 checks, ARM translation 10 checks, shared resident
  29 checks, activity log 157 checks, and the rest).
- `node scripts/privacy-scan.mjs --untracked` → clean (149 files).
- Live check on the local profile: `/apk-vm/version` returns the current
  version; `/apk-vm/settings` is editable with 13 entries; saving
  `frameFps` 2→3→2 works, invalid keys and out-of-range values are rejected
  with HTTP 400; the settings slot renders (36/36 component-level checks).

## Known issues

- The update banner only appears when the npm latest version is newer than the
  installed one.
- Endpoints are loopback-only unless `allowRemote: true`.
- Saving settings restarts the plugin; a lighter volatile-update path for
  non-structural settings is future work.

## Install

```bash
dsh plugin --profile web add dsh-apk-vm@0.14.1
```

npm: <https://www.npmjs.com/package/dsh-apk-vm>

## 中文摘要

0.14.1 新增「检查更新」组件与 DSH 插件设置页：APK 虚拟机页面会检测 npm 最新版本，
有新版本时显示更新条，并可跳转 DSH 插件页；插件页可直接编辑 13 项运行设置
（autoStart、frameFps、maxInstances、共享常驻 VM、操作锁、ARM 转译等），保存后通过
DSH 配置编辑器写回并重启插件生效。同时新增完整中文说明 `README.zh-CN.md`。
本版还包含 `GET /apk-vm/version`、`GET/POST /apk-vm/settings` 两个接口，带缓存、
校验与只读提示。验证：全量 `npm test`、`npm run check` 通过，隐私扫描 clean。
