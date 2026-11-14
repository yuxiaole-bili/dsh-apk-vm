# Demo & verification script

This file is the reproducible demo script behind `docs/demo.gif` and the screenshots referenced
in [README.md](README.md). `docs/demo.gif` is checked in (720×1280, 28 s, 3.2 MiB); the commands
below re-produce it and the screenshots on a Windows reference host (AEHD + AOSP Android 14).
Do not invent numbers — copy them from the outputs.

## Install (local link)

```powershell
# from the DSH profile that can use plugin_manager
plugin_manager install_bundle target=<path-to-repo>
# or, if the bundle is already linked:
plugin_manager set_plugin target=include:dsh-apk-vm enabled=true
```

Refresh the DSH page after installing the client half.

## 30-second demo flow

1. Open **APK Virtual Machine** in the sidebar.
2. Expand **Environment** — on a cold host the card shows **Setup needed** and the `autoSetup`
   chain starts automatically (Temurin JDK → SDK command-line tools → packages → system image →
   AVD, roughly 2.5 GB on the first run). On a provisioned host it shows SDK/adb/emulator/system
   image/AVD/acceleration all green.
3. Press **Start VM** (or just open the panel with `autoStart` on). Show the measured boot label
   (`quick N s` / `cold N s`).
4. **Upload APK** or drag a file onto the panel. The app installs and launches; the phone frame
   switches to the H.264 canvas.
5. Expand **Rooted debug**: run `id -u; getprop ro.build.version.release`; click **UI tree**,
   **Perf**, **Record 5s**, **Rotate**, **Screenshot**.
6. Drive the VM through the HTTP API or the `apk_vm` tool (see
   [examples/agent-workflow.mjs](examples/agent-workflow.mjs)), then open the sidebar
   **Agent activity** card: it shows the tool-call timeline (action, ok/error, duration,
   instance, screenshot thumbnails) recorded by the plugin.
7. Interact with the phone frame, then note the live `FPS` reading in the header. A static home
   screen has a low frame rate because scrcpy only emits frames on change; use an animated app or
   a scroll gesture for the 60 fps path.

Useful companion commands (same origin, local only):

```powershell
$base = 'http://127.0.0.1:<dsh-port>'
Invoke-RestMethod "$base/apk-vm/setup" | ConvertTo-Json -Depth 6
Invoke-RestMethod "$base/apk-vm/avds"
Invoke-RestMethod "$base/apk-vm/debug/info"
Invoke-RestMethod "$base/apk-vm/debug/perf"
Invoke-RestMethod "$base/apk-vm/debug/ui" | Select-Object nodes,bytes,rotation
```

Raw APK upload (500 MiB limit, ZIP magic checked, same-origin route):

```powershell
curl.exe -sS -X POST -H "x-apk-name: anim60.apk" `
  --data-binary "@apk-vm-preview\spike\android\anim60.apk" `
  "$base/apk-vm/upload"
```

60 fps stream smoke test (no browser needed; counts H.264 packets):

```powershell
cd apk-vm-preview
node spike/android/ws-stream-test.mjs
```

Expected on the reference host with the 60 Hz test app in the foreground: ~59 fps raw packets,
first `init` in about 1 s, `width`/`height` matching the current orientation.

## Recording the media

- `docs/demo.gif` — 28 s, 720×1280, 3.2 MiB (checked in). Captured from the guest, not the host
  UI: start a guest-side `screencap` loop (raw frames land under `/data/local/tmp`), drive the
  storyboard (home screen → sample APK install/launch → tap → 60 fps animation), pull the frames,
  then assemble them with the repository's dependency-free encoder:

  ```powershell
  # 100 raw frames captured on the guest into C:\apk-vm-frames\ (raw screencap dumps)
  node scripts/make-demo-gif.mjs --in C:\apk-vm-frames --out docs/demo.gif `
    --scale 1 --fps 3.6 --colors 96 --palette global
  ```

  Raw dumps are either the classic 12-byte header (`width`, `height`, `format`, then RGBA) or
  the 16-byte variant some AVD images emit (same header plus four extra bytes); the encoder
  detects the layout from the file size. A `--scale 0.5` produces a smaller mobile-friendly
  file; `--colors 128 --palette local` improves gradients at a slightly larger size.
- `docs/screenshot-panel.png`: main panel with the Environment, APK files, ownership, Activity
  and Rooted debug cards plus the phone frame (checked in).
- `docs/screenshot-activity.png`, `docs/screenshot-device.png`, `docs/screenshot-environment.png`,
  `docs/screenshot-apk-files.png`, `docs/screenshot-debug.png`: close-ups of the cards and the
  guest (checked in).
- `docs/demo.gif`: the loop itself — home screen → sample APK installed and driven through the
  HTTP API → 60 fps animation in the guest (checked in; see the command above).
- Screenshots are captured from the 0.12.0 UI with demo data only; the Windows user name, real
  APK names/paths and the assistant avatar are masked with Gaussian blur (Pillow) before
  publishing. Re-capture them from your own host before publishing new ones; keep the same
  720–1280 px / PNG style.

## Acceptance checklist

- [ ] Environment card reports Ready on a host with SDK + image + AVD + acceleration.
- [ ] On a cold host the `autoSetup` chain runs to Ready and the VM starts without manual steps.
- [ ] Upload and drag-drop both install and launch an APK.
- [ ] Phone frame uses `<canvas>` (H.264) when WebCodecs is available; PNG fallback otherwise.
- [ ] Header FPS changes when the guest screen animates.
- [ ] Rooted debug shell returns `uid=0(root)`; rotate/ui_dump/perf/record/screenshot work.
- [ ] The **Agent activity** card lists the `apk_vm` calls from the examples/tool run, with
  screenshots for mutating actions.
- [ ] Cross-origin request to `/apk-vm/*` is rejected (`403`).
- [ ] Quick boot measured under 30 s after the snapshot exists.

## Notes

- Windows x64 is the only end-to-end verified host so far. macOS/Linux SDK discovery is covered by
  `spike/setup-smoke.mjs` but the emulator path is not end-to-end tested upstream.
- Emulator integration tests require nested virtualization; keep them on a local Windows machine
  (see `.github/workflows/ci.yml` for the headless CI checks).
