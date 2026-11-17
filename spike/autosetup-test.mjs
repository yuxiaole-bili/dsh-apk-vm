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
 * throwing (no unhandled rejection), JSON-safe immutable status snapshots,
 * jdkMirror passthrough/normalization, throttled JDK download progress in
 * `detail.progress` (and its suppression after cancel), the 3 GB disk-space
 * precheck for the JDK and system-image steps (plus best-effort behaviour when
 * statfs is unavailable), the cumulative install-plan disk budget and its
 * minFreeDiskBytes override, `<jdkRoot>/.lock` contention/stale-removal/release
 * semantics, the transient-error retry loop (exponential backoff, retry status
 * updates, permanent-error short-circuit, budget exhaustion, cancel during the
 * backoff wait), and the host-architecture default system image.
 *
 *   cd apk-vm-preview
 *   node spike/autosetup-test.mjs
 *
 * Exit code 0 = every check passed.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAutoSetup } from '../lib/autosetup.js';
import { DEFAULT_AVD_NAME, DEFAULT_SYSTEM_IMAGE } from '../lib/setup.js';

const DEFAULT_IMAGE = DEFAULT_SYSTEM_IMAGE;

/** Per-case throw-away directories (locks are real files under a temp jdkRoot). */
const tempRoots = [];
function tempRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-autosetup-test-'));
  tempRoots.push(root);
  return root;
}
process.on('exit', () => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
});

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
  const root = tempRoot();
  const jdkRoot = path.join(root, 'jdk');
  const fx = makeFixture(MISSING_ALL);
  const updates = [];
  const api = createAutoSetup({
    enabled: true,
    sdkRoot: '/opt/android-sdk',
    avdName: 'dsh_apk',
    systemImage: DEFAULT_IMAGE,
    jdkRoot,
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
  assert.equal(fx.seen.jdk.jdkRoot, jdkRoot);
  assert.equal(fx.seen.jdk.platform, 'linux');
  assert.equal(typeof fx.seen.jdk.onProgress, 'function', 'ensureJdk must receive an onProgress reporter');
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
  const root = tempRoot();
  let imageAttempts = 0;
  const fx = makeFixture(MISSING_ALL, {
    installSystemImage: ({ flags }) => {
      imageAttempts += 1;
      if (imageAttempts === 1) return { ok: false, error: 'image download failed: HTTP 503' };
      flags.image = true;
      return { ok: true };
    },
  });
  // HTTP 503 is a transient error: pin retries to 1 so this case still tests
  // the explicit failed-run → retry() flow instead of the internal retry loop.
  const api = createAutoSetup({
    enabled: true,
    deps: fx.deps,
    jdkRoot: path.join(root, 'jdk'),
    stepRetries: 1,
  });

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
  const root = tempRoot();
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
  api = createAutoSetup({ enabled: true, deps: fx.deps, jdkRoot: path.join(root, 'jdk') });

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
  const root = tempRoot();
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
  const api = createAutoSetup({ enabled: true, deps: fx.deps, jdkRoot: path.join(root, 'jdk') });

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
  const root = tempRoot();
  const fx = makeFixture(MISSING_ALL);
  const updates = [];
  const api = createAutoSetup({
    enabled: true,
    deps: fx.deps,
    jdkRoot: path.join(root, 'jdk-1'),
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
  const failedApi = createAutoSetup({
    enabled: true,
    deps: failing.deps,
    jdkRoot: path.join(root, 'jdk-2'),
  });
  const failed = await failedApi.start('first-use');
  assert.equal(failed.state, 'failed');
  assertStatusShape(failed);
  assert.ok(JSON.stringify(failed).length < 4096, 'status snapshot must stay small');
});

test('11. jdkMirror: string/list normalization passed to ensureJdk only', async () => {
  const root = tempRoot();
  // A single mirror stays a plain string.
  const single = makeFixture(MISSING_ALL);
  const singleApi = createAutoSetup({
    enabled: true,
    deps: single.deps,
    jdkRoot: path.join(root, 'jdk-1'),
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
    jdkRoot: path.join(root, 'jdk-2'),
    jdkMirror: [' https://mirror-a.example/jdk ', '', 'https://mirror-b.example/jdk'],
  });
  const listedFinal = await listedApi.start('first-use');
  assert.equal(listedFinal.state, 'ready');
  assert.deepEqual(listed.seen.jdk.jdkMirror, [
    'https://mirror-a.example/jdk',
    'https://mirror-b.example/jdk',
  ]);
});

test('12. JDK download progress is throttled into detail.progress', async () => {
  const root = tempRoot();
  const jdkRoot = path.join(root, 'jdk');
  const statuses = [];
  const fx = makeFixture(MISSING_ALL, {
    ensureJdk: ({ flags, opts }) => {
      assert.equal(typeof opts.onProgress, 'function', 'ensureJdk must receive onProgress');
      opts.onProgress({ step: 'download', received: 0, total: 1000 });
      opts.onProgress({ step: 'download', received: 10, total: 1000 }); // 1%: below the throttle
      opts.onProgress({ step: 'download', received: 250, total: 1000 }); // 25%: published
      opts.onProgress({ step: 'download', received: 1000, total: 1000 }); // 100%: always published
      flags.java = true;
      return { ok: true };
    },
  });
  const api = createAutoSetup({
    enabled: true,
    deps: fx.deps,
    jdkRoot,
    onUpdate: (status) => statuses.push(status),
  });

  const final = await api.start('first-use');

  assert.equal(final.state, 'ready');
  const progressStatuses = statuses.filter((status) => status.detail && status.detail.progress);
  assert.equal(progressStatuses.length, 3, 'only 0%, 25% and 100% may be published');
  const progress = progressStatuses.map((status) => status.detail.progress);
  for (const entry of progress) {
    assert.deepEqual(Object.keys(entry).sort(), ['percent', 'received', 'total']);
    assert.equal(entry.total, 1000);
  }
  assert.deepEqual(
    progress.map((entry) => entry.percent),
    [0, 25, 100],
  );
  assert.deepEqual(
    progress.map((entry) => entry.received),
    [0, 250, 1000],
  );
  assert.ok(!('progress' in final.detail), 'the final ready detail must not keep download progress');
  assert.equal(fx.calls.jdk, 1);
});

test('13. cancel stops download-progress updates', async () => {
  const root = tempRoot();
  const jdkRoot = path.join(root, 'jdk');
  let api;
  const statuses = [];
  const fx = makeFixture(MISSING_ALL, {
    ensureJdk: ({ flags, opts }) => {
      opts.onProgress({ step: 'download', received: 100, total: 1000 });
      api.cancel();
      opts.onProgress({ step: 'download', received: 200, total: 1000 }); // must be ignored
      flags.java = true;
      return { ok: true };
    },
  });
  api = createAutoSetup({
    enabled: true,
    deps: fx.deps,
    jdkRoot,
    onUpdate: (status) => statuses.push(status),
  });

  const final = await api.start('first-use');

  assert.equal(final.state, 'cancelled');
  const observed = statuses
    .filter((status) => status.detail && status.detail.progress)
    .map((status) => status.detail.progress.received);
  assert.ok(observed.length >= 1, 'the pre-cancel progress update must be visible');
  assert.ok(observed.every((received) => received === 100), `no progress after cancel, saw ${observed.join(',')}`);
  assert.ok(!existsSync(path.join(jdkRoot, '.lock')), 'the JDK lock must be released on cancel');
});

test('14. disk precheck fails the JDK step with an actionable error', async () => {
  const root = tempRoot();
  const jdkRoot = path.join(root, 'jdk');
  const fx = makeFixture(MISSING_ALL);
  const api = createAutoSetup({
    enabled: true,
    deps: fx.deps,
    jdkRoot,
    // Disable the cumulative plan precheck (1 byte) so this case still tests the
    // per-step JDK guard; the cumulative guard has its own case (25).
    minFreeDiskBytes: 1,
    statfs: async () => ({ bsize: 4096, bavail: 10 }), // ~40 KB free
  });

  const final = await api.start('first-use');

  assert.equal(final.state, 'failed');
  assert.match(final.error, /not enough free disk space/);
  assert.match(final.error, /at least 3\.0 GB is required/);
  assert.match(final.error, /free up disk space and retry/);
  assert.equal(fx.calls.jdk, 0, 'the JDK download must not start');
  assert.ok(!existsSync(path.join(jdkRoot, '.lock')), 'no lock may be taken when the precheck fails');
});

test('15. disk precheck fails the image step before sdkmanager runs', async () => {
  const root = tempRoot();
  const fx = makeFixture({ java: true, sdk: true, adb: true, emulator: true, image: false, avd: false });
  const api = createAutoSetup({
    enabled: true,
    deps: fx.deps,
    sdkRoot: path.join(root, 'sdk'),
    statfs: async () => ({ bsize: 4096, bavail: 10 }),
    // The cumulative plan precheck is disabled (1 byte) so this case still
    // exercises the per-step 3 GB guard that fails before sdkmanager runs.
    minFreeDiskBytes: 1,
  });

  const final = await api.start('first-use');

  assert.equal(final.state, 'failed');
  assert.match(final.error, /not enough free disk space for the Android system image download/);
  assert.equal(fx.calls.image, 0, 'sdkmanager must not run');
  assert.equal(fx.calls.avd, 0);
});

test('16. an unreadable filesystem does not block provisioning (best effort)', async () => {
  const root = tempRoot();
  const fx = makeFixture(MISSING_ALL);
  const api = createAutoSetup({
    enabled: true,
    deps: fx.deps,
    jdkRoot: path.join(root, 'jdk'),
    statfs: async () => {
      throw new Error('statfs unavailable');
    },
  });

  const final = await api.start('first-use');

  assert.equal(final.state, 'ready');
  assert.equal(fx.calls.jdk, 1);
});

test('17. a fresh provisioning lock blocks the JDK step', async () => {
  const root = tempRoot();
  const jdkRoot = path.join(root, 'jdk');
  mkdirSync(jdkRoot, { recursive: true });
  const lockPath = path.join(jdkRoot, '.lock');
  writeFileSync(lockPath, `${JSON.stringify({ pid: 424242, startedAt: new Date().toISOString() })}\n`);

  const fx = makeFixture(MISSING_ALL);
  const api = createAutoSetup({ enabled: true, deps: fx.deps, jdkRoot });

  const final = await api.start('first-use');

  assert.equal(final.state, 'failed');
  assert.match(final.error, /another provisioning process is downloading the JDK/);
  assert.match(final.error, /pid 424242/);
  assert.equal(fx.calls.jdk, 0, 'the JDK download must not start');
  assert.ok(existsSync(lockPath), 'a live lock must not be removed');
});

test('18. a stale lock (>30 min) is removed and provisioning proceeds', async () => {
  const root = tempRoot();
  const jdkRoot = path.join(root, 'jdk');
  mkdirSync(jdkRoot, { recursive: true });
  const lockPath = path.join(jdkRoot, '.lock');
  const stale = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  writeFileSync(lockPath, `${JSON.stringify({ pid: 999999, startedAt: stale })}\n`);

  const fx = makeFixture(MISSING_ALL);
  const api = createAutoSetup({ enabled: true, deps: fx.deps, jdkRoot });

  const final = await api.start('first-use');

  assert.equal(final.state, 'ready');
  assert.equal(fx.calls.jdk, 1);
  assert.ok(!existsSync(lockPath), 'the stale lock must be removed and the new lock released');
});

test('19. the JDK lock is released after a failed step and on retry', async () => {
  const root = tempRoot();
  const jdkRoot = path.join(root, 'jdk');
  const lockPath = path.join(jdkRoot, '.lock');
  let attempts = 0;
  const fx = makeFixture({ ...DEFAULT_FLAGS, java: false }, {
    ensureJdk: ({ flags }) => {
      attempts += 1;
      if (attempts === 1) return { ok: false, error: 'JDK download failed: HTTP 503' };
      flags.java = true;
      return { ok: true };
    },
  });
  // HTTP 503 is transient: disable the internal retry loop so retry() still
  // exercises the released-lock → second run path.
  const api = createAutoSetup({ enabled: true, deps: fx.deps, jdkRoot, stepRetries: 1 });

  const first = await api.start('first-use');
  assert.equal(first.state, 'failed');
  assert.ok(!existsSync(lockPath), 'the lock must be released after a failed step');

  const second = await api.retry();
  assert.equal(second.state, 'ready');
  assert.equal(second.error, null);
  assert.ok(!existsSync(lockPath), 'the lock must be released after the retried step');
});

test('20. the default system image follows the host CPU arch', async () => {
  const expectedAbi = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  assert.equal(DEFAULT_IMAGE.split(';')[3], expectedAbi);
  assert.equal(DEFAULT_IMAGE, `system-images;android-34;default;${expectedAbi}`);
  assert.equal(DEFAULT_AVD_NAME, 'dsh_apk');

  const fx = makeFixture();
  const api = createAutoSetup({ enabled: true, deps: fx.deps });
  const final = await api.start('first-use');
  assert.equal(final.state, 'ready');
  assert.equal(fx.detectOptions[0].systemImage, DEFAULT_IMAGE, 'detection must use the host-matching image');
});

test('21. a transient step failure is retried automatically', async () => {
  const root = tempRoot();
  let imageAttempts = 0;
  const fx = makeFixture(MISSING_ALL, {
    installSystemImage: ({ flags }) => {
      imageAttempts += 1;
      if (imageAttempts === 1) return { ok: false, error: 'image download failed: HTTP 503' };
      flags.image = true;
      return { ok: true };
    },
  });
  const delays = [];
  const updates = [];
  const api = createAutoSetup({
    enabled: true,
    deps: fx.deps,
    jdkRoot: path.join(root, 'jdk'),
    stepRetries: 3,
    retryDelayMs: 1000,
    sleep: async (ms) => {
      delays.push(ms);
    },
    onUpdate: (status) => updates.push(status),
  });

  const final = await api.start('first-use');

  assert.equal(final.state, 'ready');
  assert.equal(final.error, null);
  assert.equal(fx.calls.image, 2, 'the image step runs twice: failed attempt + retry');
  assert.deepEqual(fx.order.filter((id) => id === 'image'), ['image', 'image']);
  assert.ok(fx.calls.detect >= 6, 'the chain keeps re-detecting after the successful retry');

  const retryUpdate = updates.find((status) => status.detail && status.detail.attempt === 2);
  assert.ok(retryUpdate, 'a retry status update must be published');
  assert.equal(retryUpdate.state, 'running');
  assert.equal(retryUpdate.stepId, 'image');
  assert.match(retryUpdate.message, /retry 2\/3 in 1s: image download failed: HTTP 503/);
  assert.equal(retryUpdate.detail.maxAttempts, 3);
  assert.equal(retryUpdate.detail.nextDelayMs, 1000);
  assert.ok(delays.length >= 1, 'the backoff wait must go through the injected sleep');
  assert.ok(
    delays.every((ms) => ms > 0 && ms <= 250),
    `the retry wait is sliced, saw ${delays.join(',')}`,
  );
  assertStatusShape(retryUpdate);
  assertStatusShape(final);
});

test('22. a permanent step failure is not retried', async () => {
  const root = tempRoot();
  const fx = makeFixture(MISSING_ALL, {
    bootstrapSdk: () => ({ ok: false, error: 'download checksum mismatch' }),
  });
  const delays = [];
  const api = createAutoSetup({
    enabled: true,
    deps: fx.deps,
    jdkRoot: path.join(root, 'jdk'),
    stepRetries: 3,
    retryDelayMs: 1000,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });

  const final = await api.start('first-use');

  assert.equal(final.state, 'failed');
  assert.match(final.error, /download checksum mismatch/);
  assert.equal(fx.calls.bootstrap, 1, 'permanent errors are not retried');
  assert.deepEqual(delays, [], 'no backoff wait for a permanent error');
});

test('23. transient failures exhaust the retry budget with the last error', async () => {
  const root = tempRoot();
  const fx = makeFixture(MISSING_ALL, {
    installSystemImage: () => ({ ok: false, error: 'image download failed: HTTP 503' }),
  });
  const delays = [];
  const api = createAutoSetup({
    enabled: true,
    deps: fx.deps,
    jdkRoot: path.join(root, 'jdk'),
    stepRetries: 3,
    retryDelayMs: 1000,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });

  const final = await api.start('first-use');

  assert.equal(final.state, 'failed');
  assert.equal(fx.calls.image, 3, 'stepRetries=3 means three attempts in total');
  assert.match(final.error, /image download failed: HTTP 503/);
  assert.match(final.error, /still failing after 3 attempts/);
  assert.match(final.error, /hint: check network\/proxy access/i);
  // Attempt 1 waits 1000 ms, attempt 2 waits 2000 ms (exponential ×2).
  const totalWait = delays.reduce((sum, ms) => sum + ms, 0);
  assert.equal(totalWait, 3000, `exponential backoff must wait 1 s then 2 s, saw ${delays.join(',')}`);
});

test('24. cancel interrupts the retry backoff wait', async () => {
  const root = tempRoot();
  let api;
  const fx = makeFixture(MISSING_ALL, {
    installSystemImage: () => ({ ok: false, error: 'image download failed: HTTP 503' }),
  });
  api = createAutoSetup({
    enabled: true,
    deps: fx.deps,
    jdkRoot: path.join(root, 'jdk'),
    stepRetries: 5,
    retryDelayMs: 2000,
    sleep: async () => {
      api.cancel();
    },
  });

  const final = await api.start('first-use');

  assert.equal(final.state, 'cancelled');
  assert.equal(final.finishedAt !== null, true);
  assert.equal(fx.calls.image, 1, 'no further attempt after the cancel during the wait');
  assert.equal(fx.calls.avd, 0);
});

test('25. the cumulative disk precheck fails before any step runs', async () => {
  const root = tempRoot();
  const fx = makeFixture(MISSING_ALL);
  const api = createAutoSetup({
    enabled: true,
    deps: fx.deps,
    jdkRoot: path.join(root, 'jdk'),
    sdkRoot: path.join(root, 'sdk'),
    statfs: async () => ({ bsize: 4096, bavail: 10 }), // ~40 KB free
  });

  const final = await api.start('first-use');

  assert.equal(final.state, 'failed');
  assert.match(final.error, /not enough free disk space to provision the Android VM environment/);
  assert.match(final.error, /free up disk space and retry/);
  assert.deepEqual(fx.calls, { detect: 1, jdk: 0, bootstrap: 0, tools: 0, image: 0, avd: 0 });

  // Zero-config runs have no sdkRoot: the fallback target is the home directory,
  // so the cumulative guard still protects a first run.
  const fxHome = makeFixture(MISSING_ALL);
  const homeApi = createAutoSetup({
    enabled: true,
    deps: fxHome.deps,
    jdkRoot: path.join(root, 'jdk-home'),
    home: path.join(root, 'home'),
    statfs: async () => ({ bsize: 4096, bavail: 10 }),
  });
  const homeFinal = await homeApi.start('first-use');
  assert.equal(homeFinal.state, 'failed');
  assert.match(homeFinal.error, /not enough free disk space to provision the Android VM environment/);
  assert.equal(fxHome.calls.jdk, 0, 'the zero-config plan fails before the JDK download');
});

test('26. minFreeDiskBytes overrides the plan budget but not the per-step check', async () => {
  const root = tempRoot();
  const fx = makeFixture(MISSING_ALL);
  const api = createAutoSetup({
    enabled: true,
    deps: fx.deps,
    jdkRoot: path.join(root, 'jdk'),
    sdkRoot: path.join(root, 'sdk'),
    minFreeDiskBytes: 1,
    statfs: async () => ({ bsize: 4096, bavail: 10 }),
  });

  const final = await api.start('first-use');

  assert.equal(final.state, 'failed');
  assert.match(final.error, /not enough free disk space for the JDK download/);
  assert.match(final.error, /at least 3\.0 GB is required/);
  assert.equal(fx.calls.jdk, 0, 'the JDK download must not start');
  assert.equal(fx.calls.bootstrap, 0);
});

test('27. sdkmanager options are passed through to the SDK steps only', async () => {
  const root = tempRoot();
  const fx = makeFixture(MISSING_ALL);
  const networkProxy = { host: 'proxy.local', port: 3128 };
  const sdkManagerArgs = ['--channel=0'];
  const sdkManagerEnv = { HTTPS_PROXY: 'http://proxy.local:3128' };
  const commandLineToolsUrl = 'https://example.test/commandlinetools-custom.zip';
  const api = createAutoSetup({
    enabled: true,
    deps: fx.deps,
    jdkRoot: path.join(root, 'jdk'),
    networkProxy,
    sdkManagerArgs,
    sdkManagerEnv,
    commandLineToolsUrl,
  });

  const final = await api.start('first-use');

  assert.equal(final.state, 'ready');
  assert.equal(fx.seen.bootstrap.commandLineToolsUrl, commandLineToolsUrl);
  for (const id of ['bootstrap', 'tools', 'image']) {
    assert.deepEqual(fx.seen[id].networkProxy, networkProxy, `${id} receives networkProxy`);
    assert.deepEqual(fx.seen[id].sdkManagerArgs, sdkManagerArgs, `${id} receives sdkManagerArgs`);
    assert.deepEqual(fx.seen[id].sdkManagerEnv, sdkManagerEnv, `${id} receives sdkManagerEnv`);
  }
  assert.ok(!('commandLineToolsUrl' in fx.seen.tools), 'only bootstrap uses commandLineToolsUrl');
  assert.ok(!('commandLineToolsUrl' in fx.seen.image), 'only bootstrap uses commandLineToolsUrl');
  assert.ok(!('networkProxy' in fx.seen.jdk), 'the JDK step has no sdkmanager options');
  assert.ok(!('sdkManagerArgs' in fx.seen.jdk));
  assert.ok(!('networkProxy' in fx.seen.avd), 'the AVD step has no sdkmanager options');
  assert.ok(!('commandLineToolsUrl' in fx.seen.avd));
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
