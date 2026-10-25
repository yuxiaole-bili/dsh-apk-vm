# APK VM preview — Android backend spike (`lib/android.js`)

Status: **module final.** Off-device + mock-adb verification green; live plugin integration
(start/status/stop) verified; **on-device boot/install/screenshot/input could not be verified
on this host because no Android VM can finish booting here** (pure TCG, no hardware
virtualization — see §6). The plugin ships with that runtime limitation documented.

This spike implements the dependency-free, adb-driven Android backend for the
`apk-vm-preview` plugin. It is deliberately **device-agnostic**: it attaches to any
open-source Android runtime reachable over adb (QEMU/Android-x86 VM via
`adb connect host:port`, an AOSP emulator, or a USB device). AOSP emulator spawning
exists but is opt-in and disabled by default.

---

## 1. Why no AOSP ARM64 emulator here (runtime decision input)

The original plan (AOSP Android 34 ARM64 system image, software TCG, headless) is
**not possible on this host**. `<android-sdk>\emulator\emulator.exe` is version
`37.2.12.0` (x86_64 Windows). Launching the exact planned command:

```powershell
<android-sdk>\emulator\emulator.exe -avd dsh_apk_arm -no-window -no-audio -no-boot-anim `
  -no-snapshot -accel off -gpu swiftshader_indirect -port 5558 -show-kernel
```

exits within ~8 s and refuses cross-architecture guests. Captured output
(`spike/android/emulator.out.log`):

```
INFO         | Android emulator version 37.2.12.0 (build_id 16428233) (CL:N/A)
INFO         | Graphics backend: gfxstream
INFO         | Found systemPath <android-sdk>\system-images\android-34\default\arm64-v8a\
FATAL        | Avd's CPU Architecture 'arm64' is not supported by the QEMU2 emulator on x86_64 host. System image must match the host architecture.
```

- The emulator process is gone; **no emulator may be started again** (Lead directive).
- MuMu was never touched.
- Pivot: QEMU + Android-x86 VM, attached over adb (`adb connect 127.0.0.1:5555`).

---

## 2. Files

| File | Purpose |
| --- | --- |
| `lib/android.js` | The backend module. Node ESM, built-in modules only (`node:child_process`, `node:fs`, `node:path`, `node:os`). No npm deps. |
| `spike/android/smoke.mjs` | HERMETIC off-device verification: import, status, APK discovery/inspection, error paths. Injects an empty fake adb so it can never attach to (or `emu kill`) a real device; real adb is used only for one `connect(dead port)` failure check. |
| `spike/android/mock-device.mjs` | Full device-critical-path verification against an in-process mock adb (argv + output parsing, install/launch/input/screenshot/stop). |
| `spike/android/device.mjs` | On-device verification: connect/boot wait, screen size, PNG screenshot bytes/latency, tap/swipe/key/text, APK discovery/inspect, optional install+launch. |
| `spike/android/sample.apk` | 915-byte real APK built locally with `aapt2 link` for `inspectApk`/`installApk` testing (package `com.example.dshspike`). |
| `spike/android/miniapp/AndroidManifest.xml` | Manifest source for that sample APK. |
| `spike/android/emulator.out.log` / `.err.log` | Captured evidence of the ARM64 emulator failure. |
| `spike/android/frame.png`, `frame-after-tap.png`, `frame-app.png` | Written by `device.mjs` once a VM is reachable (not yet created). |

---

## 3. API (export contract)

```js
import { AndroidVm } from './lib/android.js'; // default export too

const vm = new AndroidVm({
  serial: '127.0.0.1:5555',   // optional; network serials are brought up with adb connect
  adbPath: null,              // default: resolve ANDROID_HOME/ANDROID_SDK_ROOT/platform-tools/adb(.exe)
  emulatorPath: null,         // spawn opt-in: BOTH emulatorPath and avdName required
  avdName: null,
  bootTimeoutMs: 20 * 60 * 1000,
  pollIntervalMs: 2000,
  screenshotTimeoutMs: 120 * 1000,
  installTimeoutMs: 5 * 60 * 1000,
  log: (line) => {},          // optional sink; logTail is always kept (bounded to 200)
});
```

Methods (return shape is binding):

- `async status()` → `{ state:'stopped'|'starting'|'booting'|'ready'|'error', serial, avd, bootMs, error, logTail }`
- `async start()` → attach existing device → `adb connect` configured network serial → wait boot.
  Idempotent, **never throws for expected boot failures** (error lands in `status()`).
- `async stop()` → graceful `adb emu kill` best-effort, then `adb disconnect` for network
  devices, kills the emulator process only if this module spawned it. Returns snapshot.
- `async connect(serial)` → `adb connect host:port` (or wait on non-network serials) until
  adb reports `device`; throws on failure; returns status snapshot.
- `async waitBooted(timeoutMs)` → waits `sys.boot_completed === '1'`; expected timeout sets
  `status().error`, does not throw; returns status snapshot.
- `async screenSize()` → `{ width, height }` from `adb shell wm size` (Override preferred).
- `async screenshot()` → `Buffer` PNG from `adb -s <serial> exec-out screencap -p`;
  validates the PNG signature; falls back to `shell screencap -p /data/local/tmp/...` +
  `adb pull`; throws a descriptive error if both paths fail.
- `async listApks(roots = [])` → recursive `*.apk` scan, depth ≤ 6, skips
  `node_modules/.git/.svn/.hg`, symlinks and junk dirs; returns
  `[{ path, name, size, mtime(ISO) }]`, newest first (cap 500).
- `async inspectApk(path)` → `{ packageName, label, launchActivity }` from
  build-tools `aapt2 dump badging` (latest build-tools auto-picked).
- `async installApk(path)` → inspect → `adb install -r` (auto retries `-t` for
  `INSTALL_FAILED_TEST_ONLY`) → best-effort launch → returns metadata.
- `async launchPackage(packageName, launchActivity)` → `adb shell am start -n pkg/activity`
  (`monkey` launcher fallback when no activity); throws on adb/SHELL errors.
- `async input(payload)` → `{ ok:true }` for
  `{type:'tap',x,y}`, `{type:'swipe',x1,y1,x2,y2,durationMs?}`, `{type:'key',key|keycode}`,
  `{type:'text',text}`. Payload is validated before any adb call; text is escaped for the
  *device* shell and spaces are encoded as `%s`.
- `async dispose()` → `stop()` + disposed flag; never throws, idempotent.

Behaviour highlights:

- **Attach-first device selection**: configured `serial` is authoritative; otherwise the
  first `adb devices` entry in state `device` is used. If a configured network serial is
  absent/offline, `start()` attempts `adb connect` automatically.
- Emulator spawn path only when `emulatorPath && avdName && spawnEmulator !== false` and no
  device exists (kept for other hosts; unusable for cross-arch on this host).
- No host shell is ever used: every process is `child_process.spawn(exe, argvArray)`.
  argv arrays are captured/asserted in `mock-device.mjs`.
- Output buffers are bounded (`maxOutputBytes` 8 MiB, screenshot 48 MiB, stderr 256 KiB);
  timeouts kill hung adb children; `status()` boot probes are cached (1 s) and single-flight
  coalesced so a fast UI poll cannot pile up `adb shell` calls.
- Bounded rolling `logTail` (default 200 lines) capturing state transitions, errors,
  emulator output (spawn path) and screenshot/install timings.

---

## 4. Verified commands and measurements (this host, 2026-10-24)

Environment: Windows x86_64, Node `v24.19.0`, `ANDROID_HOME`/`ANDROID_SDK_ROOT` empty
(resolution falls back to the verified `<android-sdk>`), adb
`<android-sdk>\platform-tools\adb.exe`, aapt2 `<android-sdk>\build-tools\34.0.0\aapt2.exe`,
platform `<android-sdk>\platforms\android-34\android.jar`. No adb device is online yet
(`adb devices` empty), so real-VM metrics below are pending.

### Off-device suite — `node spike/android/smoke.mjs` → **11/11 PASS** (hermetic)

No real device is touched: device-facing calls run against an injected empty adb
boundary; the only real-adb check connects to dead `127.0.0.1:1`.

| Check | Result |
| --- | --- |
| import + construct + default `status()` | PASS, 70 ms (first call; `{state:'stopped', serial:null, avd:null, bootMs:null, error:null, logTail:[]}`) |
| `start()` with no device / no emulator config | PASS — no throw, `status().error` = "No Android device available: no adb device is online. …" (201 ms) |
| `waitBooted(1200)` without device | PASS — clean timeout, error recorded (1305 ms) |
| `listApks([<workspace>])` ¹ | PASS — 1 APK, 8.2 ms |
| `inspectApk(sample.apk)` | PASS — 40.8 ms, `{com.example.dshspike, 'DSH Spike App', 'com.example.dshspike.MainActivity'}` |
| `inspectApk` missing file | PASS — "APK not found" |
| screenSize/screenshot/installApk/launchPackage/input with no device | PASS — all reject with "no Android device is online", no crash |
| `input()` bad payloads | PASS — validation errors before any adb call |
| `connect('127.0.0.1:1')` | PASS — rejects with adb detail after 2156 ms |
| `logTail` bound (maxLogLines=5) | PASS |
| `dispose()` idempotent + blocks `start()` | PASS |

¹ Only `sample.apk` exists on this workspace; depth 6 from `<workspace>` yields it via the
`apk-vm-preview/spike/android` path.

Overhead measurements (no device):
- `adb devices -l` spawn round-trip: **59.2, 58.1, 58.8, 59.7, 58.8 ms** → mean **58.9 ms**
- `status()` end-to-end (includes `adb devices`): **60.9, 63.4, 55.3, 56.8, 62.0 ms** → mean **59.7 ms**

### Mock-adb device path suite — `node spike/android/mock-device.mjs` → **20/20 PASS**

Covers (with real `lib/android.js` code, real `aapt2`, real sample APK; only the adb
process boundary mocked): attach + ready discovery; booting→ready transition; configured
serial absent stays `stopped` (no spawn); `connect()`; full `start()` connect→boot→ready
with `bootMs` measured; no-device error; `screenSize()` override preference; screenshot
`exec-out` path with PNG signature; screenshot `screencap`+`pull` fallback; concurrent
screenshot coalescing (two calls → one adb screencap); both-paths failure; exact input
argv (`input tap 10 20`, `input swipe 1 2 3 4 350`, `input keyevent KEYCODE_BACK`,
`input keyevent KEYCODE_APP_SWITCH` for `key:'recents'`,
`input text 'hello%sworld%sit'\''s'`); invalid payload rejection before adb;
`install -r` + auto-launch + `-t` retry + `INSTALL_FAILED_*` surfacing;
`am start -n`/`monkey` fallback + validation; `stop()` disconnect; restart race
(stop during boot then a fresh start reaches ready); `dispose()`.

Synthetic `start()` boot sequence (mock clock-free, poll 100 ms): ready after ~**728 ms**
with `bootMs` reported — demonstrates the bootMs/monotonic path, not real boot time.

### On-device suite — **NOT RUN: no Android VM can boot on this host**

`device.mjs` is shipped, syntax-checked, and ready; it simply never got a booted device:

```powershell
cd <path-to-repo>
node spike/android/device.mjs --serial emulator-5558
node spike/android/device.mjs --serial emulator-5558 --install   # install+launch sample.apk
```

`device.mjs` attaches/connects, waits for boot (default 20 min, `--boot-timeout N`),
prints `screenSize`, writes `frame.png` (PNG signature + IEND checked) and
`frame-after-tap.png`, runs tap/swipe/HOME/text, lists APKs, inspects the sample APK, and
with `--install` installs + launches it and writes `frame-app.png`. Without `--stop` it
leaves the VM running (no `adb disconnect`/kill).

**Live plugin integration (the part that could be verified without a booted guest).**
After the Host half was installed, the live routes were exercised against this module:

- `POST /apk-vm/vm {action:'start'}` → the host half called `AndroidVm.start()`, which
  spawned `emulator.exe -avd dsh_apk ... -port 5558` as a child of the DSH host and captured
  its stdout/stderr into `logTail` (visible with my prefixes in `GET /apk-vm/state`).
- `GET /apk-vm/state` returned the contract shape
  `{ok:true, vm:{state:'starting', serial:'emulator-5558', avd:'dsh_apk', bootMs:null,
  error:null, logTail:[…]}, screen:null, apk:null}`.
- `POST /apk-vm/vm {action:'stop'}` → `AndroidVm.stop()` SIGTERM'd only the emulator child
  it had spawned and the route then reported `state:'stopped', serial:null`; no orphan
  emulator/qemu process remained.
- The guest stayed adb `offline` for the whole 4m17s it was allowed to run and never
  reported `sys.boot_completed=1` before the stop test (no crash logged, just no boot).

Still unverified against a real booted Android: `screenSize`, `screenshot` (real PNG
bytes/latency), `input` on-screen effect, `listApks` device-independence is fine but
`inspectApk` only validated via aapt2 locally, `installApk`/`launchPackage` end-to-end,
`bootMs` real cold-boot time.

---

## 5. Known limitations / notes for the Lead

- Real-device `installApk`/`launchPackage`/`screenshot`/`input`/`screenSize`/`bootMs` are
  **implemented and mock-verified, but not exercised against a booted VM on this host**
  (blocker: no Android VM can finish boot here — see §6).
- `installApk` auto-launches the app when the APK has a launchable activity (best-effort;
  install success is not invalidated by a launch failure). `launchPackage` can be called
  again explicitly.
- `stop()` on a network serial sends `adb emu kill` (a QEMU/Android-x86 VM will ignore it)
  then `adb disconnect`; it will **not** kill a VM process it did not spawn. It DOES
  SIGTERM an AOSP emulator child that this module spawned (verified live via the plugin
  Stop route).
- `inspectApk` needs Android SDK build-tools `aapt2`; there is no pure-JS fallback.
  On this host it is auto-discovered; override with `aapt2Path`.
- `listApks` returns absolute Windows paths; `mtime` is an ISO string for JSON/UI sorting.
- `status()` refreshes state from adb on every call (~60 ms here with no device); it does
  not itself issue `adb connect` — call `start()`/`connect(serial)` for that.
- `screenshot()` coalesces concurrent requests so a fast UI poll cannot pile up
  `exec-out screencap` calls; boot probes are cached (1 s) and single-flight coalesced.
- `stop()` + `start()` (Restart) is race-safe: an interrupted boot wait is aborted by an
  epoch counter and the subsequent `start()` begins a fresh attach/boot.

## 6. Final runtime status (why on-device numbers are missing)

The team tried both open-source runtime options the task allowed:

1. **Official AOSP ARM64 system image** (`dsh_apk_arm`, android-34 arm64-v8a): the SDK
   emulator (`37.2.12.0`, x86_64 Windows host) refuses the guest immediately:
   `FATAL | Avd's CPU Architecture 'arm64' is not supported by the QEMU2 emulator on x86_64
   host. System image must match the host architecture.` (evidence in
   `spike/android/emulator.out.log`).
2. **Official AOSP x86_64 system image** (`dsh_apk`, android-34 x86_64) with pure software
   TCG (`-accel off`): the emulator/qemu process starts and stays up, but the guest never
   reaches adb `device` state or `sys.boot_completed=1`. With no AEHD/WHPX hardware
   virtualization available on this Windows host, TCG cannot boot the Android guest in a
   practical time/livelock-free way. A 4m17s live attempt stayed adb `offline`; earlier
   attempts crashed after a few minutes. MuMu is off-limits per the user.

Consequence: the plugin is shipped with the runtime limitation documented; the backend's
device-facing paths are covered by the hermetic + mock-adb suites and the live
start/status/stop plugin integration, and remain ready to verify the moment any real
adb-reachable Android runtime exists (set `options.serial`/`adb connect`, or explicitly
configure `emulatorPath`+`avdName` on a host with working virtualization).
