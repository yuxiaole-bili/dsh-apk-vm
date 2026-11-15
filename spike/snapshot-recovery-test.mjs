// Hermetic checks for the quick-boot snapshot self-healing helpers.
//
// These exercise AndroidVm._snapshotPresent()/_quarantineSnapshot() against a
// throwaway AVD home, so no emulator (and no real ~/.android) is involved.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AndroidVm } from '../lib/android.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'apk-vm-snapshot-recovery-'));
process.env.ANDROID_AVD_HOME = path.join(root, 'avd');
const avdHome = process.env.ANDROID_AVD_HOME;
const avdName = 'dsh_snapshot_test';
const avdDir = path.join(avdHome, `${avdName}.avd`);
const snapDir = path.join(avdDir, 'snapshots', 'default_boot');

function makeVm() {
  return new AndroidVm({ avdName, quickBoot: true, snapshotName: 'default_boot', spawnEmulator: false });
}

function writeSnapshot({ pbSize = 4096, ramSize = 256 * 1024 * 1024, pbAgeMs = 0, ramAgeMs = 0 } = {}) {
  rmSync(snapDir, { recursive: true, force: true });
  mkdirSync(snapDir, { recursive: true });
  const pb = path.join(snapDir, 'snapshot.pb');
  const ram = path.join(snapDir, 'ram.bin');
  writeFileSync(pb, Buffer.alloc(pbSize, 1));
  writeFileSync(ram, Buffer.alloc(ramSize, 2));
  const now = Date.now();
  utimesSync(ram, new Date(now - ramAgeMs), new Date(now - ramAgeMs));
  utimesSync(pb, new Date(now - pbAgeMs), new Date(now - pbAgeMs));
  return { pb, ram };
}

try {
  mkdirSync(avdDir, { recursive: true });

  // No snapshot at all.
  rmSync(snapDir, { recursive: true, force: true });
  assert.equal(makeVm()._snapshotPresent(), false, 'missing snapshot is not present');

  // Healthy snapshot: pb slightly newer than ram (normal save order).
  writeSnapshot({ pbAgeMs: 0, ramAgeMs: 5000 });
  assert.equal(makeVm()._snapshotPresent(), true, 'healthy snapshot is present');

  // Partially written snapshot: pb much newer than ram.
  writeSnapshot({ pbAgeMs: 0, ramAgeMs: 60 * 60 * 1000 });
  const suspicious = makeVm();
  assert.equal(suspicious._snapshotPresent(), false, 'stale ram with fresh pb is rejected');
  assert.match(String(suspicious._snapshotSuspicion || ''), /newer than ram\.bin/, 'suspicion is recorded');

  // Tiny ram.bin means a truncated/crashed save.
  writeSnapshot({ ramSize: 1024 * 1024 });
  assert.equal(makeVm()._snapshotPresent(), false, 'truncated ram is rejected');

  // Quarantine moves the directory aside and records recovery metadata.
  writeSnapshot({ pbAgeMs: 0, ramAgeMs: 5000 });
  const vm = makeVm();
  const quarantined = vm._quarantineSnapshot('corrupt');
  assert.ok(quarantined && existsSync(quarantined), 'quarantine path exists');
  assert.equal(existsSync(snapDir), false, 'original snapshot dir was moved');
  assert.equal(vm._snapshotPresent(), false, 'quarantined snapshot is gone');
  assert.ok(vm._snapshotRecovery && vm._snapshotRecovery.quarantinedPath === quarantined, 'recovery metadata recorded');
  assert.match(path.basename(quarantined), /^default_boot\.corrupt-\d{14}$/, 'quarantine name is timestamped');
  assert.ok(statSync(quarantined).isDirectory(), 'quarantine is a directory');

  // Quarantining again is a no-op (nothing to move).
  assert.equal(vm._quarantineSnapshot('corrupt'), null, 'second quarantine is a no-op');

  // status() surfaces the recovery record (no device probes needed for this shape).
  const status = vm._snapshot();
  assert.ok(status.snapshotRecovery && status.snapshotRecovery.reason === 'corrupt', 'snapshotRecovery is exposed');

  console.log('SNAPSHOT RECOVERY TESTS PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
