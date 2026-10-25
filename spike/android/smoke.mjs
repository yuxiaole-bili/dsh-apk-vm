/**
 * spike/android/smoke.mjs — HERMETIC off-device verification for lib/android.js.
 *
 * This suite must never touch a real adb device (a running AVD/VM belongs to the
 * Lead/panel). All device-facing checks therefore inject a fake empty `adb`
 * boundary, except connect() which only talks to a dead TCP port (127.0.0.1:1).
 *
 * Covers: import/construct, default status, no-device error paths, boot-wait timeout,
 * APK discovery over the workspace, aapt2 badging inspection, input validation,
 * bounded logTail, dispose idempotency.
 *
 *   cd <path-to-repo>
 *   node spike/android/smoke.mjs
 *
 * Exit code 0 = all checks passed. On-device coverage lives in device.mjs and
 * mock-device.mjs (mock-adb critical path).
 */

import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { AndroidVm } from '../../lib/android.js';

const SPIKE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SPIKE_DIR, '..', '..');
const SAMPLE_APK = path.join(SPIKE_DIR, 'sample.apk');
const WORKSPACE_ROOT = path.resolve(PLUGIN_ROOT, '..');

function result(stdout, { code = 0, stderr = '', timedOut = false } = {}) {
  return {
    code,
    signal: timedOut ? 'SIGKILL' : null,
    timedOut,
    truncated: false,
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? '')),
    stderr,
  };
}

/** Fake adb boundary that reports an empty device list — hermetic, never real. */
function emptyAdb() {
  return async (args) => {
    if (args[0] === 'devices') return result('List of devices attached\n\n');
    return result('', { code: 1, stderr: `hermetic smoke: unexpected adb call ${args.join(' ')}` });
  };
}

/** AndroidVm instance with a hermetic empty-adb boundary (no real device access). */
function noDeviceVm(options = {}) {
  const vm = new AndroidVm({ pollIntervalMs: 250, bootTimeoutMs: 2000, ...options });
  vm._adb = emptyAdb();
  return vm;
}

const checks = [];
async function check(name, fn) {
  const startedAt = performance.now();
  try {
    await fn();
    checks.push({ name, ok: true, ms: Number((performance.now() - startedAt).toFixed(1)) });
    console.log(`PASS ${name} (${(performance.now() - startedAt).toFixed(1)} ms)`);
  } catch (error) {
    checks.push({ name, ok: false, ms: Number((performance.now() - startedAt).toFixed(1)), error: error.message });
    console.log(`FAIL ${name}\n     ${error && error.stack ? error.stack.split('\n').slice(0, 3).join('\n     ') : error}`);
  }
}

async function main() {
  // --- module import / construction -----------------------------------------
  await check('constructor resolves adb path and default status is stopped', async () => {
    const plain = new AndroidVm();
    assert.equal(typeof plain.status, 'function');
    assert.equal(typeof plain.connect, 'function');
    assert.equal(typeof plain.waitBooted, 'function');
    assert.match(plain.adbPath, /adb(\.exe)?$/i);

    const vm = noDeviceVm();
    const status = await vm.status();
    assert.equal(status.state, 'stopped');
    assert.equal(status.serial, null);
    assert.equal(status.avd, null);
    assert.equal(status.bootMs, null);
    assert.equal(status.error, null);
    assert.ok(Array.isArray(status.logTail));
    await vm.dispose();
  });

  // --- start() reports a clear error when no device is available ------------
  await check('start() without device/emulator config stores an actionable error', async () => {
    const vm = noDeviceVm();
    await vm.start();
    const status = await vm.status();
    assert.equal(status.state, 'error');
    assert.match(status.error, /No Android device available/);
    assert.ok(status.logTail.some((line) => line.includes('[vm]')), 'logTail contains state lines');
    await vm.dispose();
  });

  // --- waitBooted() times out without throwing ------------------------------
  await check('waitBooted(1200) times out cleanly and records error', async () => {
    const quick = noDeviceVm({ pollIntervalMs: 250, bootTimeoutMs: 1200 });
    const snapshot = await quick.waitBooted(1200);
    assert.equal(snapshot.state, 'error');
    assert.match(snapshot.error, /timed out/i);
    assert.ok(snapshot.logTail.length > 0);
    await quick.dispose();
  });

  // --- APK discovery over the workspace (no device needed) ------------------
  let discovered = [];
  await check(`listApks over ${WORKSPACE_ROOT}`, async () => {
    const vm = new AndroidVm();
    discovered = await vm.listApks([WORKSPACE_ROOT]);
    assert.ok(Array.isArray(discovered));
    for (const apk of discovered) {
      assert.equal(typeof apk.path, 'string');
      assert.equal(typeof apk.name, 'string');
      assert.ok(apk.size > 0);
      assert.match(apk.mtime, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(apk.path.toLowerCase().endsWith('.apk'));
    }
    assert.ok(discovered.length >= 1, `expected >=1 APK under ${WORKSPACE_ROOT}, found ${discovered.length}`);
    assert.ok(discovered.some((apk) => apk.name === 'sample.apk'), 'sample.apk discovered');
  });

  // --- aapt2 badging inspection (no device needed) --------------------------
  await check('inspectApk(sample.apk) parses package/label/launchActivity', async () => {
    const sampleStat = await fsp.stat(SAMPLE_APK).catch(() => null);
    assert.ok(sampleStat && sampleStat.isFile(), `sample APK missing at ${SAMPLE_APK}`);
    const metadata = await new AndroidVm().inspectApk(SAMPLE_APK);
    assert.deepEqual(metadata, {
      packageName: 'com.example.dshspike',
      label: 'DSH Spike App',
      launchActivity: 'com.example.dshspike.MainActivity',
    });
  });

  // --- APK validation errors ------------------------------------------------
  await check('inspectApk rejects a missing file with a clear message', async () => {
    await assert.rejects(
      () => new AndroidVm().inspectApk(path.join(SPIKE_DIR, 'does-not-exist.apk')),
      /APK not found/,
    );
  });

  // --- device-free method failures -----------------------------------------
  await check('device methods reject with a clear message when no device exists', async () => {
    const vm = noDeviceVm();
    await assert.rejects(() => vm.screenSize(), /no Android device is online/i);
    await assert.rejects(() => vm.screenshot(), /no Android device is online/i);
    await assert.rejects(() => vm.installApk(SAMPLE_APK), /no Android device is online/i);
    await assert.rejects(() => vm.launchPackage('com.example.dshspike'), /no Android device is online/i);
    await assert.rejects(() => vm.input({ type: 'tap', x: 10, y: 20 }), /no Android device is online/i);
    await vm.dispose();
  });

  await check('input() rejects invalid payloads before touching adb', async () => {
    const vm = noDeviceVm();
    await assert.rejects(() => vm.input(null), /requires an object payload/);
    await assert.rejects(() => vm.input({ type: 'tap', x: 'nope', y: 1 }), /finite numeric/);
    await assert.rejects(() => vm.input({ type: 'wat' }), /unsupported input type/);
    await vm.dispose();
  });

  // --- connect() failure path (real adb, dead port only) --------------------
  await check('connect() to a dead host throws with adb detail', async () => {
    const doomed = new AndroidVm({ connectTimeoutMs: 4000, commandTimeoutMs: 6000 });
    await assert.rejects(() => doomed.connect('127.0.0.1:1'), /adb connect|timed out|unauthorized/i);
    const status = await doomed.status();
    assert.equal(status.error !== null, true);
  });

  // --- bounded logTail ------------------------------------------------------
  await check('logTail is bounded by maxLogLines', async () => {
    const bounded = noDeviceVm({ maxLogLines: 5, pollIntervalMs: 100, bootTimeoutMs: 400 });
    await bounded.waitBooted(400);
    const snapshot = await bounded.status();
    assert.ok(snapshot.logTail.length <= 5, `logTail length ${snapshot.logTail.length} <= 5`);
    await bounded.dispose();
  });

  // --- dispose() is safe and idempotent ------------------------------------
  await check('dispose() is idempotent and leaves state stopped', async () => {
    const vm = noDeviceVm();
    await vm.dispose();
    await vm.dispose();
    const status = await vm.status();
    assert.equal(status.state, 'stopped');
    await assert.rejects(() => vm.start(), /disposed/);
  });

  // --- report ---------------------------------------------------------------
  const failed = checks.filter((entry) => !entry.ok);
  console.log('\n--- summary ---');
  console.log(`checks: ${checks.length}, passed: ${checks.length - failed.length}, failed: ${failed.length}`);
  console.log(`apks found under ${WORKSPACE_ROOT}: ${discovered.length}`);
  for (const apk of discovered.slice(0, 10)) {
    console.log(`  ${apk.name}  ${apk.size} bytes  mtime=${apk.mtime}`);
  }
  const slowest = [...checks].sort((a, b) => b.ms - a.ms).slice(0, 3);
  console.log(`slowest checks: ${slowest.map((entry) => `${entry.name}=${entry.ms}ms`).join(', ')}`);
  console.log(`adbPath=${new AndroidVm().adbPath}`);
  console.log('hermetic: device-facing calls used an injected empty adb; real adb only for connect(dead port)');
  if (failed.length > 0) {
    console.error('\nFAILURES:');
    for (const entry of failed) console.error(`- ${entry.name}: ${entry.error}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('smoke.mjs crashed:', error);
  process.exitCode = 1;
});
