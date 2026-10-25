# scrcpy 5.0.1 headless relay — spike assets

Everything here supports the plugin's low-latency screen/control transport:
`vendor/scrcpy-server-v5.0.1.jar` runs on the Android device; `../../lib/scrcpy.js` is the
dependency-free Node relay that talks to it (no SDL, no FFmpeg, no npm packages).

| path | what it is |
| --- | --- |
| `PROTOCOL.md` | byte-level v5.0.1 wire protocol, read from the vendored sources below |
| `vendor/scrcpy-server-v5.0.1.jar` | official server artifact, sha256 `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536` (= GitHub release-asset digest) |
| `vendor/release-v5.0.1.json` | GitHub releases API record for the tag (asset sizes + sha256 digests) |
| `vendor/SHA256SUMS.txt` | upstream checksum listing (if fetched; the API digest already matches the jar) |
| `vendor/scrcpy-v5.0.1-src.tar.gz` | upstream source tarball (codeload, tag `v5.0.1`) |
| `src/scrcpy-5.0.1/` | extracted `app/` (C client), `server/` (Java server), `doc/develop.md`, `LICENSE` — the protocol was read from here, no guessing |
| `test-fake-device.js` | protocol unit tests + full end-to-end `ScrcpySession` test against a fake scrcpy-server speaking the real TCP protocol; writes `report.json` |
| `capture.js` | real-device capture test; writes `capture.h264` + `report.json` |
| `capture-fake.h264` | Annex-B H.264 captured from the fake device (structure check) |
| `report.json` | latest test results (fake-device verification + real-device capture status) |

## How to run

```powershell
cd <path-to-repo>

# protocol + fake-device end-to-end test (no device needed)
node spike/scrcpy/test-fake-device.js

# real device (waits until adb reports an online device)
node spike/scrcpy/capture.js --serial emulator-5558 --packets 60 --wait-ms 300000
# or, for a QEMU/Android-x86 device reachable over TCP:
node spike/scrcpy/capture.js --serial 127.0.0.1:5555
```

`capture.js` options: `--adb <path>` (default `<android-sdk>\platform-tools\adb.exe`),
`--serial`, `--port` (default 27183), `--packets` (default 60), `--wait-ms`, `--max-size`,
`--bit-rate`, `--transport forward|reverse`, `--timeout-ms`.

## Notes

- The relay uses `adb forward tcp:<port> localabstract:scrcpy_<scid>` plus
  `tunnel_forward=true` on the server (same wire behaviour as the scrcpy client fallback).
  `transport: 'reverse'` is implemented too, but `adb reverse` does not work over
  `adb connect`-style TCP devices — forward is the safe default.
- Audio is disabled (`audio=false`) and clipboard autosync is disabled
  (`clipboard_autosync=false`): the relay consumes only H.264 video and sends input.
- Touch coordinates are **video-frame pixels** of the current session (e.g. 720-px-wide stream),
  not `adb wm size` device pixels. The server maps them through its `PositionMapper`.
- The server sends SPS/PPS once per encoder session; `lib/scrcpy.js` caches them and exposes
  `getVideoConfig()` so a decoder attaching later still gets avcC + codec string.
- Apache-2.0: see `src/scrcpy-5.0.1/LICENSE`. The jar is redistributed unmodified.
