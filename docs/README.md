# Demo and screenshot assets

Real assets captured from the reference host:

- `screenshot-panel.png` — the main APK VM panel: Environment card, Android guest (H.264
  11.7 fps in this capture), input controls and debug surface.
- `screenshot-sidebar.png` — the plugin open in the DSH right sidebar next to a session, with
  the host's APK paths redacted.

Still optional:

- `demo.gif` — 20–30 s recording: open panel → Environment check → VM boot → upload APK → 60 fps
  interaction. Record on a real host and keep it under ~8 MiB.

The assets are not fabricated. Before adding a new screenshot, crop out or redact the DSH
sidebar conversation names, local paths and any LAN IPs.

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

