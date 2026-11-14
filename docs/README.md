# Demo and screenshot assets

Real assets captured from the reference host (0.12.0 panel UI, demo APK only). Private host
details — the Windows user name, real APK names/paths and the assistant avatar — are masked with
Gaussian blur:

- `screenshot-panel.png` — the main APK VM panel: Environment card, APK files, VM ownership,
  Activity card, rooted debug surface and the live H.264 Android guest with its control bar.
- `screenshot-activity.png` — the Activity card: agent + user operations, newest first, with action
  badges, source badges (Agent/User/System), durations and screenshot thumbnails.
- `screenshot-device.png` — the Android 14 guest running the sample APK on the H.264 canvas.
- `screenshot-environment.png` — the Environment self-check card on a provisioned host (SDK, JDK,
  hardware acceleration, system image, AVD all green).
- `screenshot-apk-files.png` — the APK files card with remembered installs.
- `screenshot-debug.png` — the Rooted debug toolbox (adb shell, logs, UI tree, perf, record,
  rotate, clipboard, appops).
- `demo.gif` — 28 s loop (720×1280, 3.1 MiB): home screen → sample APK installed and driven
  through the HTTP API → 60 fps animation in the guest. Reproducible from the guest-side
  screencap loop in [`../DEMO.md`](../DEMO.md); `scripts/make-demo-gif.mjs` re-encodes it.

The assets are not fabricated. Before adding a new screenshot, crop out or mask the DSH sidebar
conversation names, local paths and any LAN IPs (Gaussian blur is enough; the raw panel already
hides credentials and APK file paths are blur-friendly demo data).

## Reproducible demo source

[`examples/`](../examples/README.md) contains a self-contained, dependency-free demo:

- a tiny MIT-licensed sample APK whose sources and deterministic SDK-only build script are
  checked in (`examples/sample-apk/`),
- `examples/demo.mjs`, which drives the documented local HTTP API through state → install →
  UI inspection → tap → text assertion → screenshot,
- exact commands, expected output and troubleshooting in
  [`examples/README.md`](../examples/README.md).

The sample screenshot at [`examples/sample-app.png`](../examples/sample-app.png) is the app
running in the VM, not a desktop capture.
