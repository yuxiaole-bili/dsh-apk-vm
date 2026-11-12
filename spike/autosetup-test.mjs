/**
 * spike/autosetup-test.mjs — HERMETIC verification for lib/autosetup.js.
 *
 * The orchestrator injects all six environment operations, so this suite never
 * touches a real JDK/SDK, never downloads anything and never spawns a child
 * process: it drives the chain with closure mocks over a mutable "host flags"
 * fixture and records the dependency call order.
 *
 * Covers: full-chain order/step accounting, already-ready short-circuit,
 * JDK-present skipping, failure + retry with timestamps, cancellation inside a
 * step, single-flight concurrency, disabled mode, accel-only warning, detection
 * throwing (no unhandled rejection), JSON-safe immutable status snapshots and
 * jdkMirror passthrough/normalization.
 *
 *   cd apk-vm-preview
 *   node spike/autosetup-test.mjs
 *
 * Exit code 0 = every check passed.
 */

import assert from 'node:assert/strict';

import { createAutoSetup } from '../lib/autosetup.js';

const DEFAULT_IMAGE = 'system-images;android-34;default;x86_64';

/** Unhandled rejections would crash a real plugin host; fail the suite instead. */
const unhandled = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(reason);
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Host-environment fixture (pure in-memory flags + mock dependencies)
// ---------------------------------------------------------------------------

const DEFAULT_FLAGS = Object.freeze({
  java: true,
  sdk: true,
  adb: true,
  emulator: true,
  image: true,
  avd: true,
  accel: true,
});

/**
 * Build an environment report that mirrors lib/setup.js's contract (including
 * the `javaPresent` field added by lib/jdk.js).
 */
function makeReport(flags) {
  const report = {
    ok: false,
    platform: 'linux',
    sdkRoot: flags.sdk ? '/opt/android-sdk' : null,
    adbPath: flags.adb ? '/opt/android-sdk/platform-tools/adb' : null,
    emulatorPath: flags.emulator ? '/opt/android-sdk/emulator/emulator' : null,
    avdmanagerPath: flags.sdk ? '/opt/android-sdk/cmdline-tools/latest/bin/avdmanager' : null,
    sdkmanagerPath: flags.sdk ? '/opt/android-sdk/cmdline-tools/latest/bin/sdkmanager' : null,
    emulatorVersion: flags.emulator ? '35.1.2' : null,
    systemImage: DEFAULT_IMAGE,
    systemImagePresent: flags.image,
    avdName: 'dsh_apk',
    avdPresent: flags.avd,
    avdPath: flags.avd ? '/srv/dev/.android/avd/dsh_apk.avd' : null,
    accel: {
      available: flags.accel,
      backend: flags.accel ? 'kvm' : 'none',
      detail: flags.accel ? '' : 'no hypervisor',
    },
    hypervisorNotes: [],
    missing: [],
    actions: [],
    javaPresent: flags.java,
  };
  if (!flags.java) report.missing.push('JDK 17 (java) not found on the host');
  if (!flags.sdk) report.missing.push('sdkmanager not found (Android SDK command-line tools are missing)');
  if (!flags.adb) report.missing.push('adb not found (install Android SDK platform-tools or add adb to PATH)');
  if (!flags.emulator) {
    report.missing.push('Android emulator not found (install the "emulator" SDK package or add it to PATH)');
  }
  if (!flags.image) report.missing.push(`system image ${DEFAULT_IMAGE} is not installed`);
  if (!flags.avd) report.missing.push('AVD "dsh_apk" is not created yet');
  if (!flags.accel) {
    report.missing.push(
      'No usable CPU acceleration (install/enable AEHD or WHPX on Windows, KVM on Linux, ' +
        'Hypervisor.Framework on macOS)',
    );
    report.hypervisorNotes.push('No hardware acceleration detected: x86_64 images need a hypervisor (KVM/WHPX).');
  }
  report.ok = Boolean(
    report.javaPresent &&
      report.sdkRoot &&
      report.adbPath &&
      report.emulatorPath &&
      report.systemImagePresent &&
      report.avdPresent &&
      report.accel.available,
  );
  return report;
}

/**
 * Mock dependency bundle. Default behaviour: succeed and satisfy the matching
 * host flag. `hooks.<name>` can override a dependency (return its result,
 * mutate flags, throw, or call back into the orchestrator).
 */
function makeFixture(initialFlags = {}, hooks = {}) {
  const flags = { ...DEFAULT_FLAGS, ...initialFlags };
  const order = [];
  const calls = { detect: 0, jdk: 0, bootstrap: 0, tools: 0, image: 0, avd: 0 };
  const seen = {};
  const detectOptions = [];

  const deps = {
    async detectEnvironment(opts) {
      calls.detect += 1;
      detectOptions.push(opts);
      if (hooks.detectEnvironment) {
        const result = await hooks.detectEnvironment({ flags, opts, call: calls.detect });
        if (result) return result;
      }
      return makeReport(flags);
    },
    async ensureJdk(opts) {
      calls.jdk += 1;
      order.push('jdk');
      seen.jdk = opts;
      if (hooks.ensureJdk) return hooks.ensureJdk({ flags, opts });
      flags.java = true;
      return { ok: true, jdkHome: '/opt/jdk-17' };
    },
    async bootstrapSdk(opts) {
      calls.bootstrap += 1;
      order.push('bootstrap');
      seen.bootstrap = opts;
      if (hooks.bootstrapSdk) return hooks.bootstrapSdk({ flags, opts });
      flags.sdk = true;
      return { ok: true };
    },
    async installSdkPackages(opts) {
      calls.tools += 1;
      order.push('tools');
      seen.tools = opts;
      if (hooks.installSdkPackages) return hooks.installSdkPackages({ flags, opts });
      flags.adb = true;
      flags.emulator = true;
      return { ok: true };
    },
    async installSystemImage(opts) {
      calls.image += 1;
      order.push('image');
      seen.image = opts;
      if (hooks.installSystemImage) return hooks.installSystemImage({ flags, opts });
      flags.image = true;
      return { ok: true };
    },
    async createAvd(opts) {
      calls.avd += 1;
      order.push('avd');
      seen.avd = opts;
      if (hooks.createAvd) return hooks.createAvd({ flags, opts });
      flags.avd = true;
      return { ok: true };
    },
  };

  return { flags, order, calls, seen, detectOptions, deps };
}

const MISSING_ALL = Object.freeze({
  java: false,
  sdk: false,
  adb: false,
  emulator: false,
  image: false,
  avd: false,
  accel: true,
});

const STATUS_KEYS = [
  'state',
  'step',
  'totalSteps',
  'stepId',
  'message',
  'detail',
  'error',
  'warnings',
  'startedAt',
  'updatedAt',
  'finishedAt',
  'reason',
].sort();

/** Assert that a status snapshot is small, JSON-safe and has the exact shape. */
function assertStatusShape(status) {
  assert.deepEqual(Object.keys(status).sort(), STATUS_KEYS);
  const roundTrip = JSON.parse(JSON.stringify(status));
  assert.deepEqual(roundTrip, status);
  assert.equal(typeof status.message, 'string');
  assert.ok(Array.isArray(status.warnings));
  for (const warning of status.warnings) assert.equal(typeof warning, 'string');
  assert.equal(typeof status.step, 'number');
  assert.equal(typeof status.totalSteps, 'number');
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('1. full chain: order, step accounting and dep options', async () => {
  const fx = makeFixture(MISSING_ALL);
  const updates = [];
  const api = createAutoSetup({
    enabled: true,
    sdkRoot: '/opt/android-sdk',
    avdName: 'dsh_apk',
    systemImage: DEFAULT_IMAGE,
    jdkRoot: '/opt/jdk-17',
    platform: 'linux',
    deps: fx.deps,
    onUpdate: (status) => updates.push(status),
  });

  const final = await api.start('first-use');

  assert.equal(final.state, 'ready');
  assert.equal(final.error, null);
  assert.equal(final.totalSteps, 5);
  assert.equal(final.step, 5);
  assert.deepEqual(fx.order, ['jdk', 'bootstrap', 'tools', 'image', 'avd']);
  assert.deepEqual(fx.calls, { detect: 6, jdk: 1, bootstrap: 1, tools: 1, image: 1, avd: 1 });
  assertStatusShape(final);

  // Step counter is 1-based and monotonic over the run.
  const runningSteps = updates.filter((entry) => entry.state === 'running' && entry.step > 0).map((entry) => entry.step);
  assert.ok(runningSteps.length >= 5);
  for (let index = 1; index < runningSteps.length; index += 1) {
    assert.ok(runningSteps[index] >= runningSteps[index - 1], 'step counter must be monotonic');
  }
  assert.equal(Math.max(...runningSteps), 5);

  // stepId follows the fixed order.
  const stepIds = [...new Set(updates.filter((entry) => fx.order.includes(entry.stepId)).map((entry) => entry.stepId))];
  assert.deepEqual(stepIds, ['jdk', 'bootstrap', 'tools', 'image', 'avd']);

  // Options passed through to the real library functions.
  assert.equal(fx.seen.jdk.jdkRoot, '/opt/jdk-17');
  assert.equal(fx.seen.jdk.platform, 'linux');
  assert.ok(!('jdkMirror' in fx.seen.jdk), 'jdkMirror must be omitted when not configured');
  assert.deepEqual(fx.seen.tools.packages, [
    'platform-tools',
    'emulator',
    'build-tools;34.0.0',
    'platforms;android-34',
  ]);
  assert.equal(fx.seen.image.systemImage, DEFAULT_IMAGE);
  assert.equal(fx.seen.avd.avdName, 'dsh_apk');
  assert.equal(fx.seen.bootstrap.acceptLicenses, true);
  assert.equal(fx.detectOptions[0].sdkRoot, '/opt/android-sdk');
  assert.equal(fx.detectOptions[0].avdName, 'dsh_apk');
  assert.equal(fx.detectOptions[0].systemImage, DEFAULT_IMAGE);
});

test('2. already provisioned: ready without extra steps', async () => {
  const fx = makeFixture();
  const api = createAutoSetup({ enabled: true, deps: fx.deps });

  const final = await api.start('first-use');

  assert.equal(final.state, 'ready');
  assert.equal(final.totalSteps, 0);
  assert.equal(final.step, 0);
  assert.equal(final.message, 'environment already provisioned');
  assert.deepEqual(fx.order, []);
  assert.deepEqual(fx.calls, { detect: 1, jdk: 0, bootstrap: 0, tools: 0, image: 0, avd: 0 });
  assertStatusShape(final);

  // A new start after ready is a no-op (no extra detection).
  const again = await api.start('again');
  assert.equal(again.state, 'ready');
  assert.equal(fx.calls.detect, 1);
});

test('3. JDK present: chain starts at bootstrap', async () => {
  const fx = makeFixture({ java: true, sdk: false, adb: false, emulator: false, image: false, avd: false });
  const api = createAutoSetup({ enabled: true, deps: fx.deps });

  const final = await api.start('first-use');

  assert.equal(final.state, 'ready');
  assert.equal(final.totalSteps, 4);
  assert.deepEqual(fx.order, ['bootstrap', 'tools', 'image', 'avd']);
  assert.equal(fx.calls.jdk, 0);
});

test('4. failure then retry: error preserved, finishedAt refreshed', async () => {
  let imageAttempts = 0;
  const fx = makeFixture(MISSING_ALL, {
    installSystemImage: ({ flags }) => {
      imageAttempts += 1;
      if (imageAttempts === 1) return { ok: false, error: 'image download failed: HTTP 503' };
      flags.image = true;
      return { ok: true };
    },
  });
  const api = createAutoSetup({ enabled: true, deps: fx.deps });

  const first = await api.start('first-use');
  assert.equal(first.state, 'failed');
  assert.match(first.error, /image download failed: HTTP 503/);
  assert.match(first.error, /hint: check network\/proxy access/i);
  assert.equal(typeof first.finishedAt, 'string');
  assertStatusShape(first);

  await delay(10);
  const detectsAfterFailure = fx.calls.detect;
  const second = await api.retry();

  assert.equal(second.state, 'ready');
  assert.equal(second.error, null);
  assert.equal(second.warnings.length, 0);
  assert.equal(second.totalSteps, 2);
  assert.deepEqual(fx.order, ['jdk', 'bootstrap', 'tools', 'image', 'image', 'avd']);
  assert.notEqual(second.finishedAt, first.finishedAt, 'finishedAt must be refreshed by the retry');
  assert.ok(second.finishedAt >= first.finishedAt);
  assert.equal(fx.calls.detect, detectsAfterFailure + 3, 'retry detect = initial + one per executed step');

  // retry() is a no-op once ready.
  const third = await api.retry();
  assert.equal(third.state, 'ready');
  assert.equal(fx.calls.detect, detectsAfterFailure + 3);
});

test('5. cancel inside a step stops the chain before the next step', async () => {
  let api;
  const fx = makeFixture({ java: false, sdk: false, adb: false, emulator: false, image: false, avd: false }, {
    ensureJdk: ({ flags }) => {
      const pending = api.cancel();
      assert.equal(pending.state, 'running', 'cancel only flags while the step is in flight');
      assert.equal(api.status().state, 'running');
      flags.java = true;
      return { ok: true };
    },
  });
  api = createAutoSetup({ enabled: true, deps: fx.deps });

  const final = await api.start('first-use');

  assert.equal(final.state, 'cancelled');
  assert.equal(typeof final.finishedAt, 'string');
  assert.deepEqual(fx.order, ['jdk'], 'bootstrap must not run after cancellation');
  assert.equal(fx.calls.bootstrap, 0);
  assert.equal(fx.calls.detect, 1, 'no re-detect after a cancelled step');
  assertStatusShape(final);

  // cancel() outside a run is a harmless no-op.
  assert.equal(api.cancel().state, 'cancelled');
});

test('6. single-flight: concurrent starts share one run', async () => {
  const slow = (mutate) => async ({ flags }) => {
    await delay(5);
    mutate(flags);
    return { ok: true };
  };
  const fx = makeFixture(MISSING_ALL, {
    ensureJdk: slow((flags) => {
      flags.java = true;
    }),
    bootstrapSdk: slow((flags) => {
      flags.sdk = true;
    }),
    installSdkPackages: slow((flags) => {
      flags.adb = true;
      flags.emulator = true;
    }),
    installSystemImage: slow((flags) => {
      flags.image = true;
    }),
    createAvd: slow((flags) => {
      flags.avd = true;
    }),
  });
  const api = createAutoSetup({ enabled: true, deps: fx.deps });

  const first = api.start('first');
  const second = api.start('second');
  assert.equal(api.status().state, 'running', 'the run starts synchronously');
  const [a, b] = await Promise.all([first, second]);

  assert.equal(a.state, 'ready');
  assert.equal(b.state, 'ready');
  assert.equal(a, b, 'both callers must resolve to the same final status');
  assert.deepEqual(fx.order, ['jdk', 'bootstrap', 'tools', 'image', 'avd']);
  assert.deepEqual(fx.calls, { detect: 6, jdk: 1, bootstrap: 1, tools: 1, image: 1, avd: 1 });
});

test('7. enabled=false: disabled and no dependencies', async () => {
  const fx = makeFixture(MISSING_ALL);
  const api = createAutoSetup({ enabled: false, deps: fx.deps });

  assert.equal(api.status().state, 'disabled');
  const started = await api.start('first-use');
  assert.equal(started.state, 'disabled');
  assert.equal(fx.calls.detect, 0);
  assert.deepEqual(fx.order, []);

  const retried = await api.retry();
  assert.equal(retried.state, 'disabled');
  assert.equal(api.cancel().state, 'disabled');
  assertStatusShape(started);
});

test('8. accel-only missing: ready with hypervisor warnings', async () => {
  const fx = makeFixture({ ...DEFAULT_FLAGS, accel: false });
  const api = createAutoSetup({ enabled: true, deps: fx.deps });

  const final = await api.start('first-use');

  assert.equal(final.state, 'ready');
  assert.equal(final.error, null);
  assert.ok(final.warnings.length >= 1, 'a missing hypervisor must produce warnings');
  assert.ok(final.warnings.some((warning) => /hypervisor|acceleration/i.test(warning)));
  assert.equal(final.detail.accel.available, false);
  assert.deepEqual(fx.order, []);
  assertStatusShape(final);
});

test('9. detection throws: failed status, no unhandled rejection', async () => {
  const fx = makeFixture(MISSING_ALL, {
    detectEnvironment: () => {
      throw new Error('detect boom');
    },
  });
  const api = createAutoSetup({ enabled: true, deps: fx.deps });

  const final = await api.start('first-use');
  assert.equal(final.state, 'failed');
  assert.match(final.error, /detect boom/);
  assert.equal(typeof final.finishedAt, 'string');
  assertStatusShape(final);

  // Fire-and-forget callers (the HTTP routes) never attach a catch; start()
  // must still never reject, so nothing can surface as an unhandled rejection.
  void api.start('fire-and-forget');
  await delay(20);
  assert.deepEqual(unhandled, []);
});

test('10. status() is a fresh, immutable JSON-safe copy', async () => {
  const fx = makeFixture(MISSING_ALL);
  const updates = [];
  const api = createAutoSetup({
    enabled: true,
    deps: fx.deps,
    onUpdate: (status) => updates.push(status),
  });

  const final = await api.start('first-use');
  assertStatusShape(final);

  // Observers received copies: mutating one must not corrupt the internal state.
  assert.ok(updates.length >= 2);
  updates[0].state = 'corrupted';
  updates[0].warnings.push('corrupted');
  assert.equal(api.status().state, 'ready');

  // status() returns a fresh copy every call.
  const one = api.status();
  one.state = 'corrupted';
  one.warnings.push('corrupted');
  one.detail.accel.available = 'corrupted';
  const two = api.status();
  assert.equal(two.state, 'ready');
  assert.deepEqual(two.warnings, []);
  assert.equal(two.detail.accel.available, true);

  // A failed snapshot is JSON-safe and small too.
  const failing = makeFixture({ ...DEFAULT_FLAGS, java: false }, {
    ensureJdk: () => ({ ok: false, error: 'JDK download failed' }),
  });
  const failedApi = createAutoSetup({ enabled: true, deps: failing.deps });
  const failed = await failedApi.start('first-use');
  assert.equal(failed.state, 'failed');
  assertStatusShape(failed);
  assert.ok(JSON.stringify(failed).length < 4096, 'status snapshot must stay small');
});

test('11. jdkMirror: string/list normalization passed to ensureJdk only', async () => {
  // A single mirror stays a plain string.
  const single = makeFixture(MISSING_ALL);
  const singleApi = createAutoSetup({
    enabled: true,
    deps: single.deps,
    jdkMirror: 'https://mirror-a.example/jdk',
  });
  const singleFinal = await singleApi.start('first-use');
  assert.equal(singleFinal.state, 'ready');
  assert.equal(single.seen.jdk.jdkMirror, 'https://mirror-a.example/jdk');
  assert.ok(!('jdkMirror' in single.seen.bootstrap), 'other steps must not receive jdkMirror');

  // A list is trimmed, empty entries are dropped and order is preserved.
  const listed = makeFixture(MISSING_ALL);
  const listedApi = createAutoSetup({
    enabled: true,
    deps: listed.deps,
    jdkMirror: [' https://mirror-a.example/jdk ', '', 'https://mirror-b.example/jdk'],
  });
  const listedFinal = await listedApi.start('first-use');
  assert.equal(listedFinal.state, 'ready');
  assert.deepEqual(listed.seen.jdk.jdkMirror, [
    'https://mirror-a.example/jdk',
    'https://mirror-b.example/jdk',
  ]);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let failed = 0;
for (const { name, fn } of cases) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : String(error));
  }
}

await delay(20);
if (unhandled.length > 0) {
  failed += 1;
  console.error(`FAIL unhandled rejections: ${unhandled.length}`);
  for (const reason of unhandled) console.error(reason);
} else {
  console.log('PASS no unhandled rejections');
}

console.log('');
console.log(`${cases.length - failed}/${cases.length} cases passed${failed ? `, ${failed} failed` : ''}`);
if (failed > 0) process.exitCode = 1;
