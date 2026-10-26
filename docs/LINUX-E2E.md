# Linux end-to-end validation

A real headless Linux run was performed on Ubuntu 22.04.5 LTS (kernel 6.8, x86_64),
using the plugin's own `AndroidVm` and `ScrcpySession` code. This is not a mock or a
CI-only check.

## Host

| Item | Value |
| --- | --- |
| OS | Ubuntu 22.04.5 LTS, x86_64 |
| CPU | 192 cores, KVM v12 (`/dev/kvm` usable) |
| RAM | 94 GiB |
| Display | none (`DISPLAY` unset) |
| Node | v24.22.1 |
| Java | OpenJDK 17 JRE |
| Android SDK | cmdline-tools 12.0, platform-tools 37.0.1, emulator 37.2.12.0, build-tools 34.0.0 |
| System image | `system-images;android-34;default;x86_64` |
| AVD | `dsh_linux_test` (1080×2340, pixel_5) |

The regular `OPENCODE` account is **not in the `kvm` group** and has no passwordless sudo;
`/dev/kvm` is denied for it. The emulator portion was therefore run as the provided
`OPENCODE_100` account (same SSH key), which is in the `kvm` group. The plugin itself never
requires sudo or system-wide changes.

## Emulator launch

```text
qemu-system-x86_64-headless -avd dsh_linux_test -no-window -no-audio -no-boot-anim \
  -no-snapshot -gpu swiftshader_indirect -port 5558
```

- KVM detected: **`accel=true`**
- Cold boot: **35.2 s** (first run 49.0 s)
- adb serial: `emulator-5558`, API 34, userdebug, 1080×2340
- `adb root`: **uid=0**

## Verified on Linux

- `AndroidVm` lifecycle: start → attach → boot probe → ready; state and boot time.
- `adb root` and the on-device debug toolkit.
- Real signed APK install + auto-launch; UIAutomator dump; input tap; result text assertion.
- PNG screenshot (`exec-out screencap -p`, 46,650 bytes in 415 ms).
- HTTP proxy set / clear.
- CA certificate installation (`73393196.0`, user CA store).
- `ScrcpySession` 5.0.1 H.264: `avc1.42C029`, 332×720, 30 media packets, 1 keyframe,
  9,057-byte capture; scrcpy control swipe produced new video.
- `screenrecord` 3 s MP4.
- `stop()` safety: a pre-existing/auto-attached emulator is left running, not killed.

## Test suite

On the validated snapshot:

- `npm run check` — pass
- `npm test` — pass (UI/sidebar, setup 32/32, mock-device 25/25, launch-plan, instances,
  features 4/4)
- `spike/scrcpy/test-fake-device.js` — 160/160 pass

The final tree should be re-run in CI for the release tag.

## Known limitations

- `quickBoot` snapshots were not exercised on Linux (tests used `-no-snapshot` to save disk).
- Headless `swiftshader_indirect` can print non-fatal `ColorBuffer` warnings while taking
  screenshots; the screenshots still succeed.
- The emulator prints a metrics-collection warning; the launch args now include
  `-no-metrics`.
- `OPENCODE` without `kvm` group membership gets the documented "No usable CPU hypervisor"
  error instead of a hung boot. Add the user to `kvm` (or use an account that has it) for
  hardware acceleration.
- The platform still requires an Android SDK and AVD; only the SDK install and test harness
  were performed as a separate account on this shared host.

## Cross-platform status

| Platform | Status |
| --- | --- |
| Windows x64 | end-to-end verified (AEHD, live panel, H.264, Agent tool) |
| Linux x86_64 | end-to-end verified headless (KVM + SwiftShader, H.264, root, APK install) |
| macOS | SDK discovery + headless CI only; no live emulator run in this repository |
