import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectStorage,
  cleanCorruptSnapshots,
  cleanCrashDumps,
  cleanOrphanAvds,
} from '../lib/storage.js';

let checks = 0;
function eq(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
  console.log('  ok', label);
}
function ok(value, label) {
  assert.ok(value, label);
  checks += 1;
  console.log('  ok', label);
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'apkvm-storage-'));
const avdRoot = path.join(root, 'avd');
const tempRoot = path.join(root, 'temp');

async function write(file, bytes) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, Buffer.alloc(bytes, 1));
}

async function main() {
  console.log('storage-clean: corrupt snapshots and crash dumps');
  await write(path.join(avdRoot, 'dsh_apk.avd', 'userdata-qemu.img'), 2048);
  await write(path.join(avdRoot, 'dsh_apk.avd', 'snapshots', 'default_boot.corrupt-20260101', 'ram.bin'), 2048);
  await write(path.join(avdRoot, 'dsh_apk_orphan.avd', 'userdata-qemu.img'), 4096);
  await write(path.join(avdRoot, 'dsh_apk_orphan.avd', 'snapshots', 'default_boot.bak-1', 'ram.bin'), 1024);
  await write(path.join(avdRoot, 'dsh_apk_orphan.ini'), 8);
  await write(path.join(avdRoot, 'dsh_apk_active.avd', 'userdata-qemu.img'), 512);
  await write(path.join(avdRoot, 'dsh_apk_active.avd', 'snapshots', 'default_boot.corrupt-1', 'ram.bin'), 128);
  await write(path.join(avdRoot, 'dsh_apk_active.avd', 'hardware-qemu.ini.lock'), 1);
  await write(path.join(avdRoot, 'dsh_apk_stale.avd', 'userdata-qemu.img'), 256);
  const staleLock = path.join(avdRoot, 'dsh_apk_stale.avd', 'hardware-qemu.ini.lock');
  await write(staleLock, 1);
  const staleTime = new Date(Date.now() - 20 * 60 * 1000);
  await fsp.utimes(staleLock, staleTime, staleTime);
  await write(path.join(tempRoot, 'AndroidEmulator', 'emu-crash-1.db', 'reports', 'x.dmp'), 4096);

  const report = await collectStorage({
    home: root,
    avdRoot,
    tempRoot,
    knownAvds: ['dsh_apk'],
    activeAvds: ['dsh_apk_active'],
  });
  ok(report.totals.corruptBytes >= 2048 + 1024 + 128, 'collectStorage: corrupt snapshot bytes');
  eq(report.crashDumps.length, 1, 'collectStorage: crash dumps');
  eq(report.totals.crashBytes, 4096, 'collectStorage: crash dump bytes');
  ok(report.totals.reclaimableBytes >= report.totals.corruptBytes + report.totals.crashBytes, 'collectStorage: reclaimable total');
  ok(report.avds.some((item) => item.name === 'dsh_apk_orphan' && item.orphan === true), 'collectStorage: orphan flagged');
  ok(report.recommendations.some((item) => item.code === 'corrupt-snapshots'), 'collectStorage: corrupt recommendation');
  ok(report.recommendations.some((item) => item.code === 'crash-dumps'), 'collectStorage: crash recommendation');

  const cleanedCorrupt = await cleanCorruptSnapshots({ avdRoot });
  eq(cleanedCorrupt.freedBytes, 2048 + 1024 + 128, 'cleanCorruptSnapshots: frees manageable snapshots');
  eq(await fsp.stat(path.join(avdRoot, 'dsh_apk.avd', 'snapshots', 'default_boot.corrupt-20260101')).then(() => true).catch(() => false), false, 'cleanCorruptSnapshots: removes corrupt dir');
  eq(await fsp.stat(path.join(avdRoot, 'dsh_apk_active.avd', 'snapshots', 'default_boot.corrupt-1')).then(() => true).catch(() => false), false, 'cleanCorruptSnapshots: removes corrupt backups even on an active AVD');

  const cleanedDumps = await cleanCrashDumps({ tempRoot });
  eq(cleanedDumps.freedBytes, 4096, 'cleanCrashDumps: frees crash dumps');
  eq(await fsp.stat(path.join(tempRoot, 'AndroidEmulator', 'emu-crash-1.db')).then(() => true).catch(() => false), false, 'cleanCrashDumps: removes crash dir');

  const cleanedOrphans = await cleanOrphanAvds({
    avdRoot,
    knownAvds: ['dsh_apk'],
    activeAvds: ['dsh_apk_active'],
  });
  eq(cleanedOrphans.removed.length, 2, 'cleanOrphanAvds: removes two orphans');
  eq(await fsp.stat(path.join(avdRoot, 'dsh_apk_orphan.avd')).then(() => true).catch(() => false), false, 'cleanOrphanAvds: orphan dir removed');
  eq(await fsp.stat(path.join(avdRoot, 'dsh_apk_stale.avd')).then(() => true).catch(() => false), false, 'cleanOrphanAvds: stale-lock AVD removed');
  eq(await fsp.stat(path.join(avdRoot, 'dsh_apk_active.avd')).then(() => true).catch(() => false), true, 'cleanOrphanAvds: active AVD kept');

  console.log(`storage-clean: ${checks} checks passed`);
}

try {
  await main();
} finally {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}
