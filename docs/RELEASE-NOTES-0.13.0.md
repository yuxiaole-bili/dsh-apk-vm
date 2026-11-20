# dsh-apk-vm 0.13.0

Ownership release: dedicated VMs are now truly reserved.

VM leases are persisted to `<profile>/.apk-vm/leases.json`, so a
`conversation`/`project` VM stays reserved for its owner across DSH
restarts (default reservation: 24 h, `leaseReservationTtlMs`). Takeovers are
explicit: a lease held by another owner reports the owner short id and
reservation deadline, the panel keeps that VM read-only and offers a
**Take over** button, and admin mutations without an explicit takeover are
rejected with `vm-takeover-required` (`x-apk-vm-takeover: 1`). `force: true` is
now accepted as an alias for `ownerForce: true`, and every claim, release and
takeover is journaled with the previous and incoming owner.

Chinese summary: 0.13.0 是归属管理版本。VM 租约现在持久化到
`<profile>/.apk-vm/leases.json`，专属（conversation/project）VM 在 DSH 重启后仍保留给原
owner（默认保留 24 小时，`leaseReservationTtlMs`）。接管必须显式：被他人占用的租约会在 409
响应中带上 owner 短 id 与保留截止时间，面板对其他 owner 保持只读并提供「接管」按钮，没有
显式接管的管理员变更会返回 `vm-takeover-required`（`x-apk-vm-takeover: 1`）。`force: true`
现在是 `ownerForce: true` 的别名，claim/release/takeover 都会写入活动日志（含前后 owner）。

此外，默认虚拟机现在是**常驻共享**的：释放租约不会释放/删除 VM；空闲 5 分钟（`sharedSuspendAfterMs`）
后挂起到快速启动快照（状态 `suspended`，约 6 秒恢复），再空闲 1 小时（`sharedStopAfterMs`）后标记为
`stopped`，快照与 AVD 始终保留；工具/面板/视频流活动会重置计时并按需恢复。

- **VM operation locks.** `lock_vm` / `unlock_vm` (or the panel Lock/Unlock buttons) turn the
  current owner's lease into a hard lock: every mutating request from another agent or the
  panel is rejected with `409 vm-locked`, and `ownerForce`/takeover cannot break it. A local
  admin can force-unlock. Locks are persisted with the lease and shown in the owner card.
  `lockEnforcement: all|agents|off` and `lockControl: all|user` tune the policy (the default
  `all`/`all` keeps the hard lock for everyone and lets any agent or the panel lock).

0.13.0 还新增「虚拟机操作锁」（并支持 `lockEnforcement: all|agents|off`、`lockControl: all|user` 配置）：owner 可以 lock_vm/面板锁定，锁定期间其他 Agent 与面板的变更请求返回 409 vm-locked，ownerForce/接管也无法绕过，只有锁所有者或本地管理员可解锁。

## Added

- **Persistent leases.** Leases are written to `<profile>/.apk-vm/leases.json` on every claim,
  release and touch, and restored on the next plugin start; the default VM's owner is restored
  with them.
- **Reserved dedicated VMs.** `conversation`/`project` leases carry a `reservedUntil` deadline
  (`leaseReservationTtlMs`, default 24 h). While reserved they cannot be claimed by another owner
  without `ownerForce: true`; after expiry the lease is dropped and the VM can be claimed again.
- **Explicit takeover in the panel and over HTTP.** A foreign reservation shows the owner short id
  and deadline; the panel offers **Take over** and admin mutations require
  `x-apk-vm-takeover: 1` (or the panel button) or fail with `409 vm-takeover-required`.
- **`force` alias.** `apk_vm` accepts `force: true` in addition to `ownerForce: true`, and the
  `vm-busy` / `vm-takeover-required` messages say so.
- **Owner attribution in the activity journal.** Entries carry `owner` (`key`, `label`, `scope`,
  `role`) and claim/release/takeover transitions are recorded with the previous and incoming owner.
- **Resident shared default VM.** The default VM is never released or deleted. After
  `sharedSuspendAfterMs` idle (default 5 minutes) it suspends into its quick-boot snapshot (state
  `suspended`, about 6 seconds to resume); after `sharedStopAfterMs` (default 1 hour) it is marked
  `stopped` with the snapshot and AVD kept. Tool calls, panel actions and video clients reset the
  idle timer and a later start resumes it on demand.
- **Storage cleanup for crash debris and orphans.** `GET /apk-vm/storage` reports quarantined
  corrupt snapshot backups, emulator crash dumps and `totals.reclaimableBytes`; `POST
  /apk-vm/storage` gained `corrupt-snapshots` and `crash-dumps` (both `confirm: true`), and the
  Storage card shows the reclaimable amount with cleanup buttons.
- **Destructive-action confirmations.** `destroy_instance` requires `confirm: true`, the
  instance DELETE route requires `?confirm=1`, and the panel Delete button asks for a second
  click.

## Changed

- `POST /apk-vm/ownership` only forces when the request body sets `force: true`; the panel no
  longer force-claims implicitly.
- `forOwner()` reuses a restored persisted lease before scheduling a new VM, so a restarting
  conversation gets its old VM back instead of a fresh one.
- **Bounded tool waits.** An action that has to boot the VM fails after about 120 s (explicit
  `start`: 180 s, `timeoutMs` override) instead of blocking for the 1200 s boot timeout; the VM
  keeps booting. `maybeAutoStart` skips a VM in a crash loop.

## Fixed

- An explicit `claim_vm` now redirects later implicit tool calls. Previously a session that claimed
  the default VM could keep operating a previously assigned extra instance because the agent
  mapping was not updated; claims now update the mapping for the conversation, project and shared
  scopes, so the next call without an `instance` argument resolves to the claimed VM.
- The activity journal records the VM that actually served the call instead of the requested
  instance id (which defaulted to `default` when omitted), so such mismatches are visible.

- A `ReferenceError: recordOwnershipAction is not defined` broke takeovers started from
  `apk_vm` tool calls and the `/apk-vm/ownership` HTTP route (the journal helper was defined
  inside the route mount scope). The helper now lives at plugin scope, so takeovers are
  recorded again.
- The Windows emulator can crash (status `0xC0000005`) while writing or shortly after writing a
  quick-boot snapshot. Snapshot saves are tracked now: a `start` that arrives during a save
  waits for it to finish, a crash that follows a save disables further quick-boot saving, and
  the partially written snapshot is quarantined and the boot retried once as a cold boot.
- Incomplete quick-boot snapshots are quarantined before launch and the plan uses
  `-no-snapshot-load` for a cold boot, so a corrupt snapshot cannot crash-loop the emulator.
- **Crash-loop breaker:** three non-zero emulator exits within 15 minutes pause automatic
  recovery/auto-start and disable snapshot saving; the reason is visible in the state error and
  logTail so the VM can be started manually after inspecting the crash dump.
- `spike/storage-clean-test.mjs` covers corrupt-snapshot/crash-dump accounting, reclaimable
  totals and safe cleanup.

## Verification

- `npm run check` — exit 0 (`check-version: ok (0.13.0)`).
- `npm test` — full suite, including the extended ownership tests (reservations, admin takeover
  gate, persisted leases restored across a simulated restart) and owner attribution in the
  activity-log tests.
- `node scripts/privacy-scan.mjs --untracked` — clean.
- `node --check lib/android.js` passes; the crash-after-save recovery path is triggered by the
  Windows emulator itself (qemu access violation), so it is not reproducible as a deterministic
  unit test — the log lines to look for are `crashed shortly after a quick-boot snapshot save`,
  `quarantined snapshot after crash` and `retrying with a cold boot`.
- Live check on Windows/AEHD: claims, panel takeover and dedicated-VM reuse were exercised against
  the running default VM.

## Known issues

- The reservation length is a fixed 24 h; there is no per-request override yet.
- A lease restored after a restart points at the instance id, but a local AVD that no longer exists
  is recreated on demand (it keeps the same instance id).
- Ownership changes made outside the plugin (killing the emulator, deleting the AVD) are not
  journaled.

## Install

```bash
dsh plugin --profile web add dsh-apk-vm@0.13.0
```

DSH Desktop: Plugins → add/install local bundle, or `plugin_manager` with the npm package
`dsh-apk-vm@0.13.0`.

Upgrading from 0.12.5 or earlier needs no data migration; existing AVDs, snapshots, remembered
APKs and remote profiles are reused. The lease file is optional and is recreated on demand.
