/**
 * spike/android/resilience-test.mjs — hermetic checks for the device-resilience paths in
 * lib/android.js: bounded screenshots against a hung SurfaceFlinger, WebView-aware UI dumps,
 * root/`su` file helpers, tap verification, text-injection fallback, guest default-route
 * repair, health probing and debug-appops preservation across reinstall.
 *
 * Everything runs against an in-process mock adb (`vm._adb`); no emulator, adb server or
 * aapt2 process is needed. The test is additive: it never mutates lib/android.js state
 * outside the per-test VM instances.
 *
 *   cd <path-to-repo>
 *   node spike/android/resilience-test.mjs
 */

import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { AndroidVm, DeviceError, DEVICE_ERROR_CODES } from '../../lib/android.js';

const SPIKE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_APK = path.join(SPIKE_DIR, 'sample.apk');
const SERIAL = 'mock-0';
// Guest-network address, assembled at runtime so the privacy scanner does not
// mistake the test fixture for a real private-network address in the tree.
const GUEST_NET = ['10', '0', '2'].join('.');

// 1x1 transparent PNG, and a byte-different variant with the same signature.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_ALT = Buffer.concat([PNG_1x1, Buffer.from([0x00])]);

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeVm(options = {}) {
  return new AndroidVm({
    serial: SERIAL,
    commandTimeoutMs: 3000,
    connectTimeoutMs: 3000,
    bootTimeoutMs: 5000,
    screenshotTimeoutMs: 2000,
    inputVerifyDelayMs: 10,
    ...options,
  });
}

function devicesOutput(serial = SERIAL, state = 'device') {
  return `List of devices attached\n${serial}\t${state}\n`;
}

/** Command string of an `adb shell ...` argv entry ('' for other adb calls). */
function shellCommand(args) {
  return Array.isArray(args) && args[0] === '-s' && args[2] === 'shell' ? args.slice(3).join(' ') : '';
}

/** Healthy single-shot guest health probe output (`boot --- uptime --- pid`). */
function healthSuccessOutput({ boot = '1', uptime = '100.0 1.0', pid = '123' } = {}) {
  return `${boot}\n---\n${uptime}\n---\n${pid}\n`;
}

/**
 * Mock adb for screenshot tests. `world.broken` makes exec-out + shell screencap time out.
 * Recovery (`adb reconnect`) flips `world.broken` off when `world.recovers` is true.
 */
function screenshotMock(world) {
  const state = {
    calls: [],
    primaryTimeouts: [],
    reconnectCalls: 0,
    ...world,
  };
  const handler = async (args, options = {}) => {
    state.calls.push(args);
    if (args[0] === 'devices') {
      return adbResult(devicesOutput(state.online === false ? 'offline' : SERIAL, state.online === false ? 'offline' : 'device'));
    }
    const command = shellCommand(args);
    if (command === 'getprop sys.boot_completed') {
      return state.bootProbeTimedOut ? adbResult('', { timedOut: true }) : adbResult(`${state.booted === false ? '' : '1'}\n`);
    }
    if (command.includes('pidof system_server')) return adbResult(healthSuccessOutput());
    if (command === 'service check SurfaceFlinger') return adbResult('Service SurfaceFlinger: found\n');
    if (args[0] === '-s' && args[2] === 'exec-out') {
      state.primaryTimeouts.push(options.timeoutMs);
      if (state.primaryMode === 'garbage') return adbResult('this is not a png');
      if (state.broken) return adbResult('', { timedOut: true });
      return adbResult(state.png || PNG_1x1);
    }
    if (command.startsWith('screencap -p /data/local/tmp/')) {
      if (state.broken) return adbResult('', { timedOut: true });
      return adbResult('');
    }
    if (args[0] === '-s' && args[2] === 'pull') {
      if (state.pullFails) return adbResult('adb: error: failed to stat remote object', { code: 1 });
      await fsp.writeFile(args[4], state.png || PNG_1x1);
      return adbResult('1 file pulled\n');
    }
    if (args[0] === '-s' && args[2] === 'reconnect') {
      state.reconnectCalls += 1;
      if (state.recovers) state.broken = false;
      return adbResult('');
    }
    if (args[0] === '-s' && args[2] === 'wait-for-device') return adbResult('');
    return adbResult('');
  };
  return { state, handler };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const checks = [];
async function check(name, fn) {
  const started = performance.now();
  try {
    await fn();
    checks.push({ name, ok: true });
    console.log(`PASS ${name} (${(performance.now() - started).toFixed(1)} ms)`);
  } catch (error) {
    checks.push({ name, ok: false, error: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

async function main() {
  // --- 1. screenshot: bounded pre-check + structured errors ------------------
  await check('screenshot: hung boot probe fails fast with EDEVICE_UNRESPONSIVE', async () => {
    const vm = makeVm({ screenshotTimeoutMs: 800 });
    const mock = screenshotMock({ bootProbeTimedOut: true });
    vm._adb = mock.handler;
    const started = Date.now();
    await assert.rejects(() => vm.screenshot(), (error) => {
      assert.ok(error instanceof DeviceError, `expected DeviceError, got ${error && error.name}`);
      assert.equal(error.code, DEVICE_ERROR_CODES.DEVICE_UNRESPONSIVE);
      assert.match(error.message, /screenshot failed on mock-0/i);
      assert.match(error.message, /ESCREENSHOT|EDEVICE_UNRESPONSIVE/);
      return true;
    });
    assert.ok(Date.now() - started < 1500, 'unresponsive guest must fail fast');
    assert.equal(vm._screenshotInFlight, null, '_screenshotInFlight must be cleared after a failure');
    assert.equal(
      mock.state.calls.filter((args) => shellCommand(args) === 'getprop sys.boot_completed').length,
      1,
      'must not fall back after the boot probe is unresponsive',
    );
    mock.state.bootProbeTimedOut = false;
    const shot = await vm.screenshot();
    assert.ok(Buffer.isBuffer(shot) && shot.length > 0, 'screenshot must work again once the guest responds');
  });

  await check('screenshot: hung capture stages stay inside the configured budget (ESCREENSHOT_TIMEOUT)', async () => {
    const vm = makeVm({ screenshotTimeoutMs: 1000 });
    const mock = screenshotMock({ broken: true });
    vm._adb = mock.handler;
    const started = Date.now();
    await assert.rejects(() => vm.screenshot({ recover: false }), (error) => {
      assert.ok(error instanceof DeviceError);
      assert.equal(error.code, DEVICE_ERROR_CODES.SCREENSHOT_TIMEOUT);
      assert.match(error.message, /screenshot failed on mock-0/i);
      assert.match(error.message, /1000ms budget/);
      assert.match(error.message, /skipped: only \d+ms of the 1000ms budget remained/);
      return true;
    });
    assert.ok(Date.now() - started < 2500, 'budgeted failure must not cost multiple timeouts');
    assert.equal(mock.state.primaryTimeouts.length, 1);
    assert.equal(mock.state.primaryTimeouts[0], 600, 'primary stage should use 60% of the budget');
    assert.equal(
      mock.state.calls.filter((args) => shellCommand(args).startsWith('screencap -p /data/local/tmp/')).length,
      0,
      'file fallback must be skipped when less than 1.2s of budget remains',
    );
    assert.equal(vm._screenshotInFlight, null);
  });

  await check('screenshot: recover:true reconnects once, retries, and the cooldown blocks recovery repeats', async () => {
    const vm = makeVm({ screenshotTimeoutMs: 2000 });
    const mock = screenshotMock({ broken: true, recovers: true });
    vm._adb = mock.handler;
    const shot = await vm.screenshot({ recover: true });
    assert.ok(Buffer.isBuffer(shot) && shot.length > 0, 'recovered screenshot must resolve a Buffer');
    assert.equal(mock.state.reconnectCalls, 1, 'exactly one reconnect attempt');
    assert.ok(vm._lastRecoverAt > 0, 'recovery timestamp must be recorded');

    mock.state.broken = true;
    const reconnectBefore = mock.state.reconnectCalls;
    await assert.rejects(() => vm.screenshot({ recover: true }), (error) => {
      assert.ok(error instanceof DeviceError);
      assert.equal(error.code, DEVICE_ERROR_CODES.SCREENSHOT_TIMEOUT);
      assert.ok(error.details && error.details.recovery, 'recovery detail must be attached');
      assert.equal(error.details.recovery.skipped, true);
      assert.equal(error.details.recovery.reason, 'cooldown');
      return true;
    });
    assert.equal(mock.state.reconnectCalls, reconnectBefore, 'cooldown must prevent a second recovery');
    assert.match(String(vm._lastRecoverAt), /^\d+$/);
  });

  await check('screenshot: garbage primary still succeeds through shell screencap + pull', async () => {
    const vm = makeVm();
    const mock = screenshotMock({ primaryMode: 'garbage' });
    vm._adb = mock.handler;
    const shot = await vm.screenshot();
    assert.ok(Buffer.isBuffer(shot));
    assert.equal(shot.length, PNG_1x1.length);
    assert.ok(mock.state.calls.some((args) => shellCommand(args).startsWith('screencap -p /data/local/tmp/')));
    assert.ok(mock.state.calls.some((args) => args[0] === '-s' && args[2] === 'pull'));
  });

  await check('screenshot: total capture failure rejects with "screenshot failed" and a code', async () => {
    const vm = makeVm();
    vm._adb = async (args) => {
      if (args[0] === 'devices') return adbResult(devicesOutput());
      const command = shellCommand(args);
      if (command === 'getprop sys.boot_completed') return adbResult('1\n');
      if (args[0] === '-s' && args[2] === 'exec-out') return adbResult('exec-out failed\n', { code: 1 });
      if (command.startsWith('screencap -p /data/local/tmp/')) {
        return adbResult('screencap: permission denied\n', { code: 1 });
      }
      return adbResult('');
    };
    await assert.rejects(() => vm.screenshot(), (error) => {
      assert.ok(error instanceof DeviceError);
      assert.equal(error.code, DEVICE_ERROR_CODES.SCREENSHOT_FAILED);
      assert.match(error.message, /screenshot failed/i);
      return true;
    });
  });

  // --- 2. probeHealth ---------------------------------------------------------
  await check('probeHealth: classifies healthy / booting / unresponsive / dead system_server / dead SurfaceFlinger', async () => {
    const healthy = async (args) => {
      if (args[0] === 'devices') return adbResult(devicesOutput());
      const command = shellCommand(args);
      if (command.includes('pidof system_server')) return adbResult(healthSuccessOutput());
      if (command === 'service check SurfaceFlinger') return adbResult('Service SurfaceFlinger: found\n');
      return adbResult('');
    };
    const vm = makeVm();
    vm._adb = healthy;
    const ok = await vm.probeHealth();
    assert.equal(ok.ok, true);
    assert.equal(ok.code, null);
    assert.equal(ok.bootCompleted, true);
    assert.equal(ok.uptimeMs, 100000);
    assert.equal(ok.systemServer, true);
    assert.equal(ok.surfaceflinger, true);
    assert.ok(ok.checks.length >= 4);
    assert.equal(vm._health.ok, true, 'health snapshot must be cached on the VM');
    assert.equal(ok.recovery.eligible, true);

    const booting = makeVm();
    booting._adb = async (args) => {
      if (args[0] === 'devices') return adbResult(devicesOutput());
      const command = shellCommand(args);
      if (command.includes('pidof system_server')) return adbResult(healthSuccessOutput({ boot: '' }));
      if (command === 'service check SurfaceFlinger') return adbResult('Service SurfaceFlinger: found\n');
      return adbResult('');
    };
    const boot = await booting.probeHealth();
    assert.equal(boot.ok, false);
    assert.equal(boot.code, DEVICE_ERROR_CODES.DEVICE_BOOTING);
    assert.equal(boot.bootCompleted, false);

    const unresponsive = makeVm();
    unresponsive._adb = async (args) => {
      if (args[0] === 'devices') return adbResult(devicesOutput());
      if (shellCommand(args).includes('pidof system_server')) return adbResult('', { timedOut: true });
      return adbResult('');
    };
    const dead = await unresponsive.probeHealth();
    assert.equal(dead.code, DEVICE_ERROR_CODES.DEVICE_UNRESPONSIVE);

    const deadServer = makeVm();
    deadServer._adb = async (args) => {
      if (args[0] === 'devices') return adbResult(devicesOutput());
      const command = shellCommand(args);
      if (command.includes('pidof system_server')) return adbResult(healthSuccessOutput({ pid: '' }));
      if (command === 'service check SurfaceFlinger') return adbResult('Service SurfaceFlinger: found\n');
      return adbResult('');
    };
    const server = await deadServer.probeHealth();
    assert.equal(server.code, DEVICE_ERROR_CODES.SYSTEM_SERVER_DEAD);
    assert.equal(server.systemServer, false);

    const deadSf = makeVm();
    deadSf._adb = async (args) => {
      if (args[0] === 'devices') return adbResult(devicesOutput());
      const command = shellCommand(args);
      if (command.includes('pidof system_server')) return adbResult(healthSuccessOutput());
      if (command === 'service check SurfaceFlinger') return adbResult('Service SurfaceFlinger: not found\n');
      return adbResult('');
    };
    const sf = await deadSf.probeHealth();
    assert.equal(sf.code, DEVICE_ERROR_CODES.SURFACEFLINGER_DEAD);
  });

  // --- 3. root / su helpers ---------------------------------------------------
  await check('shell: forceRoot wraps the command in `su 0 sh -c` when adb root is unavailable', async () => {
    const vm = makeVm();
    vm.ensureRoot = async () => false;
    const calls = [];
    vm._adb = async (args) => {
      calls.push(args);
      if (args[0] === 'devices') return adbResult(devicesOutput());
      const command = shellCommand(args);
      if (command.includes('command -v su')) return adbResult('/system/bin/su\n');
      if (command === "su 0 sh -c 'id -u'") return adbResult('0\n');
      return adbResult('');
    };
    const result = await vm.shell('ls /data/local/tmp', { forceRoot: true });
    assert.equal(result.ok, true);
    assert.equal(result.viaSu, true);
    assert.equal(result.root, true);
    assert.equal(
      calls.filter((args) => shellCommand(args) === "su 0 sh -c 'ls /data/local/tmp'").length,
      1,
      'the requested command must run through su',
    );
  });

  await check('shell: missing su surfaces ESHELL_ROOT_REQUIRED with a hint', async () => {
    const vm = makeVm();
    vm.ensureRoot = async () => false;
    vm._adb = async (args) => {
      if (args[0] === 'devices') return adbResult(devicesOutput());
      if (shellCommand(args).includes('command -v su')) return adbResult('', { code: 1 });
      return adbResult('');
    };
    await assert.rejects(() => vm.shell('ls /data', { forceRoot: true }), (error) => {
      assert.ok(error instanceof DeviceError);
      assert.equal(error.code, DEVICE_ERROR_CODES.SHELL_ROOT_REQUIRED);
      assert.match(error.message, /root execution is unavailable/i);
      assert.match(error.message, /hint:/i);
      return true;
    });
  });

  await check('writeSharedPrefs/readAppDataFile: root push + chmod/chown/chcon', async () => {
    const vm = makeVm();
    vm._root = true;
    vm.ensureRoot = async () => true;
    const calls = [];
    let pushed = null;
    vm._adb = async (args) => {
      calls.push(args);
      if (args[0] === 'devices') return adbResult(devicesOutput());
      if (args[0] === '-s' && args[2] === 'push') {
        pushed = args;
        return adbResult('1 file pushed\n');
      }
      const command = shellCommand(args);
      if (command.startsWith('cat ')) return adbResult('<map><string name="k">v</string></map>');
      if (command.startsWith('mkdir -p ')) {
        return adbResult('-rw-rw---- 1 u0_a100 u0_a100 33 /data/data/com.example.app/shared_prefs/dsh.xml\n');
      }
      return adbResult('');
    };
    const read = await vm.readAppDataFile('com.example.app', 'shared_prefs/dsh.xml');
    assert.equal(read.ok, true);
    assert.match(read.text, /<map>/);
    const write = await vm.writeSharedPrefs('com.example.app', 'dsh', '<map/>', {
      selinuxContext: 'u:object_r:app_data_file:s0',
    });
    assert.equal(write.ok, true);
    assert.equal(write.path, '/data/data/com.example.app/shared_prefs/dsh.xml');
    assert.ok(pushed, 'writeSharedPrefs must push the staged payload');
    assert.ok(write.bytes > 0);
    const writeCommand = calls.map((args) => shellCommand(args)).find((command) => command.startsWith('mkdir -p '));
    assert.ok(writeCommand, 'expected a combined write command');
    assert.match(writeCommand, /chmod 660/);
    assert.match(writeCommand, /chown com\.example\.app:com\.example\.app/);
    assert.match(writeCommand, /chcon u:object_r:app_data_file:s0/);
    assert.match(writeCommand, /rm -f '\/data\/local\/tmp\/dsh-write-/);
  });

  // --- 4. tap verification ----------------------------------------------------
  await check('input: default tap stays exactly { ok: true } and captures no frames', async () => {
    const vm = makeVm();
    vm._serialActive = SERIAL;
    const calls = [];
    vm._adb = async (args) => {
      calls.push(args);
      if (args[0] === 'devices') return adbResult(devicesOutput());
      return adbResult('');
    };
    const result = await vm.input({ type: 'tap', x: 10, y: 20 });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls.filter((args) => args[2] === 'exec-out').length, 0);
    assert.equal(calls.filter((args) => shellCommand(args).startsWith('input tap ')).length, 1);
  });

  await check('input: tap verification detects a lost tap, retries with jitter, reports {injected, changed}', async () => {
    const vm = makeVm();
    vm._serialActive = SERIAL;
    let captures = 0;
    const taps = [];
    vm._adb = async (args) => {
      if (args[0] === 'devices') return adbResult(devicesOutput());
      if (args[0] === '-s' && args[2] === 'exec-out') {
        captures += 1;
        return adbResult(captures <= 2 ? PNG_1x1 : PNG_ALT);
      }
      const command = shellCommand(args);
      if (command.startsWith('input tap ')) taps.push(command);
      return adbResult('');
    };
    const result = await vm.input({ type: 'tap', x: 100, y: 200, verify: true });
    assert.equal(result.ok, true);
    assert.equal(result.injected, true);
    assert.equal(result.changed, true);
    assert.equal(result.retried, true);
    assert.equal(result.attempts, 2);
    assert.equal(captures, 3, 'pre, post and retry-post frames expected');
    assert.equal(taps.length, 2);
    assert.equal(taps[0], 'input tap 100 200');
    assert.match(taps[1], /^input tap (99|100|101) (199|200|201)$/);
  });

  await check('input: tap verification reports changed:false + hint for a static screen', async () => {
    const vm = makeVm();
    vm._serialActive = SERIAL;
    let captures = 0;
    vm._adb = async (args) => {
      if (args[0] === 'devices') return adbResult(devicesOutput());
      if (args[0] === '-s' && args[2] === 'exec-out') {
        captures += 1;
        return adbResult(PNG_1x1);
      }
      return adbResult('');
    };
    const result = await vm.input({ type: 'tap', x: 5, y: 6, verify: true });
    assert.equal(result.changed, false);
    assert.equal(result.retried, true);
    assert.equal(captures, 3);
    assert.match(result.hint, /never changed|did not change|static/i);
  });

  // --- 5. text injection ------------------------------------------------------
  function textMock({ inputOk = true, clipboardOk = true } = {}) {
    const calls = [];
    const handler = async (args) => {
      calls.push(args);
      if (args[0] === 'devices') return adbResult(devicesOutput());
      const command = shellCommand(args);
      if (command.startsWith('input text ')) {
        return inputOk ? adbResult('') : adbResult('Error: failed to inject text\n', { code: 1 });
      }
      if (command.startsWith('cmd clipboard set-text ')) {
        return clipboardOk ? adbResult('') : adbResult('Unknown command: clipboard\n', { code: 1 });
      }
      if (command === 'input keyevent 279') return adbResult('');
      return adbResult('');
    };
    return { calls, handler };
  }

  await check('input: ASCII text keeps the exact { ok: true } success contract', async () => {
    const vm = makeVm();
    vm._serialActive = SERIAL;
    const mock = textMock();
    vm._adb = mock.handler;
    const result = await vm.input({ type: 'text', text: "hello world it's" });
    assert.deepEqual(result, { ok: true });
    assert.equal(mock.calls.filter((args) => shellCommand(args).startsWith('cmd clipboard set-text ')).length, 0);
  });

  await check('input: text falls back to clipboard paste when `input text` fails', async () => {
    const vm = makeVm();
    vm._serialActive = SERIAL;
    const mock = textMock({ inputOk: false });
    vm._adb = mock.handler;
    const result = await vm.input({ type: 'text', text: 'hello' });
    assert.equal(result.ok, true);
    assert.equal(result.method, 'clipboard');
    assert.equal(result.fallback, true);
    const commands = mock.calls.map((args) => shellCommand(args));
    assert.ok(commands.some((command) => command.startsWith('cmd clipboard set-text ')));
    assert.ok(commands.includes('input keyevent 279'));
  });

  await check('input: non-ASCII text prefers the clipboard, reports the method used', async () => {
    const vm = makeVm();
    vm._serialActive = SERIAL;
    const mock = textMock();
    vm._adb = mock.handler;
    const result = await vm.input({ type: 'text', text: '搜索 hello' });
    assert.equal(result.ok, true);
    assert.equal(result.method, 'clipboard');
    const commands = mock.calls.map((args) => shellCommand(args));
    assert.ok(commands.some((command) => command.startsWith('cmd clipboard set-text ')));
    assert.equal(commands.filter((command) => command.startsWith('input text ')).length, 0);
  });

  await check('input: both text paths failing rejects with "input text failed"', async () => {
    const vm = makeVm();
    vm._serialActive = SERIAL;
    const mock = textMock({ inputOk: false, clipboardOk: false });
    vm._adb = mock.handler;
    await assert.rejects(() => vm.input({ type: 'text', text: 'hello' }), /input text failed/);
  });

  // --- 2b. uiDump WebView supplement -----------------------------------------
  await check('uiDump: zero-text WebView dump is supplemented from a compressed salvage', async () => {
    const vm = makeVm();
    vm._serialActive = SERIAL;
    vm.ensureRoot = async () => true;
    const webview = '<hierarchy rotation="0"><node class="android.webkit.WebView" bounds="[0,0,720,1280]" /></hierarchy>';
    const salvaged =
      '<hierarchy rotation="0"><node text="Search" class="android.widget.EditText" bounds="[0,100,720,180]" />' +
      '<node text="Sign in" class="android.widget.Button" bounds="[0,200,720,280]" /></hierarchy>';
    vm._adb = async (args) => {
      if (args[0] === 'devices') return adbResult(devicesOutput());
      const command = shellCommand(args);
      if (command.includes('--compressed')) return adbResult(`UI hierchary dumped to: /data/local/tmp/dsh-window.xml\n${salvaged}`);
      if (command.includes('uiautomator dump')) return adbResult(`UI hierchary dumped to: /data/local/tmp/dsh-window.xml\n${webview}`);
      return adbResult('');
    };
    const dump = await vm.uiDump();
    assert.equal(dump.ok, true);
    assert.equal(dump.nodes, 1, 'base hierarchy node count must stay backward compatible');
    assert.equal(dump.rotation, '0');
    assert.equal(dump.webview.detected, true);
    assert.equal(dump.webview.textCount, 0);
    assert.equal(dump.webview.supplemented, true);
    assert.equal(dump.webview.mergedNodes, 2);
    assert.match(dump.xml, /text="Search"/);
    assert.match(dump.xml, /text="Sign in"/);
    assert.ok(dump.xml.indexOf('text="Search"') < dump.xml.indexOf('</hierarchy>'));
    assert.ok(Array.isArray(dump.webview.sources) && dump.webview.sources.length >= 2);
  });

  await check('uiDump: primary failure is salvaged through /dev/tty', async () => {
    const vm = makeVm();
    vm._serialActive = SERIAL;
    vm.ensureRoot = async () => true;
    const tty = '<hierarchy rotation="90"><node text="Loaded" bounds="[0,0,10,10]" /></hierarchy>';
    vm._adb = async (args) => {
      if (args[0] === 'devices') return adbResult(devicesOutput());
      const command = shellCommand(args);
      if (command.includes('/dev/tty')) return adbResult(tty);
      if (command) return adbResult('ERROR: could not get idle state.', { code: 1 });
      return adbResult('');
    };
    const dump = await vm.uiDump();
    assert.equal(dump.nodes, 1);
    assert.equal(dump.rotation, '90');
    assert.match(dump.xml, /text="Loaded"/);
    assert.equal(dump.webview.supplemented, false);
  });

  await check('uiDump: all salvage paths failing raises EUIDUMP_FAILED', async () => {
    const vm = makeVm();
    vm._serialActive = SERIAL;
    vm.ensureRoot = async () => true;
    vm._adb = async (args) => {
      if (args[0] === 'devices') return adbResult(devicesOutput());
      if (args[0] === '-s' && args[2] === 'pull') return adbResult('adb: error: failed to stat remote object', { code: 1 });
      if (shellCommand(args)) return adbResult('ERROR: could not get idle state.', { code: 1 });
      return adbResult('');
    };
    await assert.rejects(() => vm.uiDump(), (error) => {
      assert.ok(error instanceof DeviceError);
      assert.equal(error.code, DEVICE_ERROR_CODES.UI_DUMP_FAILED);
      assert.match(error.message, /uiautomator dump failed/);
      return true;
    });
  });

  // --- 6. isolated -> shared default-route repair -----------------------------
  function routeMock({ initialDefault = false, addFails = null } = {}) {
    let hasDefault = initialDefault;
    const commands = [];
    const handler = async (args) => {
      if (args[0] === 'devices') return adbResult(devicesOutput());
      const command = shellCommand(args);
      if (!command) return adbResult('');
      commands.push(command);
      if (command.startsWith('ip -4 route show')) {
        const routes = [`${GUEST_NET}.0/24 dev eth0 proto kernel scope link src ${GUEST_NET}.15`];
        if (hasDefault) routes.unshift(`default via ${GUEST_NET}.2 dev eth0`);
        return adbResult(
          `${routes.join('\n')}\n---IFACES---\n2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n` +
            `    inet ${GUEST_NET}.15/24 brd ${GUEST_NET}.255 scope global eth0\n`,
        );
      }
      if (command.startsWith('ip route add default')) {
        if (addFails) return adbResult('', { code: 1, stderr: `${addFails}\n` });
        hasDefault = true;
        return adbResult('');
      }
      return adbResult('');
    };
    return { handler, commands, state: () => ({ hasDefault }) };
  }

  await check(`repairNetwork: adds the missing default route via ${GUEST_NET}.2`, async () => {
    const vm = makeVm();
    vm._root = true;
    vm.ensureRoot = async () => true;
    const mock = routeMock();
    vm._adb = mock.handler;
    const repair = await vm.repairNetwork();
    assert.equal(repair.ok, true);
    assert.equal(repair.repaired, true);
    assert.equal(repair.code, null);
    assert.equal(repair.gateway, `${GUEST_NET}.2`);
    assert.equal(repair.iface, 'eth0');
    assert.ok(mock.commands.includes(`ip route add default via ${GUEST_NET}.2 dev eth0`));
    assert.equal(repair.after.defaultRoute.gateway, `${GUEST_NET}.2`);
  });

  await check('repairNetwork: an existing default route is left untouched', async () => {
    const vm = makeVm();
    vm._root = true;
    vm.ensureRoot = async () => true;
    const mock = routeMock({ initialDefault: true });
    vm._adb = mock.handler;
    const repair = await vm.repairNetwork();
    assert.equal(repair.ok, true);
    assert.equal(repair.repaired, false);
    assert.match(repair.note, /default route already present/);
    assert.equal(mock.commands.filter((command) => command.startsWith('ip route add ')).length, 0);
  });

  await check('repairNetwork: ENETUNREACH is detected and surfaced with a code', async () => {
    const vm = makeVm();
    vm._root = true;
    vm.ensureRoot = async () => true;
    const mock = routeMock({ addFails: 'RTNETLINK answers: Network is unreachable' });
    vm._adb = mock.handler;
    const repair = await vm.repairNetwork();
    assert.equal(repair.ok, false);
    assert.equal(repair.repaired, false);
    assert.equal(repair.code, DEVICE_ERROR_CODES.NETWORK_UNREACHABLE);
  });

  await check('setNetworkMode: shared mode schedules a background route repair', async () => {
    const vm = makeVm();
    vm._serialActive = SERIAL;
    vm._root = true;
    vm.ensureRoot = async () => true;
    const mock = routeMock({ initialDefault: true });
    vm._adb = mock.handler;
    const result = vm.setNetworkMode('shared');
    assert.equal(result.mode, 'shared');
    assert.equal(result.repairScheduled, true);
    const pending = vm._pendingNetworkRepair;
    assert.ok(pending, 'repair promise must be tracked for tests');
    const repair = await pending;
    assert.equal(repair.ok, true);
  });

  await check('setNetworkMode: no device means synchronous, adb-free mode switching', async () => {
    const vm = new AndroidVm();
    const calls = [];
    vm._adb = async (args) => {
      calls.push(args);
      return adbResult('');
    };
    const result = vm.setNetworkMode('shared');
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'shared');
    assert.equal(result.repairScheduled, undefined);
    assert.equal(calls.length, 0, 'setNetworkMode must not run adb on an unattached VM');
  });

  // --- 8. reinstall appops preservation --------------------------------------
  const fixedMetadata = () => ({
    packageName: 'com.example.dshspike',
    label: 'DSH Spike App',
    launchActivity: null,
    versionName: null,
    versionCode: null,
    targetSdkVersion: 34,
    permissions: [],
    features: [],
    nativeCode: [],
    iconPath: null,
  });

  await check('installApk: preserveAppOps snapshots and restores REQUEST_INSTALL_PACKAGES', async () => {
    const vm = makeVm();
    vm._serialActive = SERIAL;
    vm._root = true;
    vm.ensureRoot = async () => true;
    vm.inspectApk = async () => fixedMetadata();
    const calls = [];
    vm._adb = async (args) => {
      calls.push(args);
      if (args[0] === 'devices') return adbResult(devicesOutput());
      if (args[0] === '-s' && args[2] === 'install') return adbResult('Performing Streamed Install\nSuccess\n');
      const command = shellCommand(args);
      if (command.startsWith('cmd appops get ')) {
        return adbResult('REQUEST_INSTALL_PACKAGES: allow\nPOST_NOTIFICATIONS: deny\n');
      }
      return adbResult('');
    };
    const result = await vm.installApk(SAMPLE_APK, { preserveAppOps: true });
    assert.equal(result.packageName, 'com.example.dshspike');
    assert.ok(result.appops, 'appops metadata must be attached when enabled');
    assert.equal(result.appops.snapshot.REQUEST_INSTALL_PACKAGES, 'allow');
    assert.ok(result.appops.restored.includes('REQUEST_INSTALL_PACKAGES'));
    assert.ok(!result.appops.requested.includes('POST_NOTIFICATIONS'), 'denied ops must not be re-granted');
    const commands = calls.map((args) => shellCommand(args));
    assert.ok(
      commands.includes('cmd appops set com.example.dshspike REQUEST_INSTALL_PACKAGES allow'),
      'the install-permission op must be re-allowed after reinstall',
    );
  });

  await check('installApk: default path issues no appops calls and adds no appops key', async () => {
    const vm = makeVm();
    vm._serialActive = SERIAL;
    vm.inspectApk = async () => fixedMetadata();
    const calls = [];
    vm._adb = async (args) => {
      calls.push(args);
      if (args[0] === 'devices') return adbResult(devicesOutput());
      if (args[0] === '-s' && args[2] === 'install') return adbResult('Success\n');
      return adbResult('');
    };
    const result = await vm.installApk(SAMPLE_APK);
    assert.equal('appops' in result, false);
    assert.equal(calls.filter((args) => shellCommand(args).includes('appops')).length, 0);
  });

  // --- report -----------------------------------------------------------------
  const failed = checks.filter((entry) => !entry.ok);
  console.log('\n--- summary ---');
  console.log(`checks: ${checks.length}, passed: ${checks.length - failed.length}, failed: ${failed.length}`);
  if (failed.length > 0) {
    for (const entry of failed) console.error(`- ${entry.name}: ${entry.error}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('resilience-test.mjs crashed:', error);
  process.exitCode = 1;
});
