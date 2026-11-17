# dsh-apk-vm 0.12.5

Reliability release for the zero-config first run and for multi-VM hosts.

Provisioning is now resilient to unreliable networks: every step retries with
exponential backoff, stalled downloads are cut by a 45 s no-progress watchdog,
the JDK archive resumes with HTTP Range and is checksum-verified on every
attempt, and mirrors/proxies can be configured for the command-line tools and
`sdkmanager`. A cumulative free-disk budget is checked before provisioning.

Multi-VM hosts get a memory guard, a Lite preset and instance management: the
effective instance cap is derived from host RAM, low-memory starts fail with an
actionable error (or reap an idle VM first), and `vmPreset: lite` shrinks the
guest to 1 GB RAM / 2 vCPU for 8–16 GB machines. The panel shows host memory,
the cap, the preset and each VM's RAM/vCPU profile.

Chinese summary: 0.12.5 是可靠性版本。零配置首次启动现在支持步骤级自动重试（指数退避）、
45 秒无进展看门狗、JDK 断点续传与每次校验、命令行工具/sdkmanager 的镜像与代理配置，以及
累计磁盘空间预检；多开场景新增内存守卫（按宿主机内存自动限制实例数、低内存拒绝启动或先回收
闲置 VM）、Lite 预设（1 GB 内存 / 2 vCPU / SwiftShader / 720p30）和实例面板显示。本版同时
加入了与英文同步的中文更新日志（`CHANGELOG.zh-CN.md`）。

## Added

- **Provisioning retries and stall watchdog.** `setupRetries` (default 3) and
  `retryDelayMs` (default 2000, exponential) retry each provisioning step; the
  JDK and command-line-tools downloads abort after 45 s without progress.
  `autoSetup.detail` now reports `attempt` and `nextDelayMs`, and the
  Environment card shows "retry n/m in Ns".
- **Download hardening.** The command-line-tools download streams with a stall
  timeout, size bound and optional SHA-256 (`commandLineToolsUrl`,
  `commandLineToolsSha256`); the JDK download resumes from `.partial` with HTTP
  Range and re-verifies the checksum; `sdkManagerArgs`, `sdkManagerEnv` and
  `networkProxy` (translated to `sdkmanager --proxy_*`) support mirrors and
  corporate proxies; `minFreeDiskBytes` (default 6 GB) is checked before
  provisioning.
- **Memory guard.** `lib/memory.js` derives the effective instance cap from
  host RAM (`memoryGuard`, `hostReserveMb` 4 GB, `estimatedVmMb` 3 GB; 8 GB →
  1, 16 GB → 3 with the default requested cap — a 16 GB desktop with an
  IDE/browser should keep `maxInstances` at 2 or use Lite). Low-memory local
  starts fail with a clear error, or
  `memoryPressureReap` stops an idle LRU VM first. The `memory` object is on
  `GET /apk-vm/state`, `/apk-vm/emulators`, `GET /apk-vm/instances` and
  `list_instances`.
- **Lite preset.** `vmPreset: lite` (1 GB RAM, 2 vCPU, SwiftShader, 720p30 H.264,
  1 fps PNG) applies to the default AVD and to extra instances.
- **Chinese changelog.** `CHANGELOG.zh-CN.md` mirrors the English changelog;
  release notes carry a Chinese summary.

## Verification

- `npm run check` — exit 0 (`check-version: ok (0.12.5)`).
- `npm test` — full suite, including the JDK download-stall watchdog case, the
  new memory tests and the UI smoke suite.
- `node scripts/privacy-scan.mjs --untracked` — clean.
- Live reference Windows/AEHD host: provisioning retry paths and the memory
  guard were exercised through the panel and HTTP API; the default VM still
  boots from its snapshot.

## Known issues

- The memory guard is an estimate based on host totals; it does not account for
  an externally started emulator and treats remote sessions as zero host RAM.
- Command-line-tools, SDK-package and system-image downloads retry the whole
  step (no mid-file resume); only the JDK archive resumes with Range.
- `/apk-vm/instances/<id>/frame` can still answer one 409 while a remote
  instance transitions to ready; panel polling recovers automatically.

## Install

```bash
dsh plugin --profile web add dsh-apk-vm@0.12.5
```

DSH Desktop: Plugins → add/install local bundle, or `plugin_manager` with the
npm package `dsh-apk-vm@0.12.5`.

Upgrading from 0.12.4 or earlier needs no data migration; existing AVDs,
snapshots, remote profiles and remembered APKs are reused.
