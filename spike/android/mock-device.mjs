/**
 * spike/android/mock-device.mjs — exercises every adb-backed method of lib/android.js
 * against an in-process mock adb, so the device critical path is verified even before
 * the real QEMU/Android-x86 VM is reachable.
 *
 * What is REAL here: lib/android.js code, argument construction, output parsing,
 * aapt2 APK inspection (real binary + real sample.apk), PNG validation, state machine.
 * What is MOCKED: only the adb process boundary (`vm._adb`), returning realistic
 * `adb` responses and capturing every argv array for assertions.
 *
 *   cd <path-to-repo>
 *   node spike/android/mock-device.mjs
 */

import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { AndroidVm } from '../../lib/android.js';

const SPIKE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_APK = path.join(SPIKE_DIR, 'sample.apk');

// 1x1 transparent PNG.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function adbResult(stdout, { code = 0, stderr = '', timedOut = false } = {}) {
  return {
    code,
    signal: timedOut ? 'SIGKILL' : null,
    timedOut,
    truncated: false,
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? '')),
    stderr,
  };
}

/**
 * Build a mock adb. `world` fields drive behaviour; `calls` records every argv array.
 * `online` toggles the device list; `booted` drives getprop; etc.
 */
function createMockAdb(world = {}) {
  const state = {
    serial: '127.0.0.1:5555',
    online: true,
    deviceState: 'device',
    booted: true,
    bootProbeCount: 0,
    bootAfterProbes: 0,
    screenshotMode: 'png', // 'png' | 'garbage' | 'timeout' | 'fail'
    installMode: 'success', // 'success' | 'test-only' | 'failure'
    installTries: 0,
    inputs: [],
    launches: [],
    connectCalls: [],
    disconnectCalls: [],
    calls: [],
    ...world,
  };

  state.devices = () => (state.online ? [[state.serial, state.deviceState]] : []);

  const handler = async (args, options = {}) => {
    state.calls.push(args);
    const joined = args.join(' ');
    const serial = args[0] === '-s' ? args[1] : null;
    const rest = serial ? args.slice(2) : args;

    if (rest[0] === 'devices') {
      const lines = state.devices().map(([deviceSerial, deviceStatus]) => `${deviceSerial}\t${deviceStatus}`);
      return adbResult(`List of devices attached\n${lines.join('\n')}${lines.length ? '\n' : ''}`);
    }
    if (rest[0] === 'connect') {
      state.connectCalls.push(rest[1]);
      state.online = true;
      state.deviceState = 'device';
      return adbResult(`connected to ${rest[1]}\n`);
    }
    if (rest[0] === 'disconnect') {
      state.disconnectCalls.push(rest[1]);
      state.online = false;
      return adbResult('disconnected\n');
    }
    if (!serial) {
      return adbResult('', { code: 1, stderr: `unmocked adb args: ${joined}` });
    }

    if (rest[0] === 'emu' && rest[1] === 'kill') return adbResult('');
    if (rest[0] === 'shell') {
      const shellCommand = rest.slice(1).join(' ');
      if (shellCommand === 'getprop sys.boot_completed') {
        state.bootProbeCount += 1;
        const booted = state.bootProbeCount > state.bootAfterProbes ? state.booted : false;
        return adbResult(booted ? '1\n' : '\n');
      }
      if (shellCommand === 'wm size') {
        return adbResult('Physical size: 720x1280\nOverride size: 480x800\n');
      }
      if (shellCommand.startsWith('screencap -p ')) {
        if (state.screenshotMode === 'fail') {
          return adbResult('', { code: 1, stderr: 'screencap: permission denied' });
        }
        state.remoteScreencapPath = shellCommand.split(' ').pop();
        return adbResult('');
      }
      if (shellCommand.startsWith('input ')) {
        state.inputs.push(shellCommand);
        return adbResult('');
      }
      if (shellCommand.startsWith('am start ')) {
        state.launches.push(shellCommand);
        return adbResult('Starting: Intent { cmp=com.example.dshspike/.MainActivity }\n');
      }
      if (shellCommand.startsWith('monkey ')) {
        state.launches.push(shellCommand);
        return adbResult('Events injected: 1\n');
      }
      if (shellCommand.startsWith('rm ')) return adbResult('');
      if (shellCommand.startsWith('wm dismiss-keyguard')) return adbResult('');
      if (shellCommand.startsWith('input keyevent')) return adbResult('');
      return adbResult('', { code: 1, stderr: `unmocked shell command: ${shellCommand}` });
    }
    if (rest[0] === 'exec-out' && rest[1] === 'screencap') {
      if (state.screenshotDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, state.screenshotDelayMs));
      }
      if (state.screenshotMode === 'garbage') return adbResult('this is not a png');
      if (state.screenshotMode === 'timeout') return adbResult('', { timedOut: true, code: null });
      if (state.screenshotMode === 'fail') return adbResult('', { code: 1, stderr: 'exec-out failed' });
      return adbResult(PNG_1x1);
    }
    if (rest[0] === 'pull') {
      if (state.screenshotMode === 'fail') {
        return adbResult('', { code: 1, stderr: 'adb: error: failed to stat remote object' });
      }
      const localPath = rest[2];
      await fsp.writeFile(localPath, PNG_1x1);
      return adbResult('1 file pulled\n');
    }
    if (rest[0] === 'install') {
      state.installTries += 1;
      if (state.installMode === 'failure') {
        return adbResult('Performing Streamed Install\nFailure [INSTALL_FAILED_VERSION_DOWNGRADE: downgrade]\n');
      }
      if (state.installMode === 'test-only' && state.installTries === 1) {
        return adbResult('Performing Streamed Install\nFailure [INSTALL_FAILED_TEST_ONLY]\n');
      }
      return adbResult('Performing Streamed Install\nSuccess\n');
    }
    return adbResult('', { code: 1, stderr: `unmocked adb args: ${joined}` });
  };

  return { state, handler };
}

function attachMock(vm, world) {
  const mock = createMockAdb(world);
  vm._adb = mock.handler;
  return mock;
}

const checks = [];
async function check(name, fn) {
  const startedAt = performance.now();
  try {
    await fn();
    checks.push({ name, ok: true, ms: Number((performance.now() - startedAt).toFixed(1)) });
    console.log(`PASS ${name} (${(performance.now() - startedAt).toFixed(1)} ms)`);
  } catch (error) {
    checks.push({ name, ok: false, error: error && error.message });
    console.log(`FAIL ${name}\n     ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n     ') : error}`);
  }
}

async function main() {
  // --- status()/attach/boot state machine -----------------------------------
  await check('status(): discovers first online device and reports ready', async () => {
    const vm = new AndroidVm({ pollIntervalMs: 100, bootProbeCacheMs: 30 });
    const mock = attachMock(vm);
    const status = await vm.status();
    assert.equal(status.state, 'ready');
    assert.equal(status.serial, '127.0.0.1:5555');
    assert.equal(status.error, null);
    assert.ok(status.logTail.length > 0);
    assert.ok(mock.state.calls.some((args) => args[0] === 'devices'));
  });

  await check('status(): booting -> ready transition once boot_completed=1', async () => {
    const vm = new AndroidVm({ pollIntervalMs: 100, bootProbeCacheMs: 30 });
    const mock = attachMock(vm, { booted: false });
    const booting = await vm.status();
    assert.equal(booting.state, 'booting');
    mock.state.booted = true;
    vm._bootProbe = { serial: null, at: 0, booted: false };
    const ready = await vm.status();
    assert.equal(ready.state, 'ready');
  });

  await check('status(): configured-but-absent network serial stays stopped (no spawn)', async () => {
    const vm = new AndroidVm({ serial: '127.0.0.1:5555', pollIntervalMs: 100 });
    attachMock(vm, { online: false });
    vm._adb = async (args) =>
      args[0] === 'devices' ? adbResult('List of devices attached\n\n') : adbResult('', { code: 1 });
    const status = await vm.status();
    assert.equal(status.state, 'stopped');
    assert.equal(status.serial, null);
    assert.equal(status.error, null);
  });

  // --- connect() ------------------------------------------------------------
  await check('connect(serial): adb connect + waits online', async () => {
    const vm = new AndroidVm({ serial: '127.0.0.1:5555', pollIntervalMs: 50, connectTimeoutMs: 5000 });
    const mock = attachMock(vm, { online: false });
    const snapshot = await vm.connect('127.0.0.1:5555');
    assert.equal(snapshot.state, 'starting');
    assert.equal(snapshot.error, null);
    assert.deepEqual(mock.state.connectCalls, ['127.0.0.1:5555']);
  });

  // --- start() end-to-end against mock: connect -> boot -> ready ------------
  await check('start(): connects configured network serial, waits boot, reaches ready + bootMs', async () => {
    const vm = new AndroidVm({
      serial: '127.0.0.1:5555',
      pollIntervalMs: 100,
      bootProbeCacheMs: 30,
      connectTimeoutMs: 5000,
      bootTimeoutMs: 10000,
    });
    const mock = attachMock(vm, { online: false, bootAfterProbes: 2 });
    const startedAt = performance.now();
    await vm.start();
    const elapsedMs = performance.now() - startedAt;
    const status = await vm.status();
    assert.equal(status.state, 'ready', `error=${status.error}`);
    assert.equal(status.serial, '127.0.0.1:5555');
    assert.ok(status.bootMs !== null && status.bootMs >= 150, `bootMs=${status.bootMs}`);
    assert.ok(status.bootMs <= elapsedMs + 100, `bootMs=${status.bootMs} elapsed=${elapsedMs}`);
    assert.deepEqual(mock.state.connectCalls, ['127.0.0.1:5555']);
    assert.ok(mock.state.calls.some((args) => args.includes('getprop')), 'boot probed');
    await vm.stop();
    assert.equal((await vm.status()).state, 'stopped');
  });

  await check('restart race: stop() during boot then start() boots cleanly', async () => {
    const vm = new AndroidVm({
      serial: '127.0.0.1:5555',
      pollIntervalMs: 60,
      bootProbeCacheMs: 10,
      connectTimeoutMs: 3000,
      shutdownTimeoutMs: 1500,
      bootTimeoutMs: 15000,
    });
    const mock = attachMock(vm, { online: false, booted: false, bootAfterProbes: 100000 });
    const firstStart = vm.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await vm.stop();
    await firstStart;
    assert.equal((await vm.status()).state, 'stopped', 'interrupted start left stopped state');

    mock.state.online = true;
    mock.state.deviceState = 'device';
    mock.state.booted = true;
    mock.state.bootAfterProbes = 0;
    await vm.start();
    const status = await vm.status();
    assert.equal(status.state, 'ready', `restart failed: ${status.error}`);
    assert.equal(status.serial, '127.0.0.1:5555');
    await vm.stop();
  });

  await check('start(): no device + no emulator config => actionable error, no throw', async () => {
    const vm = new AndroidVm({ pollIntervalMs: 100, bootTimeoutMs: 500 });
    vm._adb = async (args) =>
      args[0] === 'devices' ? adbResult('List of devices attached\n\n') : adbResult('', { code: 1 });
    await vm.start();
    const status = await vm.status();
    assert.equal(status.state, 'error');
    assert.match(status.error, /No Android device available/);
    assert.match(status.error, /connect\("host:port"\)|options\.serial/);
  });

  // --- screenSize / screenshot ---------------------------------------------
  await check('screenSize(): prefers wm size override', async () => {
    const vm = new AndroidVm();
    attachMock(vm);
    const size = await vm.screenSize();
    assert.deepEqual(size, { width: 480, height: 800 });
  });

  await check('screenshot(): exec-out PNG path, valid signature + Buffer', async () => {
    const vm = new AndroidVm();
    const mock = attachMock(vm);
    const buffer = await vm.screenshot();
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.length, PNG_1x1.length);
    assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(
      mock.state.calls.some((args) => args.includes('exec-out') && args.includes('screencap')),
      'used exec-out screencap',
    );
  });

  await check('screenshot(): falls back to shell screencap + adb pull', async () => {
    const vm = new AndroidVm();
    const mock = attachMock(vm, { screenshotMode: 'garbage' });
    const buffer = await vm.screenshot();
    assert.ok(Buffer.isBuffer(buffer) && buffer.length === PNG_1x1.length);
    assert.ok(
      mock.state.calls.some((args) => args.includes('screencap') && args.includes('-p') && args.some((arg) => String(arg).includes('/data/local/tmp/'))),
      'used shell screencap to file',
    );
    assert.ok(mock.state.calls.some((args) => args.includes('pull')), 'used adb pull fallback');
    assert.match(buffer.subarray(1, 4).toString('ascii'), /PNG/);
  });

  await check('screenshot(): concurrent requests coalesce into one adb screencap', async () => {
    const vm = new AndroidVm();
    const mock = attachMock(vm, { screenshotDelayMs: 40 });
    const [first, second] = await Promise.all([vm.screenshot(), vm.screenshot()]);
    assert.ok(Buffer.isBuffer(first) && Buffer.isBuffer(second));
    assert.equal(first, second, 'both callers receive the same Buffer instance');
    const execOutCalls = mock.state.calls.filter((args) => args.includes('exec-out'));
    assert.equal(execOutCalls.length, 1, `expected 1 exec-out call, got ${execOutCalls.length}`);
  });

  await check('screenshot(): rejects when both screenshot paths fail', async () => {
    const vm = new AndroidVm();
    attachMock(vm, { screenshotMode: 'fail' });
    // exec-out fails; fallback shell screencap also fails -> screenshot must throw.
    await assert.rejects(() => vm.screenshot(), /screenshot failed/i);
  });

  // --- input command construction ------------------------------------------
  await check('input(): tap/swipe/key/text map to exact adb shell commands', async () => {
    const vm = new AndroidVm();
    const mock = attachMock(vm);
    assert.deepEqual(await vm.input({ type: 'tap', x: 10, y: 20 }), { ok: true });
    assert.deepEqual(
      await vm.input({ type: 'swipe', x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 350 }),
      { ok: true },
    );
    assert.deepEqual(await vm.input({ type: 'key', key: 'back' }), { ok: true });
    assert.deepEqual(await vm.input({ type: 'key', keycode: 3 }), { ok: true });
    assert.deepEqual(await vm.input({ type: 'key', key: 'recents' }), { ok: true });
    assert.deepEqual(await vm.input({ type: 'text', text: "hello world it's" }), { ok: true });
    assert.deepEqual(mock.state.inputs, [
      'input tap 10 20',
      'input swipe 1 2 3 4 350',
      'input keyevent KEYCODE_BACK',
      'input keyevent 3',
      'input keyevent KEYCODE_APP_SWITCH',
      "input text 'hello%sworld%sit'\\''s'",
    ]);
  });

  await check('input(): invalid payloads rejected before touching adb', async () => {
    const vm = new AndroidVm();
    const mock = attachMock(vm);
    const callsBefore = mock.state.calls.length;
    await assert.rejects(() => vm.input({ type: 'tap', x: 'nope', y: 1 }), /finite numeric/);
    await assert.rejects(() => vm.input({ type: 'swipe', x1: 0, y1: 0, x2: 1, y2: '' }), /finite numeric/);
    await assert.rejects(() => vm.input({ type: 'key' }), /requires "key" or "keycode"/);
    await assert.rejects(() => vm.input({ type: 'text', text: '' }), /non-empty string "text"/);
    await assert.rejects(() => vm.input({ type: 'wat' }), /unsupported input type/);
    assert.equal(mock.state.calls.length, callsBefore, 'adb was not called for invalid payloads');
  });

  // --- installApk (real aapt2 + mocked adb) --------------------------------
  await check('installApk(): real aapt2 metadata + adb install -r + auto-launch', async () => {
    const vm = new AndroidVm();
    const mock = attachMock(vm);
    const metadata = await vm.installApk(SAMPLE_APK);
    const { sdkVersion, ...rest } = metadata;
    // aapt2 versions differ on whether they emit sdkVersion for this fixture; targetSdk is stable.
    assert.ok(sdkVersion === null || sdkVersion === 21, `unexpected sdkVersion: ${sdkVersion}`);
    assert.deepEqual(rest, {
      packageName: 'com.example.dshspike',
      label: 'DSH Spike App',
      launchActivity: 'com.example.dshspike.MainActivity',
      versionName: null,
      versionCode: null,
      targetSdkVersion: 34,
      permissions: [],
      features: ['android.hardware.faketouch'],
      nativeCode: [],
      iconPath: null,
    });
    assert.equal(mock.state.installTries, 1);
    const installCall = mock.state.calls.find((args) => args.includes('install'));
    assert.ok(installCall, 'issued adb install');
    assert.ok(installCall.includes('-r'), 'used adb install -r');
    assert.equal(mock.state.launches.length, 1, 'auto-launched once');
    assert.equal(
      mock.state.launches[0],
      'am start -n com.example.dshspike/com.example.dshspike.MainActivity',
    );
  });

  await check('installApk(): retries with -t on INSTALL_FAILED_TEST_ONLY', async () => {
    const vm = new AndroidVm();
    const mock = attachMock(vm, { installMode: 'test-only' });
    const metadata = await vm.installApk(SAMPLE_APK);
    assert.equal(metadata.packageName, 'com.example.dshspike');
    const installCalls = mock.state.calls.filter((args) => args.includes('install'));
    assert.equal(installCalls.length, 2);
    assert.ok(installCalls[1].includes('-t'), 'second attempt used -t');
  });

  await check('installApk(): surfaces INSTALL_FAILED_* codes', async () => {
    const vm = new AndroidVm();
    attachMock(vm, { installMode: 'failure' });
    await assert.rejects(() => vm.installApk(SAMPLE_APK), /INSTALL_FAILED_VERSION_DOWNGRADE/);
  });

  // --- launchPackage --------------------------------------------------------
  await check('launchPackage(): am start -n and monkey fallback + validation', async () => {
    const vm = new AndroidVm();
    const mock = attachMock(vm);
    assert.deepEqual(await vm.launchPackage('com.example.dshspike', '.MainActivity'), { ok: true });
    assert.deepEqual(await vm.launchPackage('com.example.dshspike'), { ok: true });
    assert.deepEqual(mock.state.launches, [
      'am start -n com.example.dshspike/com.example.dshspike.MainActivity',
      'monkey -p com.example.dshspike -c android.intent.category.LAUNCHER 1',
    ]);
    await assert.rejects(() => vm.launchPackage('bad package!', ''), /invalid package name/);
    await assert.rejects(() => vm.launchPackage('com.example.dshspike', 'bad/activity'), /invalid activity name/);
  });

  // --- stop / dispose -------------------------------------------------------
  await check('stop(): disconnects the VM and returns to stopped', async () => {
    const vm = new AndroidVm({ serial: '127.0.0.1:5555', shutdownTimeoutMs: 3000 });
    const mock = attachMock(vm);
    await vm.status();
    const snapshot = await vm.stop();
    assert.equal(snapshot.state, 'stopped');
    assert.equal(snapshot.serial, null);
    assert.ok(mock.state.calls.some((args) => args.includes('emu') && args.includes('kill')));
    assert.deepEqual(mock.state.disconnectCalls, ['127.0.0.1:5555']);
  });

  await check('dispose(): idempotent, stopped, and disposal blocks start()', async () => {
    const vm = new AndroidVm();
    attachMock(vm);
    await vm.dispose();
    await vm.dispose();
    assert.equal((await vm.status()).state, 'stopped');
    await assert.rejects(() => vm.start(), /disposed/);
  });

  // --- extended debug surface (rotate / ui dump / perf / record) ------------
  await check('rotate(): locks user_rotation via root shell', async () => {
    const vm = new AndroidVm();
    const calls = [];
    vm._serialActive = 'mock-device';
    vm.ensureRoot = async () => true;
    vm._adb = async (args) => {
      calls.push(args);
      return adbResult('');
    };
    const result = await vm.rotate('landscape');
    assert.equal(result.rotation, 1);
    assert.ok(calls.some((args) => args.join(' ').includes('user_rotation 1')));
    await assert.rejects(() => vm.rotate('diagonal'), /invalid rotation/);
  });

  await check('uiDump(): parses UIAutomator XML and counts nodes', async () => {
    const vm = new AndroidVm();
    vm._serialActive = 'mock-device';
    vm.ensureRoot = async () => true;
    vm._adb = async () =>
      adbResult('<?xml version="1.0"?><hierarchy rotation="0"><node text="A"/><node text="B"/></hierarchy>');
    const result = await vm.uiDump();
    assert.equal(result.nodes, 2);
    assert.equal(result.rotation, '0');
    assert.match(result.xml, /<hierarchy/);
  });

  await check('perfSnapshot(): parses loadavg/memory/cpuinfo', async () => {
    const vm = new AndroidVm();
    vm._serialActive = 'mock-device';
    vm._adbText = async () =>
      '0.10 0.20 0.30 1/100 123\n---MEM---\nMemTotal:       1000 kB\nMemFree:         400 kB\nMemAvailable:    600 kB\n---CPU---\n  1.2% 123/pid\n';
    const result = await vm.perfSnapshot();
    assert.equal(result.loadavg, '0.10 0.20 0.30');
    assert.equal(result.memTotalKb, 1000);
    assert.equal(result.memFreeKb, 400);
    assert.ok(result.cpuinfo[0].includes('1.2%'));
  });

  await check('screenRecord(): uses screenrecord and pulls the MP4', async () => {
    const vm = new AndroidVm();
    vm._serialActive = 'mock-device';
    const calls = [];
    vm._adb = async (args) => {
      calls.push(args);
      return adbResult('');
    };
    let pulled = null;
    vm.pullFile = async (remote, local) => {
      pulled = { remote, local };
      return { ok: true, remotePath: remote, localPath: local };
    };
    const result = await vm.screenRecord({ seconds: 2 });
    assert.equal(result.ok, true);
    assert.ok(calls[0].join(' ').includes('screenrecord --time-limit 2'));
    assert.match(pulled.remote, /^\/sdcard\/dsh-record-.*\.mp4$/);
  });

  // --- report ---------------------------------------------------------------
  const failed = checks.filter((entry) => !entry.ok);
  console.log('\n--- summary ---');
  console.log(`checks: ${checks.length}, passed: ${checks.length - failed.length}, failed: ${failed.length}`);
  if (failed.length > 0) {
    for (const entry of failed) console.error(`- ${entry.name}: ${entry.error}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('mock-device.mjs crashed:', error);
  process.exitCode = 1;
});
