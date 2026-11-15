# dsh-apk-vm 0.12.4

Hotfix for 0.12.3: the boot-speed bookkeeping refactor dropped three AndroidVm
constructor initialisers, which made hypervisor detection report "none" on hosts
where AEHD/WHPX work fine. Every VM start failed with a bogus
"No usable CPU hypervisor (AEHD/WHPX) was found" error.

## Fixed

- **Restored `_accelAvailable`, `_snapshotSave` and `_lastLaunchArgs`
  initialisers** in the AndroidVm constructor. `_accelAvailable` stayed
  `undefined`, so `_detectAcceleration()` short-circuited on `!== null` and
  returned `undefined`; the start path treated that as "no hypervisor" and
  aborted with the fatal TCG message instead of booting the emulator.
- **Regression test.** `spike/snapshot-recovery-test.mjs` now asserts the three
  fields start as `null` and that `_detectAcceleration()` returns a boolean and
  caches its result.

## Verification

- Live: the reference Windows/AEHD host that reproduced the failure now starts
  the default VM again (cold boot and quick-boot both verified).
- `npm run check` — exit 0 (`check-version: ok (0.12.4)`).
- `npm test` — exit 0 across the full suite.
- `node scripts/privacy-scan.mjs --untracked` — clean.

## Install

```bash
dsh plugin --profile web add dsh-apk-vm@0.12.4
```

DSH Desktop: Plugins → add/install local bundle, or `plugin_manager` with the
npm package `dsh-apk-vm@0.12.4`.

If you installed 0.12.3, upgrade to 0.12.4; no data migration is required.
