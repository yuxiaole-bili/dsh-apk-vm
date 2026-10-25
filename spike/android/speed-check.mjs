#!/usr/bin/env node
/**
 * Fast-boot acceptance check for the APK VM backend.
 *
 * Run after Windows has rebooted with the AEHD driver active (or on any host
 * with a usable hypervisor / attached device):
 *
 *   node spike/android/speed-check.mjs                # cold boot, save snapshot, report
 *   node spike/android/speed-check.mjs --quick        # start again via the saved snapshot
 *   node spike/android/speed-check.mjs --keep         # leave the emulator running afterwards
 *
 * It prints bootKind, bootMs, accel and gpuMode; the target for the quick-boot
 * path is under 30 seconds. The AVD arguments mirror the installed plugin config.
 */
import { AndroidVm } from '../../lib/android.js';

const argv = new Set(process.argv.slice(2));
const vm = new AndroidVm({
  sdkRoot: process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '<android-sdk>',
  emulatorPath: '<android-sdk>\\emulator\\emulator.exe',
  avdName: 'dsh_apk',
  port: 5558,
  bootTimeoutMs: 10 * 60 * 1000,
  gpuMode: 'host',
  accel: 'auto',
  quickBoot: true,
  snapshotName: 'default_boot',
  saveSnapshotAfterBoot: true,
  log: (line) => {
    if (/spawning emulator|boot completed|snapshot|acceleration/.test(line)) console.log(`[vm] ${line}`);
  },
});

const t0 = Date.now();
try {
  await vm.start();
  const status = await vm.status();
  const wallMs = Date.now() - t0;
  console.log(
    JSON.stringify(
      {
        ok: status.state === 'ready',
        state: status.state,
        bootKind: status.bootKind,
        bootMs: status.bootMs,
        wallMs,
        accel: status.accel,
        gpuMode: status.gpuMode,
        snapshotAvailable: status.snapshotAvailable,
        serial: status.serial,
        error: status.error,
        quickBootPath: status.bootKind === 'snapshot',
        under30s: status.bootMs !== null && status.bootMs < 30000,
      },
      null,
      2,
    ),
  );
  if (status.state === 'ready') {
    await vm.saveSnapshot();
    console.log('[vm] snapshot saved for the next quick boot');
  }
} catch (error) {
  console.error('[speed-check] error:', error && error.message ? error.message : error);
  process.exitCode = 1;
} finally {
  if (!argv.has('--keep')) {
    await vm.dispose();
    console.log('[vm] disposed (pass --keep to leave it running)');
  }
}
