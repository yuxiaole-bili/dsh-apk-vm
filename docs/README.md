# Demo and screenshot assets

Real assets captured from the reference host:

- `screenshot-panel.png` — APK VM panel header + Android guest at H.264 32.8 fps, cropped to
  remove the DSH sidebar and personal conversation list.
- `screenshot-setup.png` — Environment card reporting a ready host (cropped to the header row).
- `screenshot-emulator.png` — raw Android guest screenshot (launcher); contains no host paths or
  private network data.

Still optional:

- `demo.gif` — 20–30 s recording: open panel → Environment check → VM boot → upload APK → 60 fps
  interaction. Record on a real host and keep it under ~8 MiB.

The assets are not fabricated. Before adding a new screenshot, crop out the DSH sidebar,
conversation names, local paths and any LAN IPs.
