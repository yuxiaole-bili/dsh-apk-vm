/**
 * spike/android/device.mjs — on-device verification for lib/android.js.
 *
 * Requires a live adb-reachable Android runtime (QEMU/Android-x86 VM, AOSP emulator,
 * or USB device). Exercises the critical path: attach/connect, boot wait, screen size,
 * PNG screenshot, tap/swipe/key/text input, APK discovery, aapt2 badging, and
 * (with --install) apk install + launch + screenshot.
 *
 *   cd <path-to-repo>
 *   node spike/android/device.mjs --serial 127.0.0.1:5555
 *   node spike/android/device.mjs --serial 127.0.0.1:5555 --install --boot-timeout 300000
 *
 * Defaults: attach to the first online adb device; never stops/disconnects the VM
 * unless --stop is passed (so the Lead's VM keeps running).
 */

import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { AndroidVm } from '../../lib/android.js';

const SPIKE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_APK = path.join(SPIKE_DIR, 'sample.apk');
const FRAME_1 = path.join(SPIKE_DIR, 'frame.png');
const FRAME_2 = path.join(SPIKE_DIR, 'frame-after-tap.png');

function parseArgs(argv) {
  const options = { serial: null, install: false, stop: false, bootTimeout: 20 * 60 * 1000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--serial') options.serial = argv[++index] || null;
    else if (arg === '--install') options.install = true;
    else if (arg === '--stop') options.stop = true;
    else if (arg === '--boot-timeout') options.bootTimeout = Number(argv[++index]) || options.bootTimeout;
  }
  return options;
}

const results = [];
async function step(name, fn) {
  const startedAt = performance.now();
  try {
    const value = await fn();
    results.push({ name, ok: true, ms: Number((performance.now() - startedAt).toFixed(1)) });
    console.log(`PASS ${name} (${(performance.now() - startedAt).toFixed(1)} ms)`);
    return value;
  } catch (error) {
    results.push({ name, ok: false, ms: Number((performance.now() - startedAt).toFixed(1)), error: error.message });
    console.log(`FAIL ${name}\n     ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n     ') : error}`);
    return undefined;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const vm = new AndroidVm({
    serial: args.serial,
    bootTimeoutMs: args.bootTimeout,
    connectTimeoutMs: Math.min(args.bootTimeout, 60_000),
    log: (line) => process.stdout.write(`[vm] ${line}\n`),
  });
  console.log(`adb=${vm.adbPath} serial=${vm.serial || '(first online device)'}`);

  // 1. status + attach
  const before = await step('status() before start', () => vm.status());
  console.log('  ', JSON.stringify(before));

  if (before.state !== 'ready') {
    if (args.serial) {
      await step('connect(serial)', async () => {
        const snapshot = await vm.connect(args.serial);
        assert.equal(snapshot.error, null);
        return snapshot;
      });
    }
    const booted = await step(`waitBooted(${args.bootTimeout}ms)`, () => vm.waitBooted(args.bootTimeout));
    assert.equal(booted.state, 'ready', `VM not ready: ${booted.state} ${booted.error || ''}`);
    console.log('  ', JSON.stringify(booted));
  }

  const ready = await vm.status();
  assert.equal(ready.state, 'ready', `expected ready, got ${ready.state}: ${ready.error || ''}`);
  console.log(`  serial=${ready.serial} bootMs=${ready.bootMs}`);

  // 2. screen size
  const size = await step('screenSize()', async () => {
    const value = await vm.screenSize();
    assert.ok(Number.isInteger(value.width) && value.width > 0, `bad width ${value.width}`);
    assert.ok(Number.isInteger(value.height) && value.height > 0, `bad height ${value.height}`);
    return value;
  });
  console.log('  ', size);

  // 3. screenshots
  const shot = await step('screenshot() -> frame.png (PNG signature)', async () => {
    const startedAt = performance.now();
    const buffer = await vm.screenshot();
    const latencyMs = Number((performance.now() - startedAt).toFixed(1));
    assert.ok(Buffer.isBuffer(buffer), 'screenshot() must return a Buffer');
    assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.deepEqual([...buffer.subarray(buffer.length - 8, buffer.length - 4)], [...Buffer.from('IEND')]);
    await fsp.writeFile(FRAME_1, buffer);
    assert.ok((await fsp.stat(FRAME_1)).size > 1000, 'PNG suspiciously small');
    return { bytes: buffer.length, latencyMs };
  });
  console.log('  ', shot);

  // 4. input injection (tap center, then a swipe + key + text sanity)
  let width = size ? size.width : 360;
  let height = size ? size.height : 640;
  await step('input({type:"tap"}) center', async () => {
    const result = await vm.input({ type: 'tap', x: Math.floor(width / 2), y: Math.floor(height / 2) });
    assert.deepEqual(result, { ok: true });
  });
  await step('input({type:"swipe"})', async () => {
    const result = await vm.input({
      type: 'swipe',
      x1: Math.floor(width * 0.5),
      y1: Math.floor(height * 0.8),
      x2: Math.floor(width * 0.5),
      y2: Math.floor(height * 0.3),
      durationMs: 400,
    });
    assert.deepEqual(result, { ok: true });
  });
  await step('input({type:"key"}) HOME', async () => {
    assert.deepEqual(await vm.input({ type: 'key', key: 'HOME' }), { ok: true });
  });
  await step('input({type:"text"})', async () => {
    assert.deepEqual(await vm.input({ type: 'text', text: 'dsh vm probe' }), { ok: true });
  });
  await step('input() rejects invalid payloads', async () => {
    await assert.rejects(() => vm.input({ type: 'tap', x: 'nope', y: 1 }), /finite numeric/);
    await assert.rejects(() => vm.input({ type: 'swipe' }), /finite numeric/);
    await assert.rejects(() => vm.input({ type: 'wat' }), /unsupported input type/);
  });

  // 5. second screenshot after input
  await step('screenshot() after input -> frame-after-tap.png', async () => {
    const buffer = await vm.screenshot();
    await fsp.writeFile(FRAME_2, buffer);
    return { bytes: buffer.length };
  });

  // 6. APK discovery + inspection
  await step('listApks([plugin root])', async () => {
    const apks = await vm.listApks([path.resolve(SPIKE_DIR, '..', '..')]);
    assert.ok(Array.isArray(apks));
    console.log(`   found ${apks.length} APK(s): ${apks.slice(0, 5).map((apk) => `${apk.name} (${apk.size}B)`).join(', ')}`);
    return apks;
  });
  await step('inspectApk(sample.apk)', async () => {
    const metadata = await vm.inspectApk(SAMPLE_APK);
    assert.equal(metadata.packageName, 'com.example.dshspike');
    console.log('  ', JSON.stringify(metadata));
    return metadata;
  });

  // 7. optional install + launch + screenshot of the installed app
  if (args.install) {
    const installed = await step('installApk(sample.apk) (+auto launch)', async () => {
      const metadata = await vm.installApk(SAMPLE_APK);
      assert.equal(metadata.packageName, 'com.example.dshspike');
      return metadata;
    });
    console.log('  ', installed);
    await step('launchPackage() explicitly', () =>
      vm.launchPackage('com.example.dshspike', 'com.example.dshspike.MainActivity'));
    await step('screenshot() after launch -> frame-app.png', async () => {
      const buffer = await vm.screenshot();
      await fsp.writeFile(path.join(SPIKE_DIR, 'frame-app.png'), buffer);
      return { bytes: buffer.length };
    });
    await step('launchPackage() rejects bad input', async () => {
      await assert.rejects(() => vm.launchPackage('bad package!', 'x'), /invalid package name/);
    });
  }

  // 8. lifecycle
  const finalStatus = await vm.status();
  console.log('final status:', JSON.stringify({ ...finalStatus, logTail: finalStatus.logTail.slice(-12) }, null, 2));

  if (args.stop) {
    await step('stop()', async () => {
      const snapshot = await vm.stop();
      assert.equal(snapshot.state, 'stopped');
      return snapshot;
    });
  } else {
    await step('dispose() without stopping the VM (--stop not passed)', async () => {
      // dispose() would stop/disconnect the VM, so only smoke-test it on a throwaway
      // instance that was never attached; the real VM is left running for the panel.
      const scratch = new AndroidVm();
      await scratch.dispose();
      const snapshot = await scratch.status();
      assert.equal(snapshot.state, 'stopped');
    });
  }

  const failed = results.filter((entry) => !entry.ok);
  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.log('\n--- summary ---');
  console.log(`steps: ${results.length}, passed: ${results.length - failed.length}, failed: ${failed.length}`);
  console.log(`slowest: ${slowest.map((entry) => `${entry.name}=${entry.ms}ms`).join(', ')}`);
  if (shot) console.log(`screenshot: ${shot.bytes} bytes, ${shot.latencyMs} ms`);
  if (size) console.log(`screen: ${size.width}x${size.height}`);
  if (failed.length > 0) {
    for (const entry of failed) console.error(`- ${entry.name}: ${entry.error}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('device.mjs crashed:', error);
  process.exitCode = 1;
});
