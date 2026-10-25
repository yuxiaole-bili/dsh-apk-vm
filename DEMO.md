# Demo & verification script

This file is the reproducible demo script behind `docs/demo.gif` and the screenshots referenced
in [README.md](README.md). No media is checked in yet; the commands below produce the real
artifacts on a Windows reference host (AEHD + AOSP Android 14). Do not invent numbers — copy them
from the outputs.

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
2. Expand **Environment** — show SDK/adb/emulator/system image/AVD/acceleration all green.
   The "Create AVD" action is offered when the image exists but the AVD does not.
3. Press **Start VM** (or just open the panel with `autoStart` on). Show the measured boot label
   (`quick N s` / `cold N s`).
4. **Upload APK** or drag a file onto the panel. The app installs and launches; the phone frame
   switches to the H.264 canvas.
5. Expand **Rooted debug**: run `id -u; getprop ro.build.version.release`; click **UI tree**,
   **Perf**, **Record 5s**, **Rotate**, **Screenshot**.
6. Interact with the phone frame, then note the live `FPS` reading in the header. A static home
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

- `docs/demo.gif`: record the flow above at ~1280 px width; trim to 20–30 s; keep file < 8 MiB.
- `docs/screenshot-panel.png`: main panel with the Environment + APK cards and the phone frame.
- `docs/screenshot-setup.png`: expanded Environment card on a green host.
- `docs/screenshot-debug.png`: expanded Rooted debug card with `ui_dump` / `perf` / record output.

## Acceptance checklist

- [ ] Environment card reports Ready on a host with SDK + image + AVD + acceleration.
- [ ] Upload and drag-drop both install and launch an APK.
- [ ] Phone frame uses `<canvas>` (H.264) when WebCodecs is available; PNG fallback otherwise.
- [ ] Header FPS changes when the guest screen animates.
- [ ] Rooted debug shell returns `uid=0(root)`; rotate/ui_dump/perf/record/screenshot work.
- [ ] Cross-origin request to `/apk-vm/*` is rejected (`403`).
- [ ] Quick boot measured under 30 s after the snapshot exists.

## Notes

- Windows x64 is the only end-to-end verified host so far. macOS/Linux SDK discovery is covered by
  `spike/setup-smoke.mjs` but the emulator path is not end-to-end tested upstream.
- Emulator integration tests require nested virtualization; keep them on a local Windows machine
  (see `.github/workflows/ci.yml` for the headless CI checks).
