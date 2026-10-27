# Changelog

## 0.6.0

Network controls.

### Added

- Port forwarding management (`forward-add` / `forward-remove`) over adb, with a host-port →
  guest-port list and optional `shared` rules.
- Custom DNS servers via the emulator `-dns-server` launch flag (restart required) and guest
  `/etc/hosts` injection through a root bind mount, reapplied after boot.
- Proxy connectivity test from inside the guest (`ping` + toybox `nc`), and current proxy
  display in the Network card.
- Per-instance network mode:
  - `isolated` (default QEMU-NAT isolation)
  - `shared` (host-mediated TCP sharing through shared port forwards)
- Optional emulator pcap capture (`-tcpdump`) with `GET /apk-vm/network/pcap` download.
- Network card UI for forwards, DNS, hosts, mode, test, and pcap; `apk_vm` action `network`.
- Per-instance network route: `/apk-vm/instances/<id>/network`.

### Notes

- Shared mode is host-mediated TCP sharing, not L2 bridging; instances keep their own QEMU NAT.
- DNS changes take effect on the next emulator start; hosts changes apply live and survive a
  restart while the plugin keeps the configured entries.
- pcap export is opt-in and only writes traffic from the emulator's user-mode network.

## 0.5.0

Storage management.

### Added

- Storage panel: AVD / snapshot / SDK / plugin temp / free-disk footprint, with guarded
  cleanup actions (two-click confirmation for destructive actions).
- `GET /apk-vm/storage` and `POST /apk-vm/storage` (`temp`, `snapshots`, `orphan-avds`).
- `apk_vm` actions `storage` and `clean_storage`.
- `lib/storage.js` with dependency-free size accounting and cleanup helpers; unit coverage for
  temp cleanup, orphan AVD detection and snapshot-aware accounting.

### Notes

- Snapshot cleanup only targets a stopped plugin-managed AVD; the active VM is never deleted.
- Orphan cleanup only matches `dsh_apk_*` AVDs that are not registered to an instance.

## 0.4.1

Privacy cleanup for the published proof assets.

### Changed

- Cropped `docs/screenshot-sidebar.png` to the plugin panel only (removes the center session
  area and workspace label; the APK paths were already redacted).
- Removed host account names from `docs/LINUX-E2E.md`; the document now describes the KVM
  group requirement without identifying accounts.

## 0.4.0

Substantive feature release: inspection, replay, package bundles, network debugging,
reproducible demo, and real Linux support.

### Added

- **UI Inspector + selector generation.** `GET /apk-vm/debug/inspect` returns parsed
  UIAutomator nodes with bounds, labels and copy-ready `find_ui` / `assert_text` / `tap_text`
  commands; the panel renders a clickable overlay and the `apk_vm` tool gains `inspect_ui`.
- **Interaction recorder / replay.** `GET|POST /apk-vm/flows` lists, starts, stops, replays
  and deletes JSON flows of tap/swipe/key/text input; the panel has a Flow recorder card and
  Agents get `flow_start`, `flow_stop`, `flow_list`, `flow_replay`.
- **APKS / XAPK / split APK installation.** Upload and install `adb install-multiple` bundles;
  `.aab` is rejected with a bundletool hint. The APK list tags bundle files.
- **Network debugging.** Set/clear the guest global HTTP proxy and install a local PEM/DER CA
  with the correct OpenSSL subject hash via `/apk-vm/debug/proxy` and `/apk-vm/debug/ca`
  (plus Agent tool actions `proxy` and `install_ca`).
- **Reproducible public demo.** `examples/` contains a committed MIT-licensed 12 KB sample
  APK, a deterministic SDK-only build script, and `demo.mjs`, which installs it, taps the
  button, asserts `Hello from dsh-apk-vm`, and saves a screenshot.
- **Real Linux support.** Headless x86_64 validation on Ubuntu 22.04 with KVM and
  SwiftShader: boot, adb root, APK install, UIAutomator input, H.264/scrcpy, proxy, CA and
  screenshots; documented in `docs/LINUX-E2E.md`.

### Fixed

- **Dangerous auto-attach stop behavior.** `AndroidVm.stop()` no longer sends
  `adb emu kill`/`adb disconnect` to a pre-existing device that this process did not spawn;
  it leaves such devices running and reports `stopped`. A regression test covers it.
- Headless Linux launches now request `-no-metrics` and fall back from host GPU to
  `swiftshader_indirect` when no display is present.
- `uiDump()` now includes UIAutomator stderr in its error instead of a generic
  "empty hierarchy".
- `spike/android/smoke.mjs` updated for the richer APK metadata and the current
  package-not-found message.

## 0.3.13

Open-source package identity.

### Changed

- Package name changed from `@local/dsh-apk-vm` to **`dsh-apk-vm`**, following the DSH plugin
  naming convention (`dsh-*`). The Host export, client bundle id, Cordis patch row, smoke tests
  and docs were updated to match.
- `author` is now `yuxiaole-bili <https://github.com/yuxiaole-bili/>`.
- Removed `private: true` and added `publishConfig` for the public npm package
  **`dsh-apk-vm`**; the primary install command is now
  `dsh plugin --profile web add dsh-apk-vm` (source/GitHub install remains a fallback).
  Published: <https://www.npmjs.com/package/dsh-apk-vm> (`0.3.13`).
- Wrote the package/plugin descriptions (English + Chinese `meta.description`), expanded
  keywords, and added a suggested GitHub repository description/topics list to
  `docs/RELEASING.md`.
- Configured repository metadata for
  <https://github.com/yuxiaole-bili/dsh-apk-vm>: `repository`, `homepage`, `bugs`, README
  badges/repository link, issue-template security/repository links, and the local `origin`
  remote.
- Added the community-market submission package: one-line value, copyable source install
  command, capability category, risk/permissions/compatibility section, real screenshots
  (main panel + right sidebar), and `docs/SUBMISSION.md` with the filled `dsh-plugin.org` issue
  template.

## 0.3.12

Clipboard fix + open-source release preparation.

### Fixed

- `SET_CLIPBOARD` returned a BigInt sequence that could not be JSON-serialized; it is now a
  decimal string.
- `GET_CLIPBOARD` now sends the required single `copyKey` payload byte instead of an empty
  message, which previously stalled the control stream and timed out.
- Live-verified: set `dsh-clipboard-test-42`, then read it back successfully.

### Open-source preparation

- Added `CODE_OF_CONDUCT.md`, `.editorconfig` and `docs/RELEASING.md`.
- Removed personal/local paths from DEMO/DESIGN/spike docs and scripts; removed the stale
  hard-coded DSH WebSocket port fallback from `client.js`.
- Updated `NOTICE` (only the bundled scrcpy JAR is redistributed; test-only upstream sources are
  not in the repo), `SECURITY.md` supported versions and loopback threat model.
- Package metadata: author; contributor/security/CoC/docs included in the npm pack file list.
- README: open-source distribution note, CoC/release links, lifecycle test in the contributor
  quick reference.
- Added `docs/PRIVACY.md` and `scripts/privacy-scan.mjs`; CI scans the tracked tree for personal
  paths, private IPs, agent instance IDs, credential patterns and emails. The clean single-commit
  `open-source` branch is the recommended public history; the local dev history contains older
  workspace paths.

## 0.3.11

Clipboard sync over scrcpy control.

### Added

- `buildSetClipboardMessage()` (u8 type=9, u64 sequence, u8 paste, i32 length, UTF-8) and
  `ScrcpySession.setClipboard()` / `requestClipboard()` (`GET_CLIPBOARD`, awaited device reply).
- `GET/POST /apk-vm/clipboard` plus per-instance `/apk-vm/instances/<id>/clipboard`.
- Panel debug card: **Copy field to device** / **Get device clipboard** buttons (the latter also
  writes to the host clipboard when permitted).
- `apk_vm` actions `clipboard_set` / `clipboard_get`.

## 0.3.10

Two-finger pinch/zoom over the scrcpy control socket.

### Added

- `POST /apk-vm/touch` (and per-instance `/apk-vm/instances/<id>/touch`) forwards multi-pointer
  touch down/move/up/cancel to the active scrcpy session. Coordinates are video-frame pixels.
- The screen promotes a two-finger gesture from the adb single-pointer path to a scrcpy
  multi-touch pinch, with pointer capture and 60 Hz move throttling.
- `ScrcpyStream.sendTouch()` / `ExtraVmInstance.sendTouch()` for per-instance control.

## 0.3.9

Agent UI automation.

### Added

- `apk_vm` actions `find_ui` / `assert_text` / `tap_text`: dump UIAutomator XML, filter nodes by
  text / resource-id / content-desc / class, return matching bounds/centers, assert presence, or
  tap the matching node's center. `assert_text` returns `ok:false` on a missing node instead of
  throwing, so Agents can branch on assertions.

### Verified

- Live multi-instance VM: `find_ui {"text":"Phone"}` → `Phone @ 102,1121`;
  `assert_text` found 1 node; `tap_text` opened Phone; `key HOME` returned to the launcher.

## 0.3.8

Bootstrap a completely empty Android SDK.

### Added

- `bootstrapSdk()`: downloads the official command-line tools ZIP for Windows/macOS/Linux,
  extracts it into `<sdkRoot>/cmdline-tools/latest`, runs `sdkmanager --licenses`, then installs
  platform-tools/emulator/build-tools/platform. HTTPS only, 512 MiB cap, temp archive cleanup,
  JDK pre-check, no shell interpolation.
- `POST /apk-vm/setup {"action":"bootstrap-sdk"}`, gated by `allowSetupDownloads`;
  Environment card shows **Bootstrap SDK** when sdkmanager is missing.
- Setup report action list + 2 hermetic bootstrap tests (injected download/extract/exec).

### Verified

- `spike/setup-smoke.mjs`: **32/32** (bootstrap argv, extracted sdkmanager, license/install
  calls, invalid-package rejection).
- Live host: setup actions include `bootstrap-sdk` (unavailable because sdkmanager exists).

## 0.3.7

Hardware keyboard forwarding in the H.264/PNG screen.

### Added

- Clicking the guest screen focuses it; common hardware keys (arrows, Enter, Escape, Tab,
  Backspace, Delete, Home) become Android key events, and printable characters are forwarded as
  text input. Input fields are excluded so typing in the panel is unaffected.
- Screen hint documents the keyboard behavior.

## 0.3.6

SDK component installation from the Environment card.

### Added

- `installSdkPackages({ packages })` in `lib/setup.js`: validated, bounded
  `sdkmanager --install <pkg…>` with optional license stdin.
- `POST /apk-vm/setup {"action":"install-tools"}` installs missing
  platform-tools/emulator/build-tools/platform (or caller-supplied `packages`), gated by
  `allowSetupDownloads: true`.
- Environment card exposes the **Install SDK tools** action when adb/emulator are missing.
- Setup report action list and hermetic setup test updated (30/30).

## 0.3.5

Static APK preview.

### Added

- `aapt2` badging parser now returns versionName/versionCode, min/target SDK, permissions,
  features, native ABIs and the launcher icon path in addition to package/label/activity.
- `GET /apk-vm/apk-info?path=…` static metadata (no VM boot).
- `GET /apk-vm/apk-icon?path=…` extracts a raster launcher icon directly from the APK ZIP with
  a dependency-free ZIP reader (adaptive XML icons are reported but not rasterized).
- APK list shows icons for raster APKs; `apk_vm` action `apk_info`.

### Verified

- `anim60.apk`: targetSdk 34, zero permissions, activity resolved.
- `DSH-1.12-vc13.apk`: icon extracted as a 631-byte PNG (`89 50 4e 47` signature).
- `yuagent-final.apk`: versionName 0.4.4, 5 permissions, adaptive XML icon reported.

## 0.3.4

Live logcat and crash observability.

### Added

- Debug card: **Live logcat** toggle (2 s polling), **Crash log** button (`logcat -b crash`).
- `AndroidVm.logcat({ buffer })` supports `main|system|crash|events|all|radio|kernel`;
  HTTP routes accept `?buffer=`, and the `apk_vm` tool accepts `buffer`.
- Verified `npm test` and the client smoke suite with the new debug controls.

## 0.3.3

Physical/remote adb device switching.

### Added

- `AndroidVm.listDevices()` reports emulator, USB/physical and network adb devices with
  state/model/product/transport metadata.
- `GET /apk-vm/devices` and `POST /apk-vm/device` (`{"serial":…}` / `{"serial":""}`) attach an
  online device or restore the managed AVD identity; the Environment card has a device picker
  with Attach/Detach.
- `apk_vm` actions `devices`, `attach_device`, `detach_device`.
- Stop/dispose never sends `emu kill` or disconnects an external physical device.

### Verified

- Attached the running emulator as an external device and detached back to `dsh_apk` while
  retaining `ready`; `/apk-vm/devices` returns serial/state/kind/model.

## 0.3.2

Artifact download for screenshots/recordings.

### Added

- `GET /apk-vm/artifacts?name=…` streams a plugin-created screenshot/recording from the OS temp
  dir with a strict basename whitelist (no arbitrary paths).
- The panel's Record action now auto-downloads the MP4 after `screenrecord` completes.

## 0.3.1

Loopback-only VM API by default.

### Security

- Every `/apk-vm/*` HTTP route and the WebSocket upgrade now reject clients whose TCP peer is
  not loopback unless `allowRemote: true` is explicitly configured. Exposing the DSH Web UI on
  the LAN no longer automatically exposes the rooted debug API.
- Documented the reverse-proxy/LAN threat model and `allowRemote` opt-in.

## 0.3.0

Production lifecycle + management layer.

### Added

- **Instance lifecycle:** extra VMs expose `owner` / `lastUsedAt` / `idleMs`; an idle reaper stops
  extras after `instanceIdleMs` (default 15 min) when no panel frames, H.264 clients or Agent
  commands are active. AVDs are kept for quick reuse. New **VM instances** panel card with
  owner/idle and Stop/Destroy actions.
- **Installed-app management:** panel card lists third-party packages for the active instance and
  exposes force-stop / clear-data / uninstall (backed by the existing rooted debug routes).
- **Agent high-level input:** `apk_vm` actions `tap`, `swipe`, `long_press`, `key`, `text` with
  device-coordinate validation and the same per-instance routing as shell/debug actions.
- Hermetic `spike/instances-smoke.mjs` lifecycle test + CI step.

### Verified

- `apk_vm key HOME`, `tap 360,1180`, `long_press 360,1180,600ms`, `text "dsh"` all succeeded on the
  default VM via an isolated subagent.
- `/apk-vm/instances` returns owner/idle metadata; lifecycle unit test passes.

## 0.2.4

Fix H.264 input coordinate mapping.

### Fixed

- H.264 frames are downscaled (540×960) but `input tap` expects the guest display
  coordinate space (720×1280). The client previously sent video coordinates directly, so a tap
  at YuAgent (device ~446,1014 → video ~334,760) landed in the Phone icon. Input mapping now
  always uses `wm size` (swapped when rotated) while video dimensions only control the canvas
  aspect.
- Clicking icons in the H.264 view now hits the intended app.

## 0.2.3

Fix H.264 WebSocket target in the DSH desktop shell.

### Fixed

- The desktop shell can load the panel from a custom scheme where `location.host` is empty or
  meaningless; the client previously fell back to a hard-coded stale localhost port, so the
  H.264 WebSocket never connected and the panel stayed on the 1–2 fps PNG path.
- `/apk-vm/state` now returns the server's real origin; the client derives `ws://`/`wss://` from
  it. WebSocket close/decoder errors are also included in the client capability report.
- Header continues to show the active transport (`H.264` vs `PNG`).

## 0.2.2

Stream-mode visibility / diagnostics.

### Added

- The header frame-rate badge now shows the transport: `FPS 59.0 · H.264` or `FPS 1.5 · PNG`,
  so a low FPS is no longer ambiguous.
- Client capability report (`POST /apk-vm/client-report`) records the client build, WebCodecs
  availability and `avc1` support in `/apk-vm/state.client`; the panel shows a fallback hint
  when H.264 is unsupported in the current WebView.

## 0.2.1

Per-instance H.264 for multi-agent VMs.

### Added

- **Every extra instance now has its own H.264/WebCodecs stream** (`lib/video-stream.js`,
  `ScrcpyStream`): independent scrcpy server, free local port, init/AVCC/keyframe handling,
  rotation re-init and idle stop. Extra instances are created with a 720×1280 display
  (instead of the pixel_5 1080×2340 profile) so several GPU encoders stay stable.
- Extra instance WebSocket endpoint: `/apk-vm/instances/<id>/ws`; panel instance selector now
  shows H.264 canvas for extras too, with PNG fallback.

### Fixed

- Earlier 0.2.0 extra instances used PNG preview; larger AVD resolutions could stall the
  emulator GPU when combined with a second scrcpy encoder. 720×1280 + per-instance stream is
  stable.

### Verified

- Extra instance (emulator-5560, 720×1280): H.264 init `540×960`, **412 packets/10 s** with the
  60Hz animation app; extra frame PNG and default VM remained responsive; destroy returns to
  default only.

## 0.2.0

Multi-agent / multi-instance support.

### Added

- **Multiple concurrent VMs.** `InstanceManager` (`lib/instances.js`) creates isolated instances
  with their own AVD, emulator console port, snapshot and AndroidVm state. The first Agent gets
  the default VM; later Agents are assigned isolated instances automatically (up to
  `maxInstances`, default 3 extra).
- HTTP instance API: `GET/POST /apk-vm/instances`, `DELETE /apk-vm/instances/:id`, and a
  per-instance namespace `/apk-vm/instances/:id/{state,frame,vm,input,install,upload,debug/*}`.
- Panel instance selector + **New VM / Destroy VM** actions; extra instances use PNG preview
  (H.264 remains on the default VM).
- `apk_vm` Agent tool: `instance` parameter, per-Agent assignment, and
  `list_instances` / `create_instance` / `destroy_instance` / `start` / `stop` actions.
- `multiInstance` + `maxInstances` config; release version 0.2.0.

### Verified

- Two VMs run concurrently: default `emulator-5558` and extra `emulator-5560`
  (`dsh_apk_test1`), both ready/root, extra frame PNG and root shell verified while default
  remained ready. Extra instance cold boot ~27.5 s, later quick boot from its own snapshot.

## 0.1.0

First open-source release.

### Added

- Sidebar `apk-vm` entry + main panel, optional `dsh-better-sidebar` tab.
- AOSP Android Emulator lifecycle with quick-boot snapshot, host GPU, hypervisor detection.
- H.264/WebCodecs stream up to 60 fps over `/apk-vm/ws`; PNG screencap fallback.
- Rooted guest debug surface: auto `adb root`, on-device toolkit, `/apk-vm/debug/*` HTTP API,
  `apk_vm` Agent tool (shell/logcat/props/packages/install/push/pull/reboot/root/rotate/
  ui_dump/record/perf/screenshot/actions).
- One-glance Environment card + `/apk-vm/setup`: cross-platform SDK/adb/emulator/system image/
  AVD/acceleration detection, AVD creation, opt-in system-image download.
- APK upload by button or drag-and-drop (`/apk-vm/upload`, 500 MiB limit, ZIP magic check).
- Multi-AVD list/switch (`/apk-vm/avds`, `/apk-vm/avd`).
- Same-origin guard for HTTP routes and WebSocket upgrades; bounded bodies/outputs; argv-only
  child processes.
- Apache-2.0 LICENSE/NOTICE, CONTRIBUTING, SECURITY, GitHub Actions CI, issue/PR templates,
  README/demo script.

### Known limitations

- Windows x64 is the only end-to-end verified host; macOS/Linux discovery is tested hermetically.
- Static screens naturally show a low FPS (encoder emits on change); audio and physical-device
  switching are roadmap items.
