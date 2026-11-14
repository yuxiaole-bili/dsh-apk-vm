# dsh-apk-vm 0.12.1 — remote VM sessions, emulator inventory, virtual camera & microphone

**Release date:** 2026-11-14

0.12.1 focuses on driving Android VMs *elsewhere* and on making the guest's camera and microphone
useful without extra host setup.

## Highlights

- **Remote VM multi-session (远端多开).** Any SSH-reachable host can back multiple concurrent VM
  sessions, each with its own AVD, tunnel and H.264 stream. Validated profiles are stored under
  `<profile>/.apk-vm/remote-profiles.json` (never the key contents), and the panel lists saved
  profiles plus live sessions with per-session disconnect / disconnect-and-stop.
- **Available emulator inventory.** `GET /apk-vm/emulators` returns one merged table of local AVDs
  and devices plus every saved remote host's AVDs and adb devices; the panel shows the same data
  in an "Available emulators" card.
- **Virtual camera.** Camera back/front modes (`emulated`, `virtualscene`, `webcam`, `none`) and
  PNG/JPEG virtual-scene posters, configured through the panel Media card, `GET/POST
  /apk-vm/camera` or `cfg.camera`. Remote sessions upload the selected posters to
  `/tmp/apk-vm-media/<id>` over SSH.
- **Virtual microphone.** `off` / `host` (host input passthrough) / `file` (loop an audio file into
  a virtual PulseAudio source; Linux and remote hosts), configured through the panel Media card,
  `GET/POST /apk-vm/mic` or `cfg.mic`.
- **Panel UI refresh.** New plugin icon (layered lemon/green/violet screens), refreshed demo
  screenshots and a wide-screen three-column dashboard.

## Verification

- `npm run check` — clean (`node --check` on all 32 JS files).
- `npm test` — all suites pass (remote 45 checks, remote-instance 23, media 43, emulator-inventory
  36, plus the existing UI/Android/tool suites).
- `node scripts/privacy-scan.mjs --untracked` — clean (129 files).
- Real remote-host E2E against a private Linux host (`OPENCODE_100@<remote-host>`): camera poster upload + virtual mic
  started, remote headless emulator launched with `-virtualscene-poster` / `-allow-host-audio`
  (no `-no-audio`), session connected and streaming in ~4 s, frame PNG 583 KB, disconnect stopped
  the remote emulator and unloaded the PulseAudio source.
- Tested remote host: Ubuntu 22.04, Android 30 `google_apis` x86_64 image, AVDs `yuagent` and
  `yuagent_dsh2`, KVM acceleration.

## Limits

- A remote multi-session setup needs **one AVD per concurrent session** (Android requires
  `-read-only` on all emulators sharing an AVD).
- The virtual camera is not a file-to-camera bridge: it supports the emulator's virtual scene
  (with posters) and host webcams, not arbitrary video files.
- File-loop microphones need a Linux/PulseAudio host; on Windows only host passthrough is
  available. Camera/microphone changes apply to a running default VM only after a restart.
- The full cold-machine provisioning chain is covered by the partial-cold E2E run; a completely
  empty host still needs the host hypervisor/driver installed by the user.

## Install

- DSH plugin: `dsh plugin --profile web add dsh-apk-vm@0.12.1` (or update from the panel).
- npm: <https://www.npmjs.com/package/dsh-apk-vm>
- Source: <https://github.com/yuxiaole-bili/dsh-apk-vm>

## Known issues

- A just-attached remote instance can return one transient `409` from
  `/apk-vm/instances/<id>/frame` while its instance state flips to `ready`; the panel poll and the
  E2E harness retry automatically.

*No telemetry. Remote sessions are opt-in and only contact the SSH host you configure.*
