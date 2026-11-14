#!/usr/bin/env node
/**
 * Hermetic checks for lib/emulator-inventory.js.
 *
 * No real AVD/tools/ssh are touched: AVD homes are throwaway `os.tmpdir()`
 * directories, and all exec calls are injected fakes. Run with:
 *
 *   node spike/emulator-inventory-test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (relative) => import(pathToFileURL(path.join(REPO, relative)).href);

const {
  DEFAULT_EXEC_MAX_BYTES,
  DEFAULT_LOCAL_TIMEOUT_MS,
  DEFAULT_REMOTE_TIMEOUT_MS,
  REMOTE_SECTION,
  buildEmulatorInventory,
  buildRemoteInventoryCommand,
  collectLocalInventory,
  collectRemoteInventory,
  defaultAvdHome,
  parseAdbDevices,
  parseAvdIni,
  parseEmulatorList,
  parseHostInfo,
  parseRemoteInventoryOutput,
  parseUptime,
  scanLocalAvds,
  scanLocalAvdsReport,
} = await load('lib/emulator-inventory.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-emulator-inventory-'));
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

// ---------------------------------------------------------------------------
// Fixtures + helpers (privacy-safe: no personal paths, no real IPs/hosts)
// ---------------------------------------------------------------------------

function makeDir(prefix) {
  return fs.mkdtempSync(path.join(TMP, `${prefix}-`));
}

function writeTree(avdHome, name, iniText, configText) {
  fs.writeFileSync(path.join(avdHome, `${name}.ini`), iniText);
  const avdDir = path.join(avdHome, `${name}.avd`);
  fs.mkdirSync(avdDir, { recursive: true });
  if (configText !== undefined) fs.writeFileSync(path.join(avdDir, 'config.ini'), configText);
  return avdDir;
}

function defaultConfig(overrides = {}) {
  const values = {
    'PlayStore.enabled': 'no',
    'abi.type': 'x86_64',
    'hw.cpu.arch': 'x86_64',
    'hw.ramSize': '1536M',
    'hw.lcd.width': '720',
    'hw.lcd.height': '1280',
    'hw.lcd.density': '320',
    'image.sysdir.1': `${path.join('system-images', 'android-34', 'default', 'x86_64')}${path.sep}`,
    'disk.dataPartition.size': '6442450944',
    'snapshot.present': 'true',
    ...overrides,
  };
  return Object.entries(values)
    .map(([key, value]) => `${key} = ${value}`)
    .join('\n');
}

function makeAvdHome(prefix = 'avd') {
  return makeDir(prefix);
}

function fakeExec(handler) {
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    return handler(file, args, options, calls.length);
  };
  exec.calls = calls;
  return exec;
}

function execNote(...parts) {
  return parts.join(' | ');
}

const ADB_L_VARIANTS = [
  'List of devices attached\r',
  'emulator-5554\tdevice product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1\r',
  '127.0.0.1:57843\tdevice product:unknown model:unknown device:unknown transport_id:2\r',
  'R58M000TEST\tunauthorized usb:1-1 transport_id:3\r',
  'emulator-5556\toffline transport_id:4\r',
  '',
].join('\n');

const ADB_L_LOCAL = [
  'List of devices attached',
  'emulator-5554\tdevice product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1',
  '',
].join('\n');

const ADB_L_REMOTE = [
  'List of devices attached',
  'emulator-5554\tdevice product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1',
  '127.0.0.1:57843\tdevice product:unknown model:unknown device:unknown transport_id:2',
  '',
].join('\n');

function remoteOutput(overrides = {}) {
  const sections = {
    avds: 'pixel_api34\ndsh_lab\n',
    devices: ADB_L_REMOTE,
    host: 'dev-host\nx86_64\n 13:40:27 up 2 days,  3:21,  1 user,  load average: 0.08, 0.03, 0.01\n',
    ...overrides,
  };
  return [
    `${REMOTE_SECTION.avds}\n${sections.avds}`,
    `${REMOTE_SECTION.devices}\n${sections.devices}`,
    `${REMOTE_SECTION.host}\n${sections.host}`,
  ].join('');
}

// ---------------------------------------------------------------------------
// AVD ini parsing / AVD home scanning
// ---------------------------------------------------------------------------

check('parseAvdIni parses basic AVD ini keys', () => {
  const parsed = parseAvdIni(
    'avd.ini.encoding=UTF-8\npath=C:/Android/avd/pixel.avd\npath.rel=avd/pixel.avd\ntarget=android-34\n',
  );
  assert.equal(parsed.target, 'android-34');
  assert.equal(parsed.path, 'C:/Android/avd/pixel.avd');
  assert.equal(parsed['path.rel'], 'avd/pixel.avd');
});

check('parseAvdIni handles spaces, BOM, CRLF, comments and quoted values', () => {
  const text =
    '\uFEFF# leading comment\r\n[avd]\r\navd.ini.encoding = UTF-8\r\nhw.ramSize = 1536M ; inline note\r\nfoo = "quoted value"\r\nbar = \'single quoted\'\r\nbaz = a=b\r\n\r\nhw.lcd.width = 720\r\n';
  const parsed = parseAvdIni(text);
  assert.equal(parsed['avd.ini.encoding'], 'UTF-8');
  assert.equal(parsed.foo, 'quoted value');
  assert.equal(parsed.bar, 'single quoted');
  assert.equal(parsed.baz, 'a=b');
  assert.equal(parsed['hw.lcd.width'], '720');
  assert.equal(parsed['hw.ramSize'], '1536M ; inline note');
  assert.equal(parsed['[avd]'], undefined);
});

check('parseAvdIni ignores malformed lines and non-string input', () => {
  const parsed = parseAvdIni('no equals sign here\n=missing key\nkey=\nok=value\n');
  assert.deepEqual(parsed, { key: '', ok: 'value' });
  assert.deepEqual(parseAvdIni(null), {});
  assert.deepEqual(parseAvdIni(undefined), {});
  assert.deepEqual(parseAvdIni(42), {});
});

check('defaultAvdHome prefers ANDROID_AVD_HOME and falls back to ~/.android/avd', () => {
  assert.equal(defaultAvdHome({ env: { ANDROID_AVD_HOME: '/srv/and/avd' }, home: '/srv/user' }), '/srv/and/avd');
  assert.equal(
    defaultAvdHome({ env: {}, home: path.join(TMP, 'home-dir') }),
    path.join(TMP, 'home-dir', '.android', 'avd'),
  );
});

check('scanLocalAvds reads config.ini fields and snapshot count', async () => {
  const avdHome = makeAvdHome();
  const name = 'pixel_api34';
  const avdDir = writerAvd(avdHome, name, { config: defaultConfig() });
  fs.mkdirSync(path.join(avdDir, 'snapshots', 'default_boot'), { recursive: true });
  fs.mkdirSync(path.join(avdDir, 'snapshots', 'snapshot_1'), { recursive: true });
  const sdkRoot = path.join(TMP, 'AndSdk');
  const avds = await scanLocalAvds({ avdHome, sdkRoot, env: {} });
  assert.equal(avds.length, 1);
  const avd = avds[0];
  assert.equal(avd.name, name);
  assert.equal(avd.path, avdDir);
  assert.equal(avd.target, 'android-34');
  assert.equal(avd.abi, 'x86_64');
  assert.deepEqual(avd.hwLcd, { width: 720, height: 1280, density: 320 });
  assert.equal(avd.hwRamMb, 1536);
  assert.equal(avd.diskBytes, 6442450944);
  assert.equal(avd.snapshotCount, 2);
  assert.equal(avd.sysdir, path.join(sdkRoot, 'system-images', 'android-34', 'default', 'x86_64'));
  assert.equal(avd.error, undefined);

  function writerAvd(home, avdName, options) {
    const dir = path.join(home, `${avdName}.avd`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(home, `${avdName}.ini`),
      `avd.ini.encoding=UTF-8\npath=${dir}\npath.rel=${path.join('avd', `${avdName}.avd`)}\ntarget=android-34\n`,
    );
    fs.writeFileSync(path.join(dir, 'config.ini'), options.config);
    return dir;
  }
});

check('scanLocalAvds resolves relative path.rel and reports a missing config.ini', async () => {
  const avdHome = makeAvdHome();
  const name = 'broken_avd';
  fs.writeFileSync(
    path.join(avdHome, `${name}.ini`),
    `path.rel=${path.join('avd', `${name}.avd`)}\ntarget=android-30\n`,
  );
  const avds = await scanLocalAvds({ avdHome, env: {} });
  assert.equal(avds.length, 1);
  const avd = avds[0];
  assert.equal(avd.name, name);
  assert.equal(avd.path, path.join(avdHome, 'avd', `${name}.avd`));
  assert.equal(avd.target, 'android-30');
  assert.equal(avd.error, 'missing config.ini');
  assert.equal(avd.snapshotCount, 0);
  assert.equal(avd.abi, null);
});

check('scanLocalAvds honors an absolute ini path and derives target/abi from sysdir', async () => {
  const external = makeDir('external');
  fs.writeFileSync(
    path.join(external, 'config.ini'),
    defaultConfig({
      'abi.type': 'arm64-v8a',
      'image.sysdir.1': path.join('system-images', 'android-29', 'default', 'x86_64'),
    }),
  );
  const avdHome = makeAvdHome();
  fs.writeFileSync(path.join(avdHome, 'external_avd.ini'), `path=${external}\n`);
  const avds = await scanLocalAvds({ avdHome, env: {} });
  assert.equal(avds.length, 1);
  assert.equal(avds[0].path, external);
  assert.equal(avds[0].target, 'android-29');
  assert.equal(avds[0].abi, 'arm64-v8a');
  assert.equal(
    path.normalize(avds[0].sysdir).replace(/[\\/]+$/, ''),
    path.join('system-images', 'android-29', 'default', 'x86_64'),
  );
});

check('scanLocalAvds returns [] for a missing AVD home and the report explains why', async () => {
  const missing = path.join(TMP, 'no-such-avd-home-xyz');
  const avds = await scanLocalAvds({ avdHome: missing, env: {} });
  assert.deepEqual(avds, []);
  const report = await scanLocalAvdsReport({ avdHome: missing, env: {} });
  assert.equal(report.ok, true);
  assert.equal(report.avdHome, missing);
  assert.deepEqual(report.avds, []);
  assert.match(report.error, /not readable/);
});

check('scanLocalAvdsReport tolerates an injected unreadable filesystem', async () => {
  const report = await scanLocalAvdsReport({
    avdHome: path.join(TMP, 'injected-fs'),
    env: {},
    fs: {
      readdir: async () => {
        const error = new Error('EACCES: permission denied');
        error.code = 'EACCES';
        throw error;
      },
      readFile: async () => {
        throw new Error('readFile must not be called when the directory listing fails');
      },
    },
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.avds, []);
  assert.match(report.error, /EACCES/);
});

// ---------------------------------------------------------------------------
// Output parsers
// ---------------------------------------------------------------------------

check('parseAdbDevices parses device/offline/unauthorized rows with -l fields and CRLF', () => {
  const devices = parseAdbDevices(ADB_L_VARIANTS);
  assert.equal(devices.length, 4);
  assert.deepEqual(devices[0], {
    serial: 'emulator-5554',
    state: 'device',
    product: 'sdk_gphone64_x86_64',
    model: 'sdk_gphone64_x86_64',
    device: 'emu64xa',
    transportId: 1,
  });
  assert.equal(devices[1].serial, '127.0.0.1:57843');
  assert.equal(devices[2].state, 'unauthorized');
  assert.equal(devices[2].transportId, 3);
  assert.equal(devices[3].state, 'offline');
  assert.equal(devices[3].transportId, 4);
});

check('parseAdbDevices skips daemon/error noise, keeps no-permissions state and dedupes', () => {
  const text = [
    '* daemon not running; starting now at tcp:5037',
    '* daemon started successfully',
    'List of devices attached',
    '127.0.0.1:5555\tno permissions (user in plugdev group; are your udev rules wrong?)',
    'error: no devices/emulators found',
    'R58M000TEST\tdevice',
    'R58M000TEST\toffline',
    '',
  ].join('\n');
  const devices = parseAdbDevices(text);
  assert.equal(devices.length, 2);
  assert.equal(devices[0].serial, '127.0.0.1:5555');
  assert.equal(devices[0].state, 'no permissions');
  assert.equal(devices[1].serial, 'R58M000TEST');
  assert.equal(devices[1].state, 'device');
});

check('parseAdbDevices returns [] for empty/garbage input', () => {
  assert.deepEqual(parseAdbDevices(''), []);
  assert.deepEqual(parseAdbDevices(null), []);
  assert.deepEqual(parseAdbDevices(undefined), []);
  assert.deepEqual(parseAdbDevices('some random text\nnot a device line here\n'), []);
});

check('parseEmulatorList trims names, ignores tool noise and dedupes', () => {
  const stdout = [
    '',
    'pixel_api34',
    '  dsh_lab  ',
    'INFO    | Storing crashdata in: /tmp/',
    'WARNING | unexpected thing happened',
    'PANIC: Broken AVD system path. Check your ANDROID_SDK_ROOT value!',
    'emulator: ERROR: x86 emulation currently requires hardware acceleration!',
    '/data/opt/android-sdk/emulator/emulator: 1: /opt/missing: not found',
    'pixel_api34',
    '',
  ].join('\r\n');
  assert.deepEqual(parseEmulatorList(stdout), ['pixel_api34', 'dsh_lab']);
});

check('parseEmulatorList returns [] for garbage', () => {
  assert.deepEqual(parseEmulatorList(''), []);
  assert.deepEqual(parseEmulatorList(null), []);
  assert.deepEqual(parseEmulatorList('hello world\n!@#$%\nbad name\n'), []);
});

check('parseUptime extracts up time, users and load average', () => {
  const parsed = parseUptime(' 13:40:27 up 2 days,  3:21,  1 user,  load average: 0.08, 0.03, 0.01');
  assert.equal(parsed.up, 'up 2 days, 3:21');
  assert.equal(parsed.upSeconds, 2 * 86400 + 3 * 3600 + 21 * 60);
  assert.equal(parsed.users, 1);
  assert.deepEqual(parsed.loadAverage, [0.08, 0.03, 0.01]);
  const short = parseUptime(' 09:00:00 up 5 min,  2 users,  load average: 1.00, 0.50, 0.25');
  assert.equal(short.up, 'up 5 min');
  assert.equal(short.upSeconds, 300);
  assert.equal(short.users, 2);
});

check('parseHostInfo parses hostname/arch/uptime and tolerates missing commands', () => {
  const parsed = parseHostInfo(
    'dev-host\nx86_64\n 13:40:27 up 2 days,  3:21,  1 user,  load average: 0.08, 0.03, 0.01\n',
  );
  assert.equal(parsed.hostname, 'dev-host');
  assert.equal(parsed.arch, 'x86_64');
  assert.equal(parsed.uptime, 'up 2 days, 3:21');
  const partial = parseHostInfo(
    'sh: 1: hostname: not found\nx86_64\n 13:40:27 up 5 min,  load average: 0.10, 0.20, 0.30\n',
  );
  assert.equal(partial.hostname, null);
  assert.equal(partial.arch, 'x86_64');
  assert.equal(partial.uptime, 'up 5 min');
  assert.deepEqual(parseHostInfo(''), { hostname: null, arch: null, uptime: null });
});

// ---------------------------------------------------------------------------
// Local collection
// ---------------------------------------------------------------------------

check('collectLocalInventory merges filesystem AVDs, emulator list and adb devices', async () => {
  const avdHome = makeAvdHome();
  const pixelDir = path.join(avdHome, 'pixel_api34.avd');
  fs.mkdirSync(pixelDir, { recursive: true });
  fs.writeFileSync(path.join(avdHome, 'pixel_api34.ini'), `path=${pixelDir}\ntarget=android-34\n`);
  fs.writeFileSync(path.join(pixelDir, 'config.ini'), defaultConfig());
  const secondDir = path.join(avdHome, 'second_avd.avd');
  fs.mkdirSync(secondDir, { recursive: true });
  fs.writeFileSync(path.join(avdHome, 'second_avd.ini'), `path=${secondDir}\ntarget=android-33\n`);
  fs.writeFileSync(path.join(secondDir, 'config.ini'), defaultConfig({ 'target': 'android-33' }));

  const emulatorPath = path.join(TMP, 'sdk', 'emulator', 'emulator');
  const adbPath = path.join(TMP, 'sdk', 'platform-tools', 'adb');
  const exec = fakeExec(async (file, args) => {
    if (args.includes('-list-avds')) {
      return { code: 0, stdout: 'pixel_api34\nemulator_only\nINFO noise\n', stderr: '' };
    }
    if (args.includes('devices')) {
      return { code: 0, stdout: ADB_L_LOCAL, stderr: '' };
    }
    throw new Error(`unexpected command: ${file}`);
  });
  const result = await collectLocalInventory({
    avdHome,
    emulatorPath,
    adbPath,
    env: {},
    exec,
    timeoutMs: DEFAULT_LOCAL_TIMEOUT_MS,
    runningInstances: [
      { id: 'default', avdName: 'pixel_api34', serial: 'emulator-5554', kind: 'local', state: 'ready' },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.avds.map((avd) => avd.name),
    ['emulator_only', 'pixel_api34', 'second_avd'],
  );
  const pixel = result.avds.find((avd) => avd.name === 'pixel_api34');
  assert.equal(pixel.source, 'both');
  assert.deepEqual(pixel.running, { instanceId: 'default', serial: 'emulator-5554', state: 'ready' });
  const second = result.avds.find((avd) => avd.name === 'second_avd');
  assert.equal(second.source, 'filesystem');
  assert.equal(second.running, null);
  const emulatorOnly = result.avds.find((avd) => avd.name === 'emulator_only');
  assert.equal(emulatorOnly.source, 'emulator');
  assert.equal(emulatorOnly.path, null);
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].serial, 'emulator-5554');
  assert.equal(result.devices[0].transportId, 1);
  assert.deepEqual(result.notes, []);
  assert.equal(exec.calls.length, 2);
  const emulatorCall = exec.calls.find((call) => call.args.includes('-list-avds'));
  const adbCall = exec.calls.find((call) => call.args.includes('devices'));
  assert.equal(emulatorCall.file, emulatorPath);
  assert.equal(adbCall.file, adbPath);
  assert.equal(emulatorCall.options.timeoutMs, DEFAULT_LOCAL_TIMEOUT_MS);
  assert.equal(emulatorCall.options.maxBytes, DEFAULT_EXEC_MAX_BYTES);
  assert.equal(emulatorCall.options.env.ANDROID_AVD_HOME, avdHome);
});

check('collectLocalInventory attaches running-only AVDs and ignores remote instances', async () => {
  const avdHome = makeAvdHome();
  const pixelDir = path.join(avdHome, 'pixel_api34.avd');
  fs.mkdirSync(pixelDir, { recursive: true });
  fs.writeFileSync(path.join(avdHome, 'pixel_api34.ini'), `path=${pixelDir}\n`);
  fs.writeFileSync(path.join(pixelDir, 'config.ini'), defaultConfig());
  const exec = () => {
    throw new Error('exec must not be called when no tool paths are configured');
  };
  const result = await collectLocalInventory({
    avdHome,
    env: {},
    emulatorPath: '',
    adbPath: '',
    exec,
    runningInstances: [
      { id: 'extra-1', avdName: 'ghost_avd', serial: 'emulator-5556', kind: 'extra', state: 'booting' },
      { id: 'remote-a', avdName: 'remote_avd', serial: '127.0.0.1:57843', kind: 'remote', state: 'ready' },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.avds.map((avd) => avd.name), ['ghost_avd', 'pixel_api34']);
  const ghost = result.avds.find((avd) => avd.name === 'ghost_avd');
  assert.equal(ghost.source, 'running');
  assert.deepEqual(ghost.running, { instanceId: 'extra-1', serial: 'emulator-5556', state: 'booting' });
  assert.equal(result.avds.some((avd) => avd.name === 'remote_avd'), false);
  assert.deepEqual(
    result.runningInstances.map((instance) => instance.id),
    ['extra-1'],
  );
});

check('collectLocalInventory works when binaries are missing without throwing', async () => {
  const avdHome = makeAvdHome();
  const avdDir = path.join(avdHome, 'local_only.avd');
  fs.mkdirSync(avdDir, { recursive: true });
  fs.writeFileSync(path.join(avdHome, 'local_only.ini'), `path=${avdDir}\ntarget=android-34\n`);
  fs.writeFileSync(path.join(avdDir, 'config.ini'), defaultConfig());
  const exec = () => {
    throw new Error('exec must not be called when no tool paths are configured');
  };
  const result = await collectLocalInventory({ avdHome, env: {}, exec });
  assert.equal(result.ok, true);
  assert.deepEqual(result.avds.map((avd) => avd.name), ['local_only']);
  assert.deepEqual(result.devices, []);
  const notes = execNote(...result.notes);
  assert.match(notes, /emulator binary is not configured/);
  assert.match(notes, /adb binary is not configured/);
  assert.equal(exec.calls, undefined);
});

check('collectLocalInventory reports exec failures/timeouts in notes without throwing', async () => {
  const avdHome = makeAvdHome();
  const exec = fakeExec(async (file, args) => {
    if (args.includes('-list-avds')) throw new Error('spawn ENOENT');
    return { code: null, stdout: '', stderr: '', error: null, timedOut: true };
  });
  const result = await collectLocalInventory({
    avdHome,
    env: {},
    emulatorPath: path.join(TMP, 'tools', 'emulator'),
    adbPath: path.join(TMP, 'tools', 'adb'),
    exec,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.avds, []);
  assert.deepEqual(result.devices, []);
  const notes = execNote(...result.notes);
  assert.match(notes, /emulator -list-avds failed: spawn ENOENT/);
  assert.match(notes, /adb devices timed out after 5000ms/);
});

check('collectLocalInventory bounds a misbehaving injected exec by a hard deadline', async () => {
  const avdHome = makeAvdHome();
  const exec = () => new Promise(() => {});
  const started = Date.now();
  const result = await collectLocalInventory({
    avdHome,
    env: {},
    emulatorPath: path.join(TMP, 'tools', 'emulator'),
    adbPath: path.join(TMP, 'tools', 'adb'),
    exec,
    timeoutMs: 500,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, true);
  assert.ok(elapsed < 6000, `hung exec should be bounded, took ${elapsed}ms`);
  const notes = execNote(...result.notes);
  assert.match(notes, /timed out after 500ms/);
});

check('collectLocalInventory derives emulator/adb paths from sdkRoot', async () => {
  const avdHome = makeAvdHome();
  const sdkRoot = path.join(TMP, 'AndSdk');
  const exec = fakeExec(async () => ({ code: 0, stdout: '', stderr: '' }));
  const result = await collectLocalInventory({ avdHome, sdkRoot, env: {}, exec });
  const suffix = process.platform === 'win32' ? '.exe' : '';
  assert.equal(result.ok, true);
  assert.equal(exec.calls.length, 2);
  const files = exec.calls.map((call) => call.file).sort();
  assert.deepEqual(files, [
    path.join(sdkRoot, 'emulator', `emulator${suffix}`),
    path.join(sdkRoot, 'platform-tools', `adb${suffix}`),
  ]);
  assert.deepEqual(result.notes, []);
  assert.deepEqual(result.avds, []);
  assert.deepEqual(result.devices, []);
});

// ---------------------------------------------------------------------------
// Remote command building
// ---------------------------------------------------------------------------

check('buildRemoteInventoryCommand builds one ssh argv with markers and quoted paths', () => {
  const built = buildRemoteInventoryCommand(
    {
      host: '192.0.2.10',
      user: 'dev',
      sshPort: 2222,
      keyPath: '/opt/keys/id_ed25519',
      sdkRoot: '/opt/android-sdk',
    },
    { timeoutMs: 6000 },
  );
  const command = [
    'echo @@SECTION:AVDS',
    "'/opt/android-sdk/emulator/emulator' -list-avds 2>&1",
    'echo @@SECTION:DEVICES',
    "'/opt/android-sdk/platform-tools/adb' devices -l 2>&1",
    'echo @@SECTION:HOST',
    'hostname 2>&1',
    'uname -m 2>&1',
    'uptime 2>&1',
  ].join('; ');
  assert.equal(built.sshPath, 'ssh');
  assert.equal(built.host, '192.0.2.10');
  assert.equal(built.user, 'dev');
  assert.equal(built.sshPort, 2222);
  assert.equal(built.emulatorPath, '/opt/android-sdk/emulator/emulator');
  assert.equal(built.adbPath, '/opt/android-sdk/platform-tools/adb');
  assert.deepEqual(built.args, [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=6',
    '-i',
    '/opt/keys/id_ed25519',
    '-p',
    '2222',
    'dev@192.0.2.10',
    command,
  ]);
  assert.equal(built.args.length, 10);
});

check('buildRemoteInventoryCommand rejects injection-shaped hosts, users and key paths', () => {
  assert.throws(() => buildRemoteInventoryCommand({ host: 'evil host' }), /invalid SSH host/);
  assert.throws(() => buildRemoteInventoryCommand({ host: 'dev-host;rm -rf /' }), /invalid SSH host/);
  assert.throws(() => buildRemoteInventoryCommand({ host: 'dev-host"quote' }), /invalid SSH host/);
  assert.throws(
    () => buildRemoteInventoryCommand({ host: 'dev-host', user: '-oProxyCommand=calc' }),
    /invalid SSH user/,
  );
  assert.throws(
    () => buildRemoteInventoryCommand({ host: 'dev-host', keyPath: '/opt/key\nInjected' }),
    /control characters/,
  );
});

check('buildRemoteInventoryCommand quotes shell metacharacters in profile paths', () => {
  const built = buildRemoteInventoryCommand({
    host: 'dev-host',
    sdkRoot: "/opt/weird'; touch /tmp/pwn; '",
  });
  // Every `'` becomes the canonical POSIX escape sequence `'\''`; sdkRoot is
  // embedded in both the emulator and adb paths, so two quotes -> 4 escapes.
  assert.equal(built.command.split("'\\''").length - 1, 4);
  assert.match(built.command, /'\/opt\/weird'\\''/);
  assert.match(built.command, /-list-avds 2>&1/);
  assert.match(built.command, /devices -l 2>&1/);
});

check('buildRemoteInventoryCommand honors overrides and omits -i without a key', () => {
  const built = buildRemoteInventoryCommand({
    host: 'dev-host',
    emulatorPath: '/custom/bin/emulator',
    adbPath: '/custom/bin/adb',
  });
  assert.equal(built.sdkRoot, null);
  assert.ok(built.command.includes("'/custom/bin/emulator' -list-avds 2>&1"));
  assert.ok(built.command.includes("'/custom/bin/adb' devices -l 2>&1"));
  assert.equal(built.args.length, 8);
  assert.deepEqual(built.args.slice(0, 4), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']);
  assert.equal(built.args[4], '-p');
  assert.equal(built.args[5], '22');
  assert.equal(built.args[6], 'root@dev-host');
  assert.equal(built.args.includes('-i'), false);
  assert.equal(built.timeoutMs, DEFAULT_REMOTE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Remote collection
// ---------------------------------------------------------------------------

check('collectRemoteInventory parses a full marker output with one ssh invocation', async () => {
  const profile = {
    host: '192.0.2.10',
    user: 'dev',
    sshPort: 2222,
    keyPath: '/opt/keys/id_ed25519',
    sdkRoot: '/opt/android-sdk',
  };
  const exec = fakeExec(async () => ({ code: 0, stdout: remoteOutput(), stderr: '' }));
  const result = await collectRemoteInventory({ profile, exec, timeoutMs: 6000 });
  assert.equal(exec.calls.length, 1);
  const call = exec.calls[0];
  assert.equal(call.file, 'ssh');
  assert.equal(call.options.timeoutMs, 6000);
  assert.ok(call.options.maxBytes > 0);
  assert.deepEqual(call.args.slice(0, 8), [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=6',
    '-i',
    '/opt/keys/id_ed25519',
    '-p',
    '2222',
  ]);
  assert.equal(call.args[8], 'dev@192.0.2.10');
  assert.ok(call.args[9].includes('@@SECTION:AVDS'));
  assert.ok(call.args[9].includes("'/opt/android-sdk/emulator/emulator' -list-avds"));
  assert.equal(result.ok, true);
  assert.equal(result.host.reachable, true);
  assert.equal(result.host.hostname, 'dev-host');
  assert.equal(result.host.arch, 'x86_64');
  assert.equal(result.host.uptime, 'up 2 days, 3:21');
  assert.equal(result.host.note, null);
  assert.deepEqual(result.avds, [
    { name: 'pixel_api34', target: null, path: null },
    { name: 'dsh_lab', target: null, path: null },
  ]);
  assert.equal(result.devices.length, 2);
  assert.equal(result.devices[0].serial, 'emulator-5554');
  assert.equal(result.devices[0].transportId, 1);
  assert.equal(result.devices[1].serial, '127.0.0.1:57843');
  assert.deepEqual(result.profile, {
    host: '192.0.2.10',
    user: 'dev',
    sshPort: 2222,
    sdkRoot: '/opt/android-sdk',
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('keyPath'), false);
  assert.equal(serialized.includes('id_ed25519'), false);
});

check('collectRemoteInventory reports a non-zero ssh exit as reachable:false', async () => {
  const exec = fakeExec(async () => ({
    code: 255,
    stdout: '',
    stderr: 'Permission denied (publickey).',
    error: null,
  }));
  const result = await collectRemoteInventory({
    profile: { host: '192.0.2.10', user: 'dev' },
    exec,
  });
  assert.equal(exec.calls.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.host.reachable, false);
  assert.equal(result.host.hostname, null);
  assert.equal(result.profile.host, '192.0.2.10');
  assert.match(result.error, /ssh exited with code 255/);
  assert.match(result.error, /Permission denied/);
  assert.deepEqual(result.avds, []);
  assert.deepEqual(result.devices, []);
});

check('collectRemoteInventory reports timeouts and thrown exec errors without throwing', async () => {
  const timedOut = await collectRemoteInventory({
    profile: { host: '192.0.2.10', user: 'dev' },
    exec: fakeExec(async () => ({ code: null, stdout: '', stderr: '', error: null, timedOut: true })),
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.host.reachable, false);
  assert.match(timedOut.error, /timed out/);

  const thrown = await collectRemoteInventory({
    profile: { host: '192.0.2.10', user: 'dev' },
    exec: async () => {
      throw new Error('spawn ssh ENOENT');
    },
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.host.reachable, false);
  assert.match(thrown.error, /ssh failed: spawn ssh ENOENT/);
});

check('parseRemoteInventoryOutput tolerates partial sections and garbage', () => {
  const partial = parseRemoteInventoryOutput('@@SECTION:AVDS\npixel_api34\n');
  assert.deepEqual(partial.avds, [{ name: 'pixel_api34', target: null, path: null }]);
  assert.deepEqual(partial.devices, []);
  assert.equal(partial.host.hostname, null);
  assert.ok(partial.notes.some((note) => /missing the devices section/.test(note)));
  assert.ok(partial.notes.some((note) => /missing the host section/.test(note)));

  const garbage = parseRemoteInventoryOutput('random junk\nline two\n');
  assert.deepEqual(garbage.avds, []);
  assert.deepEqual(garbage.devices, []);
  assert.deepEqual(garbage.host, { hostname: null, arch: null, uptime: null });
  assert.match(garbage.notes[0], /no section markers/);
});

check('collectRemoteInventory succeeds with partial output and records a note', async () => {
  const exec = fakeExec(async () => ({
    code: 0,
    stdout: '@@SECTION:AVDS\npixel_api34\n',
    stderr: '',
  }));
  const result = await collectRemoteInventory({
    profile: { host: '192.0.2.10', user: 'dev' },
    exec,
  });
  assert.equal(result.ok, true);
  assert.equal(result.host.reachable, true);
  assert.equal(result.host.hostname, null);
  assert.deepEqual(result.avds.map((avd) => avd.name), ['pixel_api34']);
  assert.match(result.host.note, /missing the devices section/);
});

check('collectRemoteInventory rejects invalid profiles without executing ssh', async () => {
  const exec = fakeExec(async () => {
    throw new Error('exec must not be called for an invalid profile');
  });
  const result = await collectRemoteInventory({
    profile: { host: 'evil host', user: 'dev' },
    exec,
  });
  assert.equal(exec.calls.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.host.reachable, false);
  assert.match(result.error, /invalid SSH host/);
  assert.deepEqual(result.avds, []);
  assert.deepEqual(result.devices, []);
});

// ---------------------------------------------------------------------------
// Inventory assembly
// ---------------------------------------------------------------------------

check('buildEmulatorInventory produces a stable JSON-safe document with defaults', () => {
  const built = buildEmulatorInventory({});
  assert.equal(built.ok, true);
  assert.ok(Number.isFinite(Date.parse(built.updatedAt)));
  assert.deepEqual(built.local, { avds: [], devices: [], runningInstances: [] });
  assert.deepEqual(built.remotes, []);
  assert.doesNotThrow(() => JSON.stringify(built));
});

check('buildEmulatorInventory dedupes, attaches running refs and strips remote secrets', () => {
  const built = buildEmulatorInventory({
    updatedAt: '2026-01-02T03:04:05.000Z',
    local: {
      avds: [
        { name: 'zeta_avd', path: '/opt/avd/zeta.avd', target: 'android-34', running: null },
        { name: 'atom_avd', path: '/opt/avd/atom.avd', target: 'android-34' },
        { name: 'atom_avd', path: '/opt/avd/atom.avd', target: 'android-34' },
      ],
      devices: [
        { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64_x86_64', transportId: 1 },
        { serial: 'emulator-5554', state: 'offline' },
      ],
      runningInstances: [
        { id: 'default', avdName: 'zeta_avd', serial: 'emulator-5556', kind: 'local', state: 'ready' },
      ],
      error: 'partial adb failure',
    },
    remotes: [
      {
        ok: true,
        profile: {
          host: '192.0.2.10',
          user: 'dev',
          sshPort: 2222,
          sdkRoot: '/opt/android-sdk',
          keyPath: '/opt/keys/id_ed25519',
          sshPath: 'ssh',
        },
        host: { reachable: true, hostname: 'dev-host', arch: 'x86_64', uptime: 'up 1 day' },
        avds: [{ name: 'dsh_lab' }, { name: 'dsh_lab' }],
        devices: [
          { serial: '127.0.0.1:57843', state: 'device' },
          { serial: '127.0.0.1:57843', state: 'device' },
        ],
      },
    ],
  });
  assert.equal(built.updatedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(built.ok, true);
  assert.deepEqual(
    built.local.avds.map((avd) => avd.name),
    ['atom_avd', 'zeta_avd'],
  );
  const atom = built.local.avds.find((avd) => avd.name === 'atom_avd');
  const zeta = built.local.avds.find((avd) => avd.name === 'zeta_avd');
  assert.equal(atom.running, null);
  assert.deepEqual(zeta.running, { instanceId: 'default', serial: 'emulator-5556', state: 'ready' });
  assert.equal(built.local.devices.length, 1);
  assert.equal(built.local.devices[0].serial, 'emulator-5554');
  assert.equal(built.local.devices[0].state, 'device');
  assert.equal(built.local.devices[0].model, 'sdk_gphone64_x86_64');
  assert.equal(built.local.error, 'partial adb failure');
  assert.equal(built.remotes.length, 1);
  const remote = built.remotes[0];
  assert.deepEqual(remote.profile, {
    host: '192.0.2.10',
    user: 'dev',
    sshPort: 2222,
    sdkRoot: '/opt/android-sdk',
  });
  assert.deepEqual(remote.avds, [{ name: 'dsh_lab', target: null, path: null }]);
  assert.equal(remote.devices.length, 1);
  assert.equal(remote.host.reachable, true);
  assert.equal(remote.host.hostname, 'dev-host');
  const serialized = JSON.stringify(built);
  assert.equal(serialized.includes('keyPath'), false);
  assert.equal(serialized.includes('id_ed25519'), false);
  assert.equal(serialized.includes('sshPath'), false);
  assert.equal(serialized.includes('undefined'), false);
  assert.deepEqual(JSON.parse(serialized), built);
});

check('buildEmulatorInventory accepts string/number updatedAt and falls back for garbage', () => {
  assert.equal(
    buildEmulatorInventory({ updatedAt: '2026-01-02T03:04:05.000Z' }).updatedAt,
    '2026-01-02T03:04:05.000Z',
  );
  const numeric = buildEmulatorInventory({ updatedAt: 1767323045000 });
  assert.equal(numeric.updatedAt, new Date(1767323045000).toISOString());
  const fallback = buildEmulatorInventory({ updatedAt: 'not-a-date' });
  assert.ok(Number.isFinite(Date.parse(fallback.updatedAt)));
});

check('buildEmulatorInventory tolerates garbage local/remote input', () => {
  const built = buildEmulatorInventory({
    local: { avds: [null, { name: '' }, { nope: 1 }], devices: 'nope', runningInstances: 'nope' },
    remotes: [null, 42],
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.local.avds, []);
  assert.deepEqual(built.local.devices, []);
  assert.deepEqual(built.local.runningInstances, []);
  assert.deepEqual(built.remotes, []);
  assert.doesNotThrow(() => JSON.stringify(built));
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  let passed = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
    } catch (error) {
      console.error(`FAIL ${name}`);
      throw error;
    }
    passed += 1;
    console.log(`  ok ${passed} - ${name}`);
  }
  if (passed !== checks.length) throw new Error(`expected ${checks.length} checks, ran ${passed}`);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort temp cleanup */
  }
  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
