# dsh-apk-vm 0.8.0

A larger sidebar workspace and debugging release.

## Highlights

- **Expand, float and grid** — full-window VM view, an in-app floating window, remembered
  expand state, double-click expand, `Esc` restore, and a multi-instance thumbnail grid.
- **One-click setup** — explicitly confirmed SDK tools + system image + AVD creation + start.
- **APK quick actions** — launch installed apps, validated deep links, grant/revoke permissions,
  stop/clear-data/uninstall, and `.aab` conversion via bundletool when available.
- **Named VM snapshots** — save, restore and delete per-AVD snapshots from the sidebar.
- **Passive clipboard only** — explicit “copy device clipboard to host” and “paste host clipboard
  to device” actions; no polling, listeners or background sync.
- **Network tools** — HAR import/summary/filter, pcap download, port forwards, DNS/hosts, proxy
  test, and isolated/shared modes.
- **UI checks** — UIAutomator assertions plus exact-byte screenshot baselines with JSON/Markdown
  reports and curl export for HAR requests.
- **Streaming controls** — 540p/30, 720p/60 and 960p/60 presets, quick rotate, first-boot hint,
  stale-client warning and remote adb `host:port` attach.

## Verification

- `npm run check` — pass
- `npm test` — all existing checks + AAB (15), HAR (8) and UI test (11) suites pass
- `node spike/ui-smoke.cjs` — pass
- privacy scan — clean (88 tracked files)
- live API checks on Android 14: state/version, named snapshot save/list/delete, HAR load/summary,
  UI check report, deep link, stream quality preset restart
- Windows/Linux paths remain separate; no local network or credentials in the package

## Notes / limits

- AAB requires a local `bundletool` executable, `BUNDLETOOL_JAR`, or a `bundletool*.jar` in `tools/`.
- Visual comparison is exact-byte SHA-256, not a pixel-diff image pipeline.
- Remote mode currently means an already reachable adb-over-TCP device; SSH provisioning is not
  automated.
- Clipboard is intentionally passive; there is no automatic host/device synchronization.
- `PiP` is an in-app floating phone window, not the OS-level Document Picture-in-Picture API.

## Install

```bash
dsh plugin --profile web add dsh-apk-vm
```

npm: <https://www.npmjs.com/package/dsh-apk-vm> (`0.8.0`)

## Artifact

- `dsh-apk-vm-0.8.0.tgz`
