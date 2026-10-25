/**
 * spike/setup-smoke.mjs — HERMETIC verification for lib/setup.js.
 *
 * This suite never inspects the host Android SDK and never launches an
 * emulator/Java tool: it uses temporary fake SDK / AVD directories plus an
 * injected `exec` runner that impersonates `emulator-check accel`,
 * `emulator -version`, `sysctl`, `sc query`, `avdmanager` and `sdkmanager`.
 * It therefore passes on a bare Linux CI runner with no Android SDK at all.
 *
 * Covers: export contract, SDK/tool path discovery (explicit + env order),
 * missing-SDK reporting, system image/AVD presence, AEHD/KVM/no-accel parsing,
 * macOS HVF and Windows AEHD fallbacks, probe timeout propagation, absence of
 * install side effects in detect, createAvd argv/validation/error/timeout/
 * bounded output/JAVA_HOME injection, installSystemImage argv/license stdin/
 * JAVA_HOME injection/error, setupReport keys for ready and not-ready
 * environments, and programmer-error TypeErrors.
 *
 *   cd apk-vm-preview
 *   node spike/setup-smoke.mjs
 *
 * Exit code 0 = every check passed.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_AVD_NAME,
  DEFAULT_SYSTEM_IMAGE,
  createAvd,
  detectEnvironment,
  installSystemImage,
  bootstrapSdk,
  setupReport,
} from '../lib/setup.js';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
const TOOL_EXT = IS_WIN ? '.bat' : '';

const CONTRACT_KEYS = [
  'ok',
  'platform',
  'sdkRoot',
  'adbPath',
  'emulatorPath',
  'avdmanagerPath',
  'sdkmanagerPath',
  'emulatorVersion',
  'systemImage',
  'systemImagePresent',
  'avdName',
  'avdPresent',
  'avdPath',
  'accel',
  'hypervisorNotes',
  'missing',
  'actions',
];

// ---------------------------------------------------------------------------
// Fixture helpers (temp dirs only; nothing here touches a real SDK)
// ---------------------------------------------------------------------------

const tempRoots = [];

function tempRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-setup-smoke-'));
  tempRoots.push(root);
  return root;
}

function writeFake(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '');
  return file;
}

/** Build a fake SDK tree; returns the SDK root path. */
function makeSdk(root, options = {}) {
  const {
    adb = true,
    emulator = true,
    emulatorCheck = true,
    avdmanager = true,
    sdkmanager = true,
    systemImage = true,
  } = options;
  const sdk = path.join(root, 'sdk');
  if (adb) writeFake(path.join(sdk, 'platform-tools', `adb${EXE}`));
  if (emulator) writeFake(path.join(sdk, 'emulator', `emulator${EXE}`));
  if (emulatorCheck) writeFake(path.join(sdk, 'emulator', `emulator-check${EXE}`));
  if (avdmanager) {
    writeFake(path.join(sdk, 'cmdline-tools', 'latest', 'bin', `avdmanager${TOOL_EXT}`));
  }
  if (sdkmanager) {
    writeFake(path.join(sdk, 'cmdline-tools', 'latest', 'bin', `sdkmanager${TOOL_EXT}`));
  }
  if (systemImage) {
    mkdirSync(path.join(sdk, 'system-images', 'android-34', 'default', 'x86_64'), {
      recursive: true,
    });
  }
  return sdk;
}

/** Build a fake AVD home; returns the avd home path. */
function makeAvdHome(root, options = {}) {
  const { present = true, name = DEFAULT_AVD_NAME } = options;
  const avdHome = path.join(root, 'avd');
  mkdirSync(avdHome, { recursive: true });
  if (present) {
    mkdirSync(path.join(avdHome, `${name}.avd`), { recursive: true });
    writeFileSync(path.join(avdHome, `${name}.ini`), `path=${path.join(avdHome, `${name}.avd`)}\n`);
  }
  return avdHome;
}

/** Fake JDK with an existing `bin/java`, used to check JAVA_HOME injection. */
function makeFakeJdk(root, version = '17.0.2') {
  const javaHome = path.join(root, `jdk-${version}`);
  writeFake(path.join(javaHome, 'bin', `java${EXE}`));
  return javaHome;
}

/**
 * Isolated discovery environment: no PATH, no host SDK env vars. When `env` is
 * supplied to lib/setup.js, discovery only uses these values + explicit
 * options, which keeps every check hermetic across Windows/macOS/Linux.
 */
function isolatedEnv(root, avdHome) {
  const home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  const env = { PATH: '', HOME: home, USERPROFILE: home };
  if (avdHome) env.ANDROID_AVD_HOME = avdHome;
  return env;
}

/** Fully-provisioned fake host (SDK image+AVD present). */
function provisioned(options = {}) {
  const root = tempRoot();
  const sdk = makeSdk(root, options.sdkOptions);
  const avdHome = makeAvdHome(root, { present: options.avdPresent !== false });
  return { root, sdk, avdHome, env: isolatedEnv(root, avdHome) };
}

const ACCEL_OUTPUTS = {
  aehd: {
    code: 0,
    stdout: 'accel:\n0\nAEHD (version 2.1) is installed and usable.\naccel\n',
    stderr: '',
  },
  kvm: {
    code: 0,
    stdout: 'accel:\n0\nKVM (version 6.8) is installed and usable.\naccel\n',
    stderr: '',
  },
  none: {
    code: 1,
    stdout: 'accel:\n1\nWHPX is not installed and no hypervisor is available.\naccel\n',
    stderr: '',
  },
};

const VERSION_OUTPUT = {
  code: 0,
  stdout:
    'Android emulator version 99.1.2.0 (build_id 123456) (CL:N/A)\n' +
    'Copyright (C) 2006-2024 The Android Open Source Project and many others.\n',
  stderr: '',
};

/**
 * Fake exec runner. Routes by executable basename and records every call so
 * checks can assert the exact argv a real host would have received.
 */
function makeExec(overrides = {}) {
  const routes = {
    accel: ACCEL_OUTPUTS.aehd,
    version: VERSION_OUTPUT,
    avdmanager: { code: 0, stdout: 'Created AVD successfully.\n', stderr: '' },
    sdkmanager: { code: 0, stdout: 'done\n', stderr: '' },
    sysctl: { code: 0, stdout: '1\n', stderr: '' },
    sc: { code: 1, stdout: 'STATE : 4 STOPPED\n', stderr: '' },
    ...overrides,
  };
  const calls = [];
  const exec = async (file, args = [], opts = {}) => {
    const base = path.basename(String(file)).toLowerCase();
    const record = { file: String(file), args: [...args], opts, base };
    calls.push(record);
    const resolve = (route) => (typeof route === 'function' ? route(record) : route);
    if (base.startsWith('emulator-check')) return resolve(routes.accel);
    if ((base === 'emulator' || base === 'emulator.exe') && args[0] === '-version') {
      return resolve(routes.version);
    }
    if (base === 'sysctl') return resolve(routes.sysctl);
    if (base === 'sc' || base === 'sc.exe') return resolve(routes.sc);
    if (base.startsWith('avdmanager')) return resolve(routes.avdmanager);
    if (base.startsWith('sdkmanager')) return resolve(routes.sdkmanager);
    return { code: 1, stdout: '', stderr: `unexpected command: ${base} ${args.join(' ')}` };
  };
  exec.calls = calls;
  return exec;
}

// ---------------------------------------------------------------------------
// Check harness
// ---------------------------------------------------------------------------

const checks = [];

async function check(name, fn) {
  const startedAt = performance.now();
  try {
    await fn();
    checks.push({ name, ok: true });
    console.log(`PASS ${name} (${(performance.now() - startedAt).toFixed(1)} ms)`);
  } catch (error) {
    checks.push({ name, ok: false, error });
    console.log(
      `FAIL ${name}\n     ${
        error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n     ') : error
      }`,
    );
  }
}

async function main() {
  // --- export contract ------------------------------------------------------
  await check('exports the stable setup API and documented defaults', async () => {
    assert.equal(DEFAULT_SYSTEM_IMAGE, 'system-images;android-34;default;x86_64');
    assert.equal(DEFAULT_AVD_NAME, 'dsh_apk');
    assert.equal(typeof detectEnvironment, 'function');
    assert.equal(typeof createAvd, 'function');
    assert.equal(typeof installSystemImage, 'function');
    assert.equal(typeof setupReport, 'function');
    assert.ok(CONTRACT_KEYS.length >= 17);
  });

  // --- fully provisioned environment ---------------------------------------
  const ready = provisioned();
  const readyExec = makeExec();
  const readyReport = await detectEnvironment({
    sdkRoot: ready.sdk,
    env: ready.env,
    exec: readyExec,
  });

  await check('detectEnvironment reports the full contract shape on a ready host', async () => {
    assert.equal(typeof readyReport, 'object');
    for (const key of CONTRACT_KEYS) {
      assert.ok(key in readyReport, `report has key ${key}`);
    }
    assert.equal(readyReport.ok, true);
    assert.equal(readyReport.platform, process.platform);
    assert.equal(readyReport.systemImage, DEFAULT_SYSTEM_IMAGE);
    assert.equal(readyReport.avdName, DEFAULT_AVD_NAME);
    assert.equal(readyReport.systemImagePresent, true);
    assert.equal(readyReport.avdPresent, true);
    assert.equal(readyReport.emulatorVersion, '99.1.2.0');
    assert.equal(readyReport.missing.length, 0, `expected no missing items: ${readyReport.missing}`);
    assert.ok(Array.isArray(readyReport.hypervisorNotes) && readyReport.hypervisorNotes.length > 0);
    assert.equal(typeof readyReport.avdPath, 'string');
    assert.equal(typeof readyReport.accel, 'object');
    assert.equal(typeof readyReport.accel.available, 'boolean');
    assert.equal(typeof readyReport.accel.detail, 'string');
  });

  await check('detectEnvironment discovers adb/emulator/cmdline-tools paths on disk', async () => {
    const expectedAdb = path.join(ready.sdk, 'platform-tools', `adb${EXE}`);
    const expectedEmulator = path.join(ready.sdk, 'emulator', `emulator${EXE}`);
    const expectedAvdmanager = path.join(
      ready.sdk,
      'cmdline-tools',
      'latest',
      'bin',
      `avdmanager${TOOL_EXT}`,
    );
    const expectedSdkmanager = path.join(
      ready.sdk,
      'cmdline-tools',
      'latest',
      'bin',
      `sdkmanager${TOOL_EXT}`,
    );
    assert.equal(readyReport.sdkRoot, ready.sdk);
    assert.equal(readyReport.adbPath, expectedAdb);
    assert.equal(readyReport.emulatorPath, expectedEmulator);
    assert.equal(readyReport.avdmanagerPath, expectedAvdmanager);
    assert.equal(readyReport.sdkmanagerPath, expectedSdkmanager);
    for (const file of [
      readyReport.adbPath,
      readyReport.emulatorPath,
      readyReport.avdmanagerPath,
      readyReport.sdkmanagerPath,
    ]) {
      assert.ok(existsSync(file), `discovered path exists: ${file}`);
    }
    assert.equal(readyReport.avdPath, path.join(ready.avdHome, `${DEFAULT_AVD_NAME}.avd`));
    assert.ok(existsSync(readyReport.avdPath));
  });

  await check('detectEnvironment parses emulator-check AEHD acceleration', async () => {
    assert.equal(readyReport.accel.available, true);
    assert.equal(readyReport.accel.backend, 'AEHD');
    assert.match(readyReport.accel.detail, /usable/i);
    assert.ok(
      readyReport.hypervisorNotes.some((note) => /AEHD/.test(note)),
      `hypervisorNotes mentions AEHD: ${JSON.stringify(readyReport.hypervisorNotes)}`,
    );
    assert.equal(readyExec.calls.filter((call) => call.base.startsWith('emulator-check')).length, 1);
    assert.equal(readyExec.calls.filter((call) => call.args[0] === '-version').length, 1);
  });

  await check('ready host exposes no repair actions and all reasons are populated', async () => {
    assert.ok(Array.isArray(readyReport.actions));
    assert.deepEqual(
      readyReport.actions.map((action) => action.id),
      ['create-avd', 'install-image', 'install-tools', 'bootstrap-sdk', 'repair-accel'],
    );
    assert.deepEqual(
      readyReport.actions.map((action) => action.available),
      [false, false, false, false, false],
    );
    for (const action of readyReport.actions) {
      assert.equal(typeof action.label, 'string');
      assert.equal(typeof action.reason, 'string');
      assert.ok(action.reason.length > 0);
    }
  });

  // --- discovery order ------------------------------------------------------
  await check('explicit sdkRoot wins over ANDROID_SDK_ROOT from the environment', async () => {
    const root = tempRoot();
    const sdkA = makeSdk(path.join(root, 'a'));
    const sdkB = makeSdk(path.join(root, 'b'));
    const avdHome = makeAvdHome(root);
    const env = isolatedEnv(root, avdHome);
    env.ANDROID_SDK_ROOT = sdkB;
    const exec = makeExec();
    const report = await detectEnvironment({ sdkRoot: sdkA, env, exec });
    assert.equal(report.sdkRoot, sdkA);
    assert.equal(report.adbPath, path.join(sdkA, 'platform-tools', `adb${EXE}`));
    assert.equal(report.ok, true);
  });

  await check('ANDROID_SDK_ROOT / ANDROID_HOME are used when no sdkRoot is given', async () => {
    for (const key of ['ANDROID_SDK_ROOT', 'ANDROID_HOME']) {
      const root = tempRoot();
      const sdk = makeSdk(root);
      const avdHome = makeAvdHome(root);
      const env = isolatedEnv(root, avdHome);
      env[key] = sdk;
      const report = await detectEnvironment({ env, exec: makeExec() });
      assert.equal(report.sdkRoot, sdk, `${key} discovered the SDK root`);
      assert.equal(report.ok, true);
    }
  });

  // --- missing SDK ----------------------------------------------------------
  await check('missing SDK is reported without throwing', async () => {
    const root = tempRoot();
    const env = isolatedEnv(root);
    const exec = makeExec();
    const report = await detectEnvironment({
      sdkRoot: path.join(root, 'does-not-exist'),
      env,
      exec,
    });
    assert.equal(report.ok, false);
    assert.equal(report.sdkRoot, null);
    assert.equal(report.adbPath, null);
    assert.equal(report.emulatorPath, null);
    assert.equal(report.avdmanagerPath, null);
    assert.equal(report.sdkmanagerPath, null);
    assert.equal(report.emulatorVersion, null);
    assert.equal(report.systemImagePresent, false);
    assert.equal(report.avdPresent, false);
    assert.equal(typeof report.accel.available, 'boolean');
    assert.ok(report.missing.some((item) => /Android SDK not found/.test(item)));
    assert.ok(report.missing.some((item) => /^adb not found/.test(item)));
    assert.ok(report.missing.some((item) => /emulator not found/.test(item)));
  });

  // --- system image / AVD actions ------------------------------------------
  await check('missing system image offers install-image and blocks create-avd', async () => {
    const root = tempRoot();
    const sdk = makeSdk(root, { systemImage: false });
    const avdHome = makeAvdHome(root, { present: false });
    const env = isolatedEnv(root, avdHome);
    const report = await detectEnvironment({ sdkRoot: sdk, env, exec: makeExec() });
    assert.equal(report.systemImagePresent, false);
    assert.equal(report.avdPresent, false);
    assert.equal(report.actions.find((action) => action.id === 'install-image').available, true);
    assert.equal(report.actions.find((action) => action.id === 'create-avd').available, false);
    assert.match(
      report.actions.find((action) => action.id === 'create-avd').reason,
      /system image .* is not installed/,
    );
    assert.ok(report.missing.some((item) => /System image not installed/.test(item)));
    assert.ok(report.missing.some((item) => item.includes('not created')));
    assert.ok(report.avdPath.endsWith(`${DEFAULT_AVD_NAME}.avd`));
  });

  await check('missing AVD with installed image offers create-avd', async () => {
    const root = tempRoot();
    const sdk = makeSdk(root);
    const avdHome = makeAvdHome(root, { present: false });
    const env = isolatedEnv(root, avdHome);
    const report = await detectEnvironment({ sdkRoot: sdk, env, exec: makeExec() });
    assert.equal(report.ok, false);
    assert.equal(report.avdPresent, false);
    assert.equal(report.systemImagePresent, true);
    assert.equal(report.actions.find((action) => action.id === 'create-avd').available, true);
    assert.match(
      report.actions.find((action) => action.id === 'create-avd').reason,
      /avdmanager create avd -n dsh_apk/,
    );
    assert.equal(report.actions.find((action) => action.id === 'install-image').available, false);
    assert.ok(report.missing.some((item) => item.includes('not created')));
  });

  // --- acceleration parsing -------------------------------------------------
  await check('KVM accel output is parsed as usable acceleration', async () => {
    const root = tempRoot();
    const sdk = makeSdk(root);
    const avdHome = makeAvdHome(root);
    const env = isolatedEnv(root, avdHome);
    const report = await detectEnvironment({
      sdkRoot: sdk,
      env,
      exec: makeExec({ accel: ACCEL_OUTPUTS.kvm }),
    });
    assert.equal(report.accel.available, true);
    assert.equal(report.accel.backend, 'KVM');
    assert.match(report.accel.detail, /KVM/);
    assert.equal(report.ok, true);
  });

  await check('no-accel output disables ok and offers repair-accel', async () => {
    const root = tempRoot();
    const sdk = makeSdk(root);
    const avdHome = makeAvdHome(root);
    const env = isolatedEnv(root, avdHome);
    const report = await detectEnvironment({
      sdkRoot: sdk,
      env,
      exec: makeExec({ accel: ACCEL_OUTPUTS.none }),
    });
    assert.equal(report.accel.available, false);
    assert.equal(report.accel.backend, 'none');
    assert.match(report.accel.detail, /not installed/i);
    assert.equal(report.ok, false);
    assert.equal(report.actions.find((action) => action.id === 'repair-accel').available, true);
    assert.ok(report.missing.some((item) => /No usable CPU acceleration/.test(item)));
    assert.ok(report.hypervisorNotes.length > 0);
  });

  await check('macOS HVF fallback probes sysctl when emulator-check is absent', async () => {
    const root = tempRoot();
    const avdHome = makeAvdHome(root);
    const emulatorPath = writeFake(path.join(root, 'emulator', 'emulator'));
    const exec = makeExec({ sysctl: { code: 0, stdout: '1\n', stderr: '' } });
    const report = await detectEnvironment({
      emulatorPath,
      env: isolatedEnv(root, avdHome),
      exec,
      platform: 'darwin',
    });
    assert.equal(report.platform, 'darwin');
    assert.equal(report.accel.available, true);
    assert.equal(report.accel.backend, 'HVF');
    assert.match(report.accel.detail, /hv_support/);
    assert.ok(exec.calls.some((call) => call.base === 'sysctl'));
    assert.ok(report.hypervisorNotes.some((note) => /Hypervisor\.Framework/.test(note)));
  });

  await check('Windows AEHD fallback probes sc query when emulator-check is absent', async () => {
    const root = tempRoot();
    const avdHome = makeAvdHome(root);
    const emulatorPath = writeFake(path.join(root, 'emulator', 'emulator.exe'));
    const exec = makeExec({
      sc: (call) =>
        call.args[0] === 'query' && call.args[1] === 'aehd'
          ? {
              code: 0,
              stdout:
                'SERVICE_NAME: aehd\n        TYPE               : 1  KERNEL_DRIVER\n' +
                '        STATE              : 4  RUNNING\n',
              stderr: '',
            }
          : {
              code: 1,
              stdout: 'The specified service does not exist as an installed service.\n',
              stderr: '',
            },
    });
    const report = await detectEnvironment({
      emulatorPath,
      env: isolatedEnv(root, avdHome),
      exec,
      platform: 'win32',
    });
    assert.equal(report.accel.available, true);
    assert.equal(report.accel.backend, 'AEHD');
    assert.match(report.accel.detail, /aehd/i);
    assert.ok(exec.calls.some((call) => /^sc(\.exe)?$/.test(call.base)));
  });

  await check('custom timeoutMs is propagated to every probe', async () => {
    const root = tempRoot();
    const sdk = makeSdk(root);
    const avdHome = makeAvdHome(root);
    const env = isolatedEnv(root, avdHome);
    const exec = makeExec();
    await detectEnvironment({ sdkRoot: sdk, env, exec, timeoutMs: 1234 });
    assert.ok(exec.calls.length >= 2, 'emulator-check and emulator -version probes ran');
    for (const call of exec.calls) {
      assert.equal(call.opts.timeoutMs, 1234, `timeout propagated to ${call.base}`);
    }
  });

  await check('detectEnvironment never installs images or creates AVDs', async () => {
    const root = tempRoot();
    const sdk = makeSdk(root, { systemImage: false });
    const avdHome = makeAvdHome(root, { present: false });
    const env = isolatedEnv(root, avdHome);
    const exec = makeExec({ accel: ACCEL_OUTPUTS.none });
    await detectEnvironment({ sdkRoot: sdk, env, exec });
    assert.equal(
      exec.calls.filter(
        (call) => call.base.startsWith('sdkmanager') || call.base.startsWith('avdmanager'),
      ).length,
      0,
    );
    assert.equal(exec.calls.some((call) => call.args.includes('--install')), false);
    assert.equal(exec.calls.some((call) => call.args.includes('create')), false);
  });

  // --- createAvd ------------------------------------------------------------
  await check('createAvd runs the exact avdmanager argv and reports command/output', async () => {
    const { sdk, env } = provisioned({ avdPresent: false });
    const exec = makeExec({ avdmanager: { code: 0, stdout: 'Created AVD "dsh_apk".\n', stderr: '' } });
    const result = await createAvd({ sdkRoot: sdk, env, exec });
    assert.equal(result.ok, true);
    assert.equal(result.avdName, DEFAULT_AVD_NAME);
    assert.match(result.command, /create avd/);
    assert.match(result.command, /-d pixel_5/);
    assert.match(result.command, /--force/);
    assert.ok(result.command.includes(DEFAULT_SYSTEM_IMAGE), 'command mentions the system image');
    assert.match(result.output, /Created AVD/);
    assert.equal(result.error, undefined);
    assert.equal(exec.calls.length, 1);
    const call = exec.calls[0];
    assert.equal(
      call.file,
      path.join(sdk, 'cmdline-tools', 'latest', 'bin', `avdmanager${TOOL_EXT}`),
    );
    assert.deepEqual(call.args, [
      'create',
      'avd',
      '-n',
      DEFAULT_AVD_NAME,
      '-k',
      DEFAULT_SYSTEM_IMAGE,
      '-d',
      'pixel_5',
      '--force',
    ]);
    assert.equal(call.opts.stdin, 'no\n');
    assert.equal(call.opts.timeoutMs, 120000);
    assert.equal(call.opts.env && call.opts.env.JAVA_HOME, undefined, 'no JDK was found in this fixture');
  });

  await check('createAvd refuses when the system image is not installed', async () => {
    const root = tempRoot();
    const sdk = makeSdk(root, { systemImage: false });
    const env = isolatedEnv(root, makeAvdHome(root, { present: false }));
    const exec = makeExec();
    const result = await createAvd({ sdkRoot: sdk, env, exec });
    assert.equal(result.ok, false);
    assert.match(result.error, /system image .* is not installed/);
    assert.match(result.error, /installSystemImage/);
    assert.equal(result.avdName, DEFAULT_AVD_NAME);
    assert.equal(result.output, '');
    assert.match(result.command, /create avd/);
    assert.equal(exec.calls.length, 0);
  });

  await check('createAvd refuses when avdmanager is not installed', async () => {
    const root = tempRoot();
    const sdk = makeSdk(root, { avdmanager: false });
    const env = isolatedEnv(root, makeAvdHome(root, { present: false }));
    const exec = makeExec();
    const result = await createAvd({ sdkRoot: sdk, env, exec });
    assert.equal(result.ok, false);
    assert.match(result.error, /avdmanager not found/);
    assert.equal(exec.calls.length, 0);
  });

  await check('createAvd returns ok:false (no throw) when avdmanager exits non-zero', async () => {
    const { sdk, env } = provisioned();
    const exec = makeExec({
      avdmanager: { code: 1, stdout: '', stderr: 'Error: Package path is not valid.\n' },
    });
    const result = await createAvd({ sdkRoot: sdk, env, exec });
    assert.equal(result.ok, false);
    assert.match(result.error, /avdmanager create avd failed \(exit 1\)/);
    assert.match(result.error, /Package path is not valid/);
    assert.match(result.output, /Package path is not valid/);
  });

  await check('createAvd reports a bounded timeout error', async () => {
    const { sdk, env } = provisioned();
    const exec = makeExec({ avdmanager: { code: null, timedOut: true, stdout: '', stderr: '' } });
    const result = await createAvd({ sdkRoot: sdk, env, exec, timeoutMs: 4321 });
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out after 4321 ms/);
  });

  await check('createAvd output is byte-bounded', async () => {
    const { sdk, env } = provisioned();
    const exec = makeExec({ avdmanager: { code: 0, stdout: 'x'.repeat(300000), stderr: '' } });
    const result = await createAvd({ sdkRoot: sdk, env, exec });
    assert.equal(result.ok, true);
    assert.ok(result.output.length <= 4000, `output bounded (${result.output.length} chars)`);
  });

  await check('programmer errors throw TypeError instead of ok:false', async () => {
    const { sdk, env } = provisioned();
    await assert.rejects(
      detectEnvironment('not-an-object'),
      (error) => error instanceof TypeError && /options must be a plain object/.test(error.message),
    );
    await assert.rejects(
      detectEnvironment({ timeoutMs: -5 }),
      (error) => error instanceof TypeError && /timeoutMs/.test(error.message),
    );
    await assert.rejects(
      detectEnvironment({ systemImage: 'not-a-system-image' }),
      (error) => error instanceof TypeError && /systemImage/.test(error.message),
    );
    await assert.rejects(
      createAvd({ sdkRoot: sdk, env, avdName: 'bad/name' }),
      (error) => error instanceof TypeError && /avdName/.test(error.message),
    );
  });

  // --- installSystemImage ---------------------------------------------------
  await check('installSystemImage refuses when sdkmanager is missing', async () => {
    const root = tempRoot();
    const sdk = makeSdk(root, { sdkmanager: false });
    const env = isolatedEnv(root, makeAvdHome(root, { present: false }));
    const exec = makeExec();
    const result = await installSystemImage({ sdkRoot: sdk, env, exec });
    assert.equal(result.ok, false);
    assert.match(result.error, /sdkmanager not found/);
    assert.equal(result.image, DEFAULT_SYSTEM_IMAGE);
    assert.match(result.command, /--install/);
    assert.equal(exec.calls.length, 0);
  });

  await check('installSystemImage runs the exact sdkmanager argv', async () => {
    const root = tempRoot();
    const sdk = makeSdk(root, { systemImage: false });
    const env = isolatedEnv(root, makeAvdHome(root, { present: false }));
    const exec = makeExec({ sdkmanager: { code: 0, stdout: 'done\n', stderr: '' } });
    const result = await installSystemImage({ sdkRoot: sdk, env, exec });
    assert.equal(result.ok, true);
    assert.equal(result.image, DEFAULT_SYSTEM_IMAGE);
    assert.ok(result.command.includes(`--install ${DEFAULT_SYSTEM_IMAGE}`));
    assert.equal(result.output, 'done');
    assert.equal(exec.calls.length, 1);
    const call = exec.calls[0];
    assert.equal(
      call.file,
      path.join(sdk, 'cmdline-tools', 'latest', 'bin', `sdkmanager${TOOL_EXT}`),
    );
    assert.deepEqual(call.args, ['--install', DEFAULT_SYSTEM_IMAGE]);
    assert.equal(call.opts.stdin, undefined);
    assert.equal(call.opts.timeoutMs, 20 * 60 * 1000);
  });

  await check('installSystemImage acceptLicenses pipes license answers on stdin', async () => {
    const root = tempRoot();
    const sdk = makeSdk(root, { systemImage: false });
    const env = isolatedEnv(root, makeAvdHome(root, { present: false }));
    const exec = makeExec({ sdkmanager: { code: 0, stdout: 'done\n', stderr: '' } });
    const result = await installSystemImage({ sdkRoot: sdk, env, exec, acceptLicenses: true });
    assert.equal(result.ok, true);
    const call = exec.calls[0];
    assert.equal(call.opts.stdin, 'y\n'.repeat(20));
  });

  await check('installSystemImage returns ok:false (no throw) on sdkmanager failure', async () => {
    const root = tempRoot();
    const sdk = makeSdk(root, { systemImage: false });
    const env = isolatedEnv(root, makeAvdHome(root, { present: false }));
    const exec = makeExec({
      sdkmanager: {
        code: 1,
        stdout: '',
        stderr: 'Warning: Failed to read license agreement\n',
      },
    });
    const result = await installSystemImage({ sdkRoot: sdk, env, exec });
    assert.equal(result.ok, false);
    assert.match(result.error, /sdkmanager --install failed \(exit 1\)/);
    assert.match(result.error, /Failed to read license/);
  });

  await check('bootstrapSdk downloads/extracts command-line tools and installs packages', async () => {
    const root = tempRoot();
    const sdk = path.join(root, 'fresh-sdk');
    mkdirSync(sdk, { recursive: true });
    const javaHome = path.join(root, 'jdk');
    mkdirSync(path.join(javaHome, 'bin'), { recursive: true });
    writeFileSync(path.join(javaHome, 'bin', IS_WIN ? 'java.exe' : 'java'), '');
    const env = { ...isolatedEnv(root, makeAvdHome(root, { present: false })), JAVA_HOME: javaHome };
    const calls = [];
    const exec = async (file, args) => {
      calls.push({ file, args });
      return { code: 0, stdout: 'ok', stderr: '' };
    };
    const download = async (url, destination) => {
      writeFileSync(destination, 'zip');
    };
    const extract = async (archive, destination) => {
      const bin = path.join(destination, 'cmdline-tools', 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(path.join(bin, IS_WIN ? 'sdkmanager.bat' : 'sdkmanager'), '');
    };
    const result = await bootstrapSdk({
      sdkRoot: sdk,
      env,
      exec,
      download,
      extract,
      packages: ['platform-tools'],
    });
    assert.equal(result.ok, true, result.error || '');
    assert.equal(result.extracted, true);
    assert.equal(result.licenses, true);
    assert.equal(result.installed, true);
    assert.ok(existsSync(path.join(sdk, 'cmdline-tools', 'latest', 'bin', IS_WIN ? 'sdkmanager.bat' : 'sdkmanager')));
    const licenseCall = calls.find((entry) => entry.args.includes('--licenses'));
    assert.ok(licenseCall, 'ran sdkmanager --licenses');
    const installCall = calls.find((entry) => entry.args.includes('--install'));
    assert.ok(installCall, 'ran sdkmanager --install');
    assert.deepEqual(installCall.args.slice(installCall.args.indexOf('--install') + 1), ['platform-tools']);
  });

  await check('bootstrapSdk rejects invalid package names', async () => {
    const root = tempRoot();
    const result = await bootstrapSdk({ sdkRoot: path.join(root, 'sdk'), packages: ['bad package'] });
    assert.equal(result.ok, false);
    assert.match(result.error, /invalid SDK package name/);
  });

  await check('createAvd/installSystemImage inject a discovered JDK as JAVA_HOME', async () => {
    const root = tempRoot();
    const sdk = makeSdk(root);
    const javaHome = makeFakeJdk(root);
    const env = isolatedEnv(root, makeAvdHome(root, { present: false }));

    const createExec = makeExec();
    const created = await createAvd({ sdkRoot: sdk, env, exec: createExec });
    assert.equal(created.ok, true);
    const createCall = createExec.calls[0];
    assert.ok(createCall.opts.env, 'createAvd hands an isolated child environment to the tool');
    assert.equal(createCall.opts.env.JAVA_HOME, javaHome);
    assert.equal(createCall.opts.env.ANDROID_AVD_HOME, env.ANDROID_AVD_HOME);

    const installExec = makeExec();
    const installed = await installSystemImage({ sdkRoot: sdk, env, exec: installExec });
    assert.equal(installed.ok, true);
    const installCall = installExec.calls[0];
    assert.ok(installCall.opts.env, 'installSystemImage hands an isolated child environment to the tool');
    assert.equal(installCall.opts.env.JAVA_HOME, javaHome);
  });

  // --- setupReport ----------------------------------------------------------
  await check('setupReport includes every diagnostic key for a ready host', async () => {
    const root = tempRoot();
    const sdk = makeSdk(root);
    const avdHome = makeAvdHome(root);
    const env = isolatedEnv(root, avdHome);
    const text = await setupReport({ sdkRoot: sdk, env, exec: makeExec() });
    assert.equal(typeof text, 'string');
    for (const label of [
      'DSH APK VM environment report',
      'Platform:',
      'SDK root:',
      'adb:',
      'emulator:',
      'avdmanager:',
      'sdkmanager:',
      'system image:',
      'AVD:',
      'Acceleration:',
      'Actions:',
      'Missing: none',
      'Overall: READY',
    ]) {
      assert.ok(text.includes(label), `report contains "${label}"`);
    }
    assert.ok(text.includes(DEFAULT_SYSTEM_IMAGE));
    assert.ok(text.includes(DEFAULT_AVD_NAME));
    assert.ok(text.includes('99.1.2.0'));
    assert.ok(text.length <= 12 * 1024);
  });

  await check('setupReport explains a NOT READY host', async () => {
    const root = tempRoot();
    const env = isolatedEnv(root);
    const text = await setupReport({
      sdkRoot: path.join(root, 'missing-sdk'),
      env,
      exec: makeExec(),
    });
    assert.ok(text.includes('Overall: NOT READY'));
    assert.ok(text.includes('Missing:'));
    assert.ok(text.includes('Android SDK not found'));
    assert.ok(text.includes('adb not found'));
  });

  // --- summary --------------------------------------------------------------
  const failed = checks.filter((entry) => entry.ok === false);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed` +
      (failed.length > 0 ? ` — FAILED: ${failed.map((entry) => entry.name).join('; ')}` : ''),
  );
  if (failed.length > 0) process.exitCode = 1;
}

try {
  await main();
} finally {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
