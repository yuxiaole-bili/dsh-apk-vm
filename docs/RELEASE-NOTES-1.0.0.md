# dsh-apk-vm 1.0.0

**Observability and reliability.** The plugin now keeps a local, browsable journal of what an
Agent did to the VM, survives the device problems that used to wedge a session, and provisions a
cold machine end-to-end without manual SDK setup. `1.0.0` marks the documented tool actions and
HTTP routes as stable.

## Highlights

- **Agent activity log (图形化工作日志).** Every `apk_vm` call is recorded locally: action,
  argument preview, result, error, duration, instance and a screenshot for mutating actions. The
  sidebar **Agent activity** card shows a filterable timeline with thumbnails and a full-image
  overlay; the same data is available over HTTP (`GET /apk-vm/activity`,
  `GET /apk-vm/activity/<id>/shot`, `POST /apk-vm/activity/clear`). Journal entries and
  screenshots stay on the host and are never uploaded.
- **Hardened device interactions.** Screenshot failures are now structured device errors
  (`EDEVICE_UNRESPONSIVE`, `ESYSTEM_SERVER_DEAD`, `ESURFACEFLINGER_DEAD`, `ESCREENSHOT_TIMEOUT`, …)
  with an opt-in reconnect/reboot recovery instead of a bare 180 s timeout. WebView UI dumps
  supplement their text nodes from guest-side `uiautomator dump`; taps and non-ASCII text can be
  verified/retried; shell root, guest default routes, watchdog/ANR health and post-install
  appops all have explicit recovery hooks.
- **Zero-config first run, hardened.** Provisioning downloads a checksum-verified Temurin JDK 17,
  the SDK command-line tools, platform-tools/emulator/build-tools/platforms, the system image and
  the AVD, then boots the VM. Blocked GitHub hosts fail over to the built-in China mirror and the
  bundled known-good JDK table; downloads resume; a 3 GB disk precheck and a cross-process lock
  keep repeated cold starts predictable. Progress (percent/bytes) is visible in the panel.
- **Demo media in the repository.** `docs/demo.gif` (28 s, 720×1280) shows the loop — home screen →
  sample APK installed and driven through the HTTP API → 60 fps animation in the guest — and
  `scripts/make-demo-gif.mjs` re-encodes frames captured with the documented screencap loop.

## Fixed bugs reported by users

- `adb` action: `Cannot access 'api' before initialization`.
- `storage` action: `storageSdkRoot is not defined`.
- `push`: `local file not found under an allowed root` for files that exist (outside-roots vs
  missing paths are now distinguished, with realpath canonicalization on Windows).
- `screenshot` hanging for 180 s when the guest UI service was wedged.
- `ui_dump` / `inspect_ui` returning no usable WebView text.
- Guest network (default route) lost after switching to shared networking or rebooting.
- System instability after a `system_server` watchdog crash / ANR left the device unrecoverable.
- "Install unknown apps" appops reset after reinstall (opt-in preservation).

## Verification

- `npm run check` — pass
- `npm test` — all headless suites pass (including the new `spike/tool-core-test.mjs`,
  `spike/activity-log-test.mjs` and `spike/android/resilience-test.mjs`; setup/JDK/auto-setup
  suites stay green)
- `npm run privacy -- --untracked` — clean
- Cold-machine full-chain E2E on an isolated empty SDK/JDK/AVD tree (Windows host): autoSetup
  provisions the whole toolchain and reaches `ready`, with per-step timings recorded.
- Live Android 14 emulator: activity timeline receives tool calls; `examples/agent-workflow.mjs`
  passes end-to-end.

## Limits

- Windows x64 and Linux x86_64 are the end-to-end verified platforms; macOS/Apple Silicon image
  selection is implemented but not yet verified end-to-end.
- The activity journal records `apk_vm` tool calls; direct HTTP calls from scripts are not
  journaled. Default caps: 1000 entries / 250 MB (`activityDir` changes the location; caps are
  not configurable yet).
- Provisioning still needs a host hypervisor (AEHD/WHPX on Windows, KVM on Linux, Hypervisor
  Framework on macOS) — the plugin cannot install it.
- No audio transport yet.

## Install

```bash
dsh plugin --profile desktop add dsh-apk-vm
```

Then open the sidebar entry **APK Virtual Machine**. On a cold machine the Environment card starts
provisioning automatically; press **Start VM** when it turns **Ready**.

## Publishing checklist (maintainers)

1. `npm run check` / `npm test` / `npm run privacy -- --untracked` on a clean tree.
2. Confirm `package.json` version `1.0.0`, this file, `CHANGELOG.md` and `README.md` agree.
3. `npm pack --dry-run` — confirm the package contains `lib/activity-log.js`, `lib/jdk.js`,
   `lib/autosetup.js`, `scripts/make-demo-gif.mjs`, `docs/demo.gif` and the updated docs.
4. `npm login` → `npm publish --access public` → `npm view dsh-apk-vm version`.
5. Push the clean open-source branch and tag `v1.0.0`; create the GitHub release with excerpts of
   this file and `docs/demo.gif` embedded.
6. Update the `dsh-plugin.org` listing and the `awesome-dsh-plugins` entry if the description or
   screenshots change.
