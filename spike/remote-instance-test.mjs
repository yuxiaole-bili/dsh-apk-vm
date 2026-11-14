#!/usr/bin/env node
/**
 * Hermetic regression checks for RemoteVmInstance (remote VM behind an SSH
 * tunnel). The AndroidVm and the SshAdbTunnel are fakes: no process is spawned,
 * no network connection is made.
 *
 * Covers:
 *   - status() shape (kind/host/tunnel/launch/serial + vm fields);
 *   - start() order: tunnel → adb connect (retry/deadline) → attachDevice;
 *   - background attach reuse (attachInBackground / wait:false);
 *   - stop({killRemote}) order: remote `emu kill` → detach → tunnel stop;
 *   - debug delegates + video-stream delegates + dispose() ordering;
 *   - media launch options forwarded to the underlying AndroidVm.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (relative) => import(pathToFileURL(path.join(REPO, relative)).href);

const { RemoteVmInstance } = await load('lib/remote-instance.js');

const checks = [];
function check(name, fn) {
  checks.push([name, fn]);
}
async function runChecks() {
  let passed = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
      passed += 1;
      console.log(`  ok ${passed} - ${name}`);
    } catch (error) {
      console.error(`  not ok - ${name}: ${error && error.stack ? error.stack : error}`);
      process.exitCode = 1;
      throw error;
    }
  }
  return passed;
}

const SERIAL = '127.0.0.1:16001';
const PROFILE = Object.freeze({
  host: 'build.example',
  user: 'builder',
  sshPort: 22,
  remotePort: 5555,
  avdName: 'Pixel_7',
  keyPath: 'C:/keys/id_test',
});
const LAUNCH_INFO = Object.freeze({
  consolePort: 5554,
  adbPort: 5555,
  logPath: '/tmp/apk-vm-emulator-5554.log',
  startedAt: 1,
});

const DELEGATES = [
  'shell',
  'logcat',
  'getprop',
  'setprop',
  'listPackages',
  'deviceInfo',
  'ensureRoot',
  'rotate',
  'uiDump',
  'screenRecord',
  'perfSnapshot',
  'pushFile',
  'pullFile',
  'reboot',
  'forceStop',
  'clearData',
  'uninstall',
  'debugStatus',
];

function makeFakeVm(options = {}) {
  const calls = [];
  const vm = {
    calls,
    _state: options.state || 'stopped',
    serial: options.serial === undefined ? SERIAL : options.serial,
    connectCalls: 0,
    attachCalls: 0,
    stopCalls: 0,
    disposeCalls: 0,
    connectFailuresLeft: Number(options.connectFailures || 0),
    connectError: options.connectError || 'device offline',
    attachError: options.attachError || null,
    attachGate: null,
    async connect(serial) {
      calls.push(['connect', serial]);
      this.connectCalls += 1;
      if (this.connectFailuresLeft > 0) {
        this.connectFailuresLeft -= 1;
        throw new Error(this.connectError);
      }
      this._state = 'ready';
      return { ok: true, serial };
    },
    async attachDevice(serial) {
      calls.push(['attachDevice', serial]);
      this.attachCalls += 1;
      if (this.attachGate) await this.attachGate;
      if (this.attachError) throw new Error(this.attachError);
      return { ok: true };
    },
    async status() {
      return {
        state: this._state,
        serial: this.serial,
        avd: '',
        root: true,
        debugPrepared: true,
        debugToolkit: { ok: true },
        identity: { model: 'Pixel_7' },
      };
    },
    async stop() {
      calls.push(['stop']);
      this.stopCalls += 1;
      this._state = 'stopped';
      if (options.stopError) throw new Error(options.stopError);
      return { ok: true };
    },
    async dispose() {
      calls.push(['dispose']);
      this.disposeCalls += 1;
    },
    async saveSnapshot(name) {
      calls.push(['saveSnapshot', name]);
      return { ok: true, name };
    },
    async screenshot() {
      calls.push(['screenshot']);
      return Buffer.from('png');
    },
    async installApk(apkPath) {
      calls.push(['installApk', apkPath]);
      return { packageName: 'com.example.app', label: 'Example', launchActivity: '.Main' };
    },
    async input(payload) {
      calls.push(['input', payload]);
      return { ok: true };
    },
  };
  for (const method of DELEGATES) {
    vm[method] = async (...args) => {
      calls.push([method, ...args]);
      return { ok: true, method };
    };
  }
  return vm;
}

function makeFakeTunnel(options = {}) {
  const calls = [];
  const tunnel = {
    calls,
    state: 'stopped',
    startCount: 0,
    stopCount: 0,
    startError: options.startError || null,
    stopError: options.stopError || null,
    serial: options.serial === undefined ? SERIAL : options.serial,
    status() {
      return {
        state: this.state,
        serial: this.serial,
        localPort: 16001,
        remotePort: 5555,
        sshHost: PROFILE.host,
        sshUser: PROFILE.user,
      };
    },
    async start() {
      calls.push('start');
      this.startCount += 1;
      if (this.startError) throw new Error(this.startError);
      this.state = 'running';
      return { ok: true, ...this.status() };
    },
    async stop() {
      calls.push('stop');
      this.stopCount += 1;
      if (this.stopError) throw new Error(this.stopError);
      this.state = 'stopped';
      return { ok: true, ...this.status() };
    },
  };
  return tunnel;
}

function makeFakeStream() {
  const calls = [];
  return {
    calls,
    async ensure() {
      calls.push('ensure');
      return true;
    },
    async sendTouch(message) {
      calls.push(['sendTouch', message]);
      return { ok: true };
    },
    async setClipboard(text, paste) {
      calls.push(['setClipboard', text, paste]);
      return { ok: true };
    },
    async getClipboard() {
      calls.push('getClipboard');
      return 'clip';
    },
    async sendText(text) {
      calls.push(['sendText', text]);
      return 3;
    },
    handleClient(client) {
      calls.push(['handleClient', client]);
    },
    status() {
      return { enabled: true, active: true, clients: 1, fps: 30, maxFps: 60, error: null };
    },
    async stop() {
      calls.push('stop');
      return { ok: true };
    },
  };
}

function makeInstance(overrides = {}) {
  const vm = overrides.vm || makeFakeVm(overrides.vmOptions || {});
  const tunnel = overrides.tunnel || makeFakeTunnel(overrides.tunnelOptions || {});
  const events = [];
  const sshCalls = [];
  const stream = overrides.stream === undefined ? null : overrides.stream;
  const vmStop = vm.stop.bind(vm);
  vm.stop = async (...args) => {
    events.push('vm.stop');
    return vmStop(...args);
  };
  const tunnelStop = tunnel.stop.bind(tunnel);
  tunnel.stop = async (...args) => {
    events.push('tunnel.stop');
    return tunnelStop(...args);
  };
  const options = {
    vm,
    runSsh: async (profile, command, execOptions) => {
      events.push('ssh');
      sshCalls.push({ profile, command, execOptions });
      return { ok: true, code: 0, stdout: 'killed', stderr: '', error: null };
    },
    now: overrides.now || (() => 1000),
    sleep: overrides.sleep || (async () => {}),
    connectTimeoutMs: overrides.connectTimeoutMs || 5000,
    connectRetryDelayMs: 10,
    remoteStopTimeoutMs: 15000,
    scrcpyJarPath: null,
    ...overrides.options,
  };
  if (stream) options.streamFactory = () => stream;
  const instance = new RemoteVmInstance({
    id: overrides.id || 'remote-pixel-7',
    profile: overrides.profile || PROFILE,
    tunnel,
    launchInfo: overrides.launchInfo === undefined ? LAUNCH_INFO : overrides.launchInfo,
    options,
    log: () => {},
  });
  return { instance, vm, tunnel, events, sshCalls, stream };
}

// ---------------------------------------------------------------------------
// status / constructor
// ---------------------------------------------------------------------------

check('constructor exposes kind "remote" and does not start anything', () => {
  const { instance, vm, tunnel } = makeInstance();
  assert.equal(instance.id, 'remote-pixel-7');
  assert.equal(instance.kind, 'remote');
  assert.equal(vm.connectCalls, 0);
  assert.equal(vm.attachCalls, 0);
  assert.equal(tunnel.startCount, 0);
  assert.equal(instance.stream, null);
});

check('status() merges the VM state with the remote session metadata', async () => {
  const { instance } = makeInstance();
  const status = await instance.status();
  assert.equal(status.id, 'remote-pixel-7');
  assert.equal(status.kind, 'remote');
  assert.equal(status.host, 'build.example');
  assert.equal(status.user, 'builder');
  assert.equal(status.sshPort, 22);
  assert.equal(status.avdName, 'Pixel_7');
  assert.equal(status.port, null);
  assert.equal(status.serial, SERIAL);
  assert.equal(status.state, 'stopped');
  assert.equal(status.root, true);
  assert.equal(status.debugPrepared, true);
  assert.deepEqual(status.debugToolkit, { ok: true });
  assert.deepEqual(status.identity, { model: 'Pixel_7' });
  assert.equal(status.tunnel.state, 'stopped');
  assert.equal(status.tunnel.serial, SERIAL);
  assert.deepEqual(status.launch, { ...LAUNCH_INFO });
  assert.equal(status.attachError, null);
  assert.equal(status.remoteKill, null);
});

check('status() tolerates a throwing vm.status()', async () => {
  const vm = makeFakeVm();
  vm.status = async () => {
    throw new Error('adb is gone');
  };
  const { instance } = makeInstance({ vm });
  const status = await instance.status();
  assert.equal(status.state, 'error');
  assert.equal(status.error, 'adb is gone');
  assert.equal(status.kind, 'remote');
});

check('media launch options reach the underlying AndroidVm', () => {
  const instance = new RemoteVmInstance({
    id: 'remote-media',
    profile: PROFILE,
    tunnel: makeFakeTunnel(),
    launchInfo: LAUNCH_INFO,
    options: {
      scrcpyJarPath: null,
      extraEmulatorArgs: ['-camera-back', 'virtualscene', '-camera-front', 'emulated'],
      enableAudio: true,
    },
  });
  assert.deepEqual(instance.vm.extraEmulatorArgs, ['-camera-back', 'virtualscene', '-camera-front', 'emulated']);
  assert.equal(instance.vm.enableAudio, true);
});

// ---------------------------------------------------------------------------
// start(): tunnel → adb connect → attach
// ---------------------------------------------------------------------------

check('start() runs tunnel → connect → attach in order', async () => {
  const { instance, vm, tunnel } = makeInstance();
  const status = await instance.start();
  assert.equal(tunnel.startCount, 1);
  assert.deepEqual(tunnel.calls, ['start']);
  assert.equal(vm.connectCalls, 1);
  assert.deepEqual(vm.calls[0], ['connect', SERIAL]);
  assert.deepEqual(vm.calls[1], ['attachDevice', SERIAL]);
  assert.equal(status.state, 'ready');
  assert.equal(status.serial, SERIAL);
  assert.equal(status.attachError, null);
});

check('start() reuses an already running tunnel but reconnects', async () => {
  const { instance, vm, tunnel } = makeInstance();
  tunnel.state = 'running';
  await instance.start();
  assert.equal(tunnel.startCount, 0, 'running tunnel is not restarted');
  assert.equal(vm.connectCalls, 1);
  await instance.start();
  assert.equal(vm.connectCalls, 2);
  assert.equal(vm.attachCalls, 2);
});

check('start() retries adb connect until the device is online', async () => {
  const vm = makeFakeVm({ connectFailures: 2 });
  const { instance, tunnel } = makeInstance({ vm });
  await instance.start();
  assert.equal(vm.connectCalls, 3);
  assert.equal(vm.attachCalls, 1);
  assert.equal(tunnel.startCount, 1);
});

check('start() fails fast for an unauthorized device', async () => {
  const vm = makeFakeVm({ connectFailures: 1, connectError: 'device unauthorized' });
  const { instance } = makeInstance({ vm });
  await assert.rejects(() => instance.start(), /device unauthorized/);
  assert.equal(vm.connectCalls, 1, 'no retry for unauthorized');
  assert.equal(vm.attachCalls, 0);
});

check('start() gives up at the connect deadline with an actionable error', async () => {
  const vm = makeFakeVm({ connectFailures: 1000 });
  let clock = 0;
  const { instance } = makeInstance({
    vm,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    connectTimeoutMs: 50,
  });
  await assert.rejects(
    () => instance.start(),
    new RegExp(`remote adb attach failed for ${SERIAL.replace('.', '\\.')}: device offline \\(after 101 attempts\\); emulator log: /tmp/apk-vm-emulator-5554\\.log`),
  );
  assert.equal(vm.attachCalls, 0);
});

check('start() requires the tunnel to expose a loopback serial', async () => {
  const { instance } = makeInstance({ tunnelOptions: { serial: null } });
  await assert.rejects(() => instance.start(), /SSH tunnel is not exposing a loopback adb serial/);
});

check('start() surfaces tunnel start failures', async () => {
  const { instance, vm } = makeInstance({ tunnelOptions: { startError: 'connection refused' } });
  await assert.rejects(() => instance.start(), /connection refused/);
  assert.equal(vm.connectCalls, 0);
});

check('attachInBackground:true returns early and waitForAttach() waits', async () => {
  const vm = makeFakeVm();
  vm.attachGate = new Promise((resolve) => {
    vm.releaseAttach = resolve;
  });
  const { instance } = makeInstance({ vm });
  const first = await instance.start({ wait: false, attachInBackground: true });
  assert.equal(first.attachInFlight, true);
  assert.equal(vm.attachCalls, 1);
  const second = instance.start(); // joins the in-flight background attach
  vm.releaseAttach();
  await second;
  assert.equal(vm.attachCalls, 1, 'the background attach promise is reused');
  assert.equal(await instance.waitForAttach(), null);
  assert.equal((await instance.status()).attachError, null);
});

check('a failed background attach is recorded instead of thrown', async () => {
  const vm = makeFakeVm({ attachError: 'remote device is booting' });
  const { instance } = makeInstance({ vm });
  await instance.start({ attachInBackground: true });
  assert.equal(await instance.waitForAttach(), 'remote device is booting');
  const status = await instance.status();
  assert.equal(status.attachError, 'remote device is booting');
});

// ---------------------------------------------------------------------------
// stop(): remote kill → detach → tunnel stop
// ---------------------------------------------------------------------------

check('stop({killRemote:true}) kills remotely, detaches, then stops the tunnel', async () => {
  const { instance, vm, tunnel, events, sshCalls } = makeInstance();
  const result = await instance.stop({ killRemote: true });
  assert.equal(sshCalls.length, 1);
  assert.match(sshCalls[0].command, /-s 'emulator-5554' emu kill/);
  assert.equal(sshCalls[0].execOptions.timeoutMs, 15000);
  assert.deepEqual(sshCalls[0].profile, PROFILE);
  assert.equal(vm.stopCalls, 1);
  assert.equal(tunnel.stopCount, 1);
  assert.deepEqual(events, ['ssh', 'vm.stop', 'tunnel.stop'], 'remote kill → detach → tunnel stop');
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'remote');
  assert.equal(result.killRemote, true);
  assert.equal(result.remoteKill.command, sshCalls[0].command);
  assert.equal(result.remoteKill.ok, true);
  assert.deepEqual(result.detach, { ok: true });
  assert.equal(result.tunnelError, null);
  assert.equal(result.tunnel.state, 'stopped');
  assert.equal(instance.lastRemoteKill.ok, true);
});

check('stop() without killRemote never runs a remote command', async () => {
  const { instance, vm, tunnel, sshCalls } = makeInstance();
  const result = await instance.stop();
  assert.equal(sshCalls.length, 0);
  assert.equal(result.remoteKill, null);
  assert.equal(vm.stopCalls, 1);
  assert.equal(tunnel.stopCount, 1);
});

check('stop({killRemote:true}) skips the remote kill when no console port is known', async () => {
  const profile = { ...PROFILE, remotePort: 1 };
  const { instance, sshCalls } = makeInstance({ profile, launchInfo: null });
  const result = await instance.stop({ killRemote: true });
  assert.equal(sshCalls.length, 0);
  assert.equal(result.remoteKill.ok, false);
  assert.match(result.remoteKill.error, /no remote emulator console port/);
});

check('stop() tolerates detach and tunnel failures', async () => {
  const vm = makeFakeVm({ stopError: 'adb server is out of date' });
  const tunnel = makeFakeTunnel({ stopError: 'ssh already gone' });
  const { instance } = makeInstance({ vm, tunnel });
  const result = await instance.stop();
  assert.equal(result.ok, true);
  assert.equal(result.detachError, 'adb server is out of date');
  assert.equal(result.tunnelError, 'ssh already gone');
});

// ---------------------------------------------------------------------------
// delegates + dispose
// ---------------------------------------------------------------------------

check('debug delegates call the underlying vm', async () => {
  const { instance, vm } = makeInstance();
  const cases = [
    ['shell', ['id']],
    ['logcat', [{ lines: 10 }]],
    ['getprop', ['ro.product.model']],
    ['setprop', ['debug.foo', '1']],
    ['listPackages', [{}]],
    ['deviceInfo', []],
    ['ensureRoot', []],
    ['rotate', ['landscape']],
    ['uiDump', []],
    ['screenRecord', [{ seconds: 3 }]],
    ['perfSnapshot', []],
    ['pushFile', ['a.txt', '/sdcard/a.txt']],
    ['pullFile', ['/sdcard/a.txt', 'a.txt']],
    ['reboot', ['system']],
    ['forceStop', ['com.example.app']],
    ['clearData', ['com.example.app']],
    ['uninstall', ['com.example.app']],
    ['debugStatus', []],
  ];
  const before = instance.lastUsedAt;
  instance.lastUsedAt = 0;
  for (const [method, args] of cases) {
    const result = await instance[method](...args);
    assert.equal(result.ok, true, `${method} result`);
    const call = vm.calls[vm.calls.length - 1];
    assert.equal(call[0], method, `${method} delegate`);
    assert.deepEqual(call.slice(1, args.length + 1), args, `${method} delegate args`);
  }
  assert.ok(instance.lastUsedAt > 0, 'delegates touch the instance');
});

check('video delegates require the scrcpy stream and delegate when present', async () => {
  const bare = makeInstance();
  await assert.rejects(() => bare.instance.sendTouch({ type: 'touch' }), /H.264 stream is disabled/);
  const client = { sendText: (text) => client.sent.push(text), close: () => {}, sent: [] };
  bare.instance.handleVideoClient(client);
  assert.equal(client.sent.length, 1);
  assert.match(client.sent[0], /H\.264 stream is disabled/);
  assert.deepEqual(bare.instance.videoStatus(), {
    enabled: false, active: false, clients: 0, fps: 0, maxFps: 0, error: 'scrcpyJarPath not configured',
  });

  const stream = makeFakeStream();
  const withStream = makeInstance({ stream });
  await withStream.instance.sendTouch({ type: 'touch', x: 1 });
  assert.deepEqual(stream.calls[0], 'ensure');
  assert.deepEqual(stream.calls[1], ['sendTouch', { type: 'touch', x: 1 }]);
  await withStream.instance.setClipboard('hello', true);
  assert.equal(await withStream.instance.getClipboard(), 'clip');
  assert.deepEqual(await withStream.instance.sendText('abc'), { ok: true, chars: 3, messages: 3 });
  assert.equal(withStream.instance.videoStatus().fps, 30);
});

check('installApk requires a ready VM and records the last APK', async () => {
  const notReady = makeInstance();
  await assert.rejects(() => notReady.instance.installApk('C:/tmp/app.apk'), /VM is not ready \(state: stopped\)/);

  const ready = makeInstance();
  ready.vm._state = 'ready';
  const installed = await ready.instance.installApk('C:/tmp/app.apk');
  assert.equal(installed.packageName, 'com.example.app');
  assert.equal(installed.label, 'Example');
  assert.equal(installed.launched, true);
  assert.deepEqual(ready.instance.snapshotApk(), installed);
  assert.ok(ready.vm.calls.some((entry) => entry[0] === 'installApk'));
  assert.ok(ready.vm.calls.some((entry) => entry[0] === 'saveSnapshot'));
});

check('framePng caches screenshots inside the 400 ms window', async () => {
  const { instance, vm } = makeInstance();
  const first = await instance.framePng();
  const second = await instance.framePng();
  assert.equal(first.toString(), 'png');
  assert.equal(second, first, 'cached buffer');
  assert.equal(vm.calls.filter((entry) => entry[0] === 'screenshot').length, 1);
});

check('dispose() stops the stream, detaches and disposes the vm', async () => {
  const stream = makeFakeStream();
  const { instance, vm, tunnel } = makeInstance({ stream });
  instance.lastApk = { packageName: 'com.example.app' };
  await instance.dispose();
  assert.deepEqual(stream.calls, ['stop']);
  assert.equal(vm.disposeCalls, 1);
  assert.equal(vm.stopCalls, 1);
  assert.equal(tunnel.stopCount, 1);
  assert.equal(instance.lastApk, null);
});

check('restart() stops then starts the session', async () => {
  const { instance, vm, tunnel } = makeInstance();
  await instance.restart();
  assert.equal(vm.stopCalls, 1);
  assert.equal(tunnel.stopCount, 1);
  assert.equal(tunnel.startCount, 1, 'restart starts the tunnel once');
  assert.equal(vm.connectCalls, 1);
});

// ---------------------------------------------------------------------------

const passed = await runChecks();
console.log(`\nremote-instance-test: ${passed}/${checks.length} checks passed`);
process.exitCode = process.exitCode || 0;
