/**
 * lib/autosetup.js — first-use auto-provisioning orchestrator.
 *
 * A fresh plugin install cannot boot the VM until the host has a JDK, the
 * Android SDK command-line tools, the SDK packages, an x86_64 system image and
 * an AVD. `createAutoSetup()` runs that chain in the background on first use
 * and exposes a small JSON-safe progress snapshot for the HTTP routes, the
 * panel and the `apk_vm` Agent tool.
 *
 * Everything in this module lives in memory (no timers, no intervals) and every
 * environment operation is injected, so the orchestrator is fully testable
 * without network, disk or child processes:
 *
 *   detectEnvironment(opts)  -> environment report (see lib/setup.js)
 *   ensureJdk(opts)          -> { ok, ... }   install/locate a JDK 17
 *   bootstrapSdk(opts)       -> { ok, ... }   command-line tools + licenses
 *   installSdkPackages(opts) -> { ok, ... }   platform-tools/emulator/build-tools/platform
 *   installSystemImage(opts) -> { ok, ... }   system image
 *   createAvd(opts)          -> { ok, ... }   AVD
 *
 * Behaviour:
 *  - `start(reason)` checks the host first; when something is missing it runs
 *    the fixed step order jdk -> bootstrap -> tools -> image -> avd,
 *    re-detecting the environment after every step. Concurrent calls share one
 *    run (single-flight) and every outcome resolves with a status snapshot —
 *    failures never reject.
 *  - A missing CPU accelerator/hypervisor is a WARNING, not a failure: it is a
 *    host-level requirement the plugin cannot install, and the emulator can
 *    still fall back to software (TCG) emulation.
 *  - `cancel()` takes effect between steps (an in-flight download is not
 *    interrupted); `retry()` restarts a failed or cancelled run.
 *
 * Status snapshot (JSON-safe, small):
 *   { state, step, totalSteps, stepId, message, detail, error, warnings,
 *     startedAt, updatedAt, finishedAt, reason }
 */

/** Default AVD name, matching lib/setup.js. */
const DEFAULT_AVD_NAME = 'dsh_apk';
/** Default system image, matching lib/setup.js. */
const DEFAULT_SYSTEM_IMAGE = 'system-images;android-34;default;x86_64';
/** Keep status snapshots small; these are polled by the panel. */
const MAX_WARNINGS = 8;
const MAX_ERROR_CHARS = 600;
const MAX_DETAIL_TEXT = 400;

/** Fixed provisioning order. */
const STEP_ORDER = Object.freeze(['jdk', 'bootstrap', 'tools', 'image', 'avd']);

/** Step id -> injected dependency name. */
const STEP_DEP_NAMES = Object.freeze({
  jdk: 'ensureJdk',
  bootstrap: 'bootstrapSdk',
  tools: 'installSdkPackages',
  image: 'installSystemImage',
  avd: 'createAvd',
});

const STEP_LABELS = Object.freeze({
  jdk: 'install JDK 17',
  bootstrap: 'bootstrap the Android SDK command-line tools',
  tools: 'install platform-tools, emulator, build-tools and platform',
  image: 'install the Android system image',
  avd: 'create the Android virtual device',
});

const STEP_HINTS = Object.freeze({
  jdk: 'install JDK 17 manually and set cfg.jdkRoot, or retry with network access to the JDK download mirror',
  bootstrap: 'check network/proxy access to dl.google.com and retry',
  tools: 'check network/proxy access to dl.google.com and retry, or run sdkmanager manually',
  image: 'check network/proxy access and retry, or install the system image manually with sdkmanager',
  avd: 'make sure the system image is installed and avdmanager is available, then retry',
});

/** An accel/hypervisor report item: the host requirement this plugin cannot install. */
const ACCEL_MISSING_RE = /(accel|hypervisor|kvm|aehd|whpx|hvf|haxm)/i;

const unavailable = (name) => async () => ({ ok: false, error: `${name} dependency is not wired` });

function nowIso() {
  return new Date().toISOString();
}

/** Bound any value to a short JSON-safe string. */
function limitText(value, max = MAX_ERROR_CHARS) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function cloneDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const copy = {};
  for (const key of Object.keys(detail)) {
    const value = detail[key];
    if (Array.isArray(value)) copy[key] = value.slice();
    else if (value && typeof value === 'object') copy[key] = { ...value };
    else copy[key] = value;
  }
  return copy;
}

/**
 * Condense an environment report into the small `detail` object carried by the
 * status snapshot (paths are reduced to booleans; the panel only needs to know
 * what is present).
 */
function summarizeReport(report) {
  if (!report || typeof report !== 'object') return null;
  const accel = report.accel && typeof report.accel === 'object' ? report.accel : null;
  const java = typeof report.javaPresent === 'boolean' ? report.javaPresent : null;
  return {
    platform: report.platform ? limitText(report.platform, 40) : null,
    sdkRoot: report.sdkRoot ? limitText(report.sdkRoot, MAX_DETAIL_TEXT) : null,
    java,
    adb: Boolean(report.adbPath),
    emulator: Boolean(report.emulatorPath),
    sdkmanager: Boolean(report.sdkmanagerPath),
    avdmanager: Boolean(report.avdmanagerPath),
    systemImage: report.systemImage ? limitText(report.systemImage, 120) : null,
    systemImagePresent: report.systemImagePresent === true,
    avdName: report.avdName ? limitText(report.avdName, 120) : null,
    avdPresent: report.avdPresent === true,
    accel: accel
      ? { available: accel.available === true, backend: accel.backend ? limitText(accel.backend, 60) : null }
      : null,
    missing: Array.isArray(report.missing) ? report.missing.slice(0, 8).map((item) => limitText(item, 300)) : [],
  };
}

/** Every non-accel requirement is satisfied, only the hypervisor is missing. */
function accelOnlyMissing(report) {
  if (!report || typeof report !== 'object') return false;
  if (report.accel && report.accel.available === true) return false;
  if (!report.sdkRoot || !report.adbPath || !report.emulatorPath) return false;
  if (report.systemImagePresent !== true || report.avdPresent !== true) return false;
  if (report.javaPresent === false) return false;
  const missing = Array.isArray(report.missing) ? report.missing : [];
  if (missing.length === 0) return true;
  return missing.every((item) => ACCEL_MISSING_RE.test(String(item)));
}

function accelWarnings(report) {
  const warnings = [
    'No usable CPU acceleration (hypervisor) was detected. Enabling one is a host-level ' +
      'requirement (AEHD/WHPX on Windows, KVM on Linux, Hypervisor.Framework on macOS); ' +
      'the emulator will run under software emulation until it is enabled.',
  ];
  const notes = report && Array.isArray(report.hypervisorNotes) ? report.hypervisorNotes : [];
  for (const note of notes.slice(0, 4)) {
    const text = limitText(note, 300);
    if (text) warnings.push(text);
  }
  return warnings.slice(0, MAX_WARNINGS);
}

/** Parse the API level out of "system-images;android-34;default;x86_64". */
function apiLevelFromImage(systemImage) {
  const parts = String(systemImage || DEFAULT_SYSTEM_IMAGE).split(';');
  const match = /^(?:android-)?(\d+)$/.exec(String(parts[1] || '').trim());
  return match ? match[1] : '34';
}

/** Normalize `jdkMirror` to one URL or an ordered list of URLs (undefined = default). */
function normalizeJdkMirror(value) {
  const mirrors = (Array.isArray(value) ? value : [value])
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
  if (mirrors.length === 0) return undefined;
  return mirrors.length === 1 ? mirrors[0] : mirrors;
}

/**
 * Create an auto-provisioning orchestrator.
 *
 * @param {object} [options]
 * @param {boolean} [options.enabled=true] run auto-provisioning at all.
 * @param {string} [options.sdkRoot] Android SDK root (detection/install target).
 * @param {string} [options.adbPath] optional configured adb path (detection only).
 * @param {string} [options.emulatorPath] optional configured emulator path (detection only).
 * @param {string} [options.avdName='dsh_apk'] AVD to create.
 * @param {string} [options.systemImage=DEFAULT_SYSTEM_IMAGE] system image to install.
 * @param {string} [options.jdkRoot] managed JDK installation root.
 * @param {string|string[]} [options.jdkMirror] optional JDK download mirror override(s).
 * @param {string} [options.platform=process.platform] host platform for the tools.
 * @param {(line: string) => void} [options.log] progress log sink.
 * @param {(snapshot: object) => void} [options.onUpdate] status observer (receives copies).
 * @param {object} [options.deps] injected environment operations (all six optional).
 * @returns {{ start: Function, retry: Function, cancel: Function, status: Function }}
 */
export function createAutoSetup(options = {}) {
  const raw = options && typeof options === 'object' ? options : {};

  const enabled = raw.enabled !== false;
  const sdkRoot = typeof raw.sdkRoot === 'string' && raw.sdkRoot ? raw.sdkRoot : undefined;
  const adbPath = typeof raw.adbPath === 'string' && raw.adbPath ? raw.adbPath : undefined;
  const emulatorPath = typeof raw.emulatorPath === 'string' && raw.emulatorPath ? raw.emulatorPath : undefined;
  const jdkRoot = typeof raw.jdkRoot === 'string' && raw.jdkRoot ? raw.jdkRoot : undefined;
  const jdkMirror = normalizeJdkMirror(raw.jdkMirror);
  const avdName = typeof raw.avdName === 'string' && raw.avdName ? raw.avdName : DEFAULT_AVD_NAME;
  const systemImage =
    typeof raw.systemImage === 'string' && raw.systemImage ? raw.systemImage : DEFAULT_SYSTEM_IMAGE;
  const platform = raw.platform ? String(raw.platform) : process.platform;
  const log = typeof raw.log === 'function' ? raw.log : null;
  const onUpdate = typeof raw.onUpdate === 'function' ? raw.onUpdate : null;

  const injected = raw.deps && typeof raw.deps === 'object' ? raw.deps : {};
  const pick = (name) => (typeof injected[name] === 'function' ? injected[name] : unavailable(name));
  const deps = {
    detectEnvironment: pick('detectEnvironment'),
    ensureJdk: pick('ensureJdk'),
    bootstrapSdk: pick('bootstrapSdk'),
    installSdkPackages: pick('installSdkPackages'),
    installSystemImage: pick('installSystemImage'),
    createAvd: pick('createAvd'),
  };

  /* ---- in-memory state (never timers, always JSON-safe) ---- */
  let state = enabled ? 'idle' : 'disabled';
  let step = 0;
  let totalSteps = 0;
  let stepId = null;
  let message = enabled ? 'waiting for first use' : 'auto setup disabled';
  let detail = null;
  let error = null;
  let warnings = [];
  let startedAt = null;
  let updatedAt = null;
  let finishedAt = null;
  let reason = null;
  let running = null; // single-flight promise for the current chain
  let cancelRequested = false;

  function snapshot() {
    return {
      state,
      step,
      totalSteps,
      stepId,
      message,
      detail: cloneDetail(detail),
      error,
      warnings: warnings.slice(),
      startedAt,
      updatedAt,
      finishedAt,
      reason,
    };
  }

  /** Record a status message, then notify observers with an immutable copy. */
  function publish(text) {
    message = text;
    updatedAt = nowIso();
    const snap = snapshot();
    if (log) {
      try {
        log(`[auto-setup] ${text}`);
      } catch {
        /* a log sink must never break provisioning */
      }
    }
    if (onUpdate) {
      try {
        onUpdate(snap);
      } catch {
        /* an observer must never break provisioning */
      }
    }
    return snap;
  }

  function pushWarnings(list) {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (warnings.length >= MAX_WARNINGS) return;
      const text = limitText(item, 300);
      if (text && !warnings.includes(text)) warnings.push(text);
    }
  }

  function detectOptions() {
    const opts = { avdName, systemImage, platform };
    if (sdkRoot) opts.sdkRoot = sdkRoot;
    if (adbPath) opts.adbPath = adbPath;
    if (emulatorPath) opts.emulatorPath = emulatorPath;
    if (jdkRoot) opts.jdkRoot = jdkRoot;
    return opts;
  }

  /** Options passed to each provisioning dependency (argv-style, no shell). */
  function stepOptions(id) {
    const api = apiLevelFromImage(systemImage);
    const java = jdkRoot ? { jdkRoot } : {};
    switch (id) {
      case 'jdk':
        return { ...java, platform, ...(jdkMirror ? { jdkMirror } : {}) };
      case 'bootstrap':
        return {
          ...java,
          sdkRoot: sdkRoot || undefined,
          systemImage,
          platform,
          acceptLicenses: true,
        };
      case 'tools':
        return {
          ...java,
          sdkRoot: sdkRoot || undefined,
          packages: [
            'platform-tools',
            'emulator',
            `build-tools;${api}.0.0`,
            `platforms;android-${api}`,
          ],
          platform,
          acceptLicenses: true,
        };
      case 'image':
        return {
          ...java,
          sdkRoot: sdkRoot || undefined,
          systemImage,
          platform,
          acceptLicenses: true,
        };
      case 'avd':
        return {
          ...java,
          sdkRoot: sdkRoot || undefined,
          avdName,
          systemImage,
          platform,
          acceptLicenses: true,
        };
      default:
        return { ...java, sdkRoot: sdkRoot || undefined, platform };
    }
  }

  /** Steps needed for the current report, in the fixed order. */
  function planSteps(report) {
    const needed = [];
    if (!report || typeof report !== 'object') return needed;
    if (!report.javaPresent) needed.push('jdk');
    if (!report.sdkmanagerPath) needed.push('bootstrap');
    if (!report.adbPath || !report.emulatorPath) needed.push('tools');
    if (!report.systemImagePresent) needed.push('image');
    if (!report.avdPresent) needed.push('avd');
    return STEP_ORDER.filter((id) => needed.includes(id));
  }

  async function runDetect() {
    let report;
    try {
      report = await deps.detectEnvironment(detectOptions());
    } catch (err) {
      throw new Error(`environment detection failed: ${limitText(err && err.message ? err.message : err)}`);
    }
    if (!report || typeof report !== 'object') {
      throw new Error('environment detection returned no report');
    }
    return report;
  }

  /** Run one dependency; resolve {ok,error,warnings} — never reject. */
  async function runStep(id) {
    let result;
    try {
      result = await deps[STEP_DEP_NAMES[id]](stepOptions(id));
    } catch (err) {
      return { ok: false, error: `${id} failed: ${limitText(err && err.message ? err.message : err)}` };
    }
    if (result && typeof result === 'object' && result.ok === false) {
      return { ok: false, error: limitText(result.error || `${id} returned ok:false`) };
    }
    const stepWarnings = result && typeof result === 'object' && Array.isArray(result.warnings) ? result.warnings : [];
    return { ok: true, warnings: stepWarnings };
  }

  function finishReady(report, text) {
    state = 'ready';
    stepId = 'ready';
    error = null;
    detail = summarizeReport(report) || detail;
    finishedAt = nowIso();
    publish(text);
    return snapshot();
  }

  function finishFailed(errorText, messageText = 'auto setup failed') {
    state = 'failed';
    stepId = 'failed';
    error = limitText(errorText || 'auto setup failed');
    finishedAt = nowIso();
    publish(messageText);
    return snapshot();
  }

  function finishCancelled() {
    state = 'cancelled';
    stepId = 'cancelled';
    finishedAt = nowIso();
    publish('auto setup cancelled');
    return snapshot();
  }

  /** Evaluate the final environment report (ready / accel-only warning / failed). */
  function finish(report) {
    if (report && report.ok === true) return finishReady(report, 'auto setup complete');
    if (accelOnlyMissing(report)) {
      pushWarnings(accelWarnings(report));
      return finishReady(report, 'auto setup complete (software emulation: no hypervisor available)');
    }
    const missing = report && Array.isArray(report.missing) ? report.missing.map((item) => limitText(item, 300)) : [];
    const missingText = missing.length
      ? `environment still incomplete: ${missing.join('; ')}`
      : 'environment is still not ready after auto setup';
    return finishFailed(missingText);
  }

  async function runChain(reasonText) {
    state = 'running';
    step = 0;
    totalSteps = 0;
    stepId = 'detect';
    message = 'checking the host environment…';
    detail = null;
    error = null;
    warnings = [];
    reason = reasonText ? limitText(String(reasonText), 80) : null;
    startedAt = nowIso();
    updatedAt = startedAt;
    finishedAt = null;
    cancelRequested = false;
    publish('checking the host environment…');

    try {
      let report = await runDetect();
      detail = summarizeReport(report);

      if (report.ok === true) return finishReady(report, 'environment already provisioned');

      const needed = planSteps(report);
      totalSteps = needed.length;
      publish(
        needed.length
          ? `environment incomplete: ${needed.length} step(s) queued (${needed.join(' -> ')})`
          : 'environment incomplete: no installable steps remain',
      );

      for (let index = 0; index < needed.length; index += 1) {
        if (cancelRequested) return finishCancelled();
        const id = needed[index];
        step = index + 1;
        stepId = id;
        publish(`step ${step}/${totalSteps}: ${STEP_LABELS[id]}`);
        const outcome = await runStep(id);
        // A cancel requested while the step was in flight wins over the result.
        if (cancelRequested) return finishCancelled();
        if (!outcome.ok) {
          return finishFailed(`${outcome.error} [hint: ${STEP_HINTS[id]}]`, `${STEP_LABELS[id]} failed`);
        }
        pushWarnings(outcome.warnings);
        // Always re-detect after a step: downloaders can also satisfy later steps.
        report = await runDetect();
        detail = summarizeReport(report);
        stepId = id;
        publish(`step ${step}/${totalSteps} finished: ${id}`);
      }

      return finish(report);
    } catch (err) {
      return finishFailed(limitText(err && err.message ? err.message : err), 'auto setup failed');
    }
  }

  /**
   * Start (or join) a provisioning run.
   * @param {string} [reason] short label for why the run started (debugging).
   * @returns {Promise<object>} final status snapshot; never rejects.
   */
  async function start(reasonText) {
    if (!enabled) return snapshot();
    if (running) return running;
    if (state === 'ready') return snapshot();
    running = runChain(reasonText).finally(() => {
      running = null;
    });
    return running;
  }

  /** Start again after a failed/cancelled run; a no-op otherwise. */
  async function retry() {
    if (state === 'failed' || state === 'cancelled') return start('retry');
    return snapshot();
  }

  /**
   * Request cancellation. An in-flight step (e.g. a download) is not
   * interrupted; the state becomes 'cancelled' once that step returns.
   */
  function cancel() {
    if (state === 'running') {
      cancelRequested = true;
      if (!/cancel/i.test(message)) publish('cancelling after the current step…');
    }
    return snapshot();
  }

  /** Fresh copy of the current status snapshot. */
  function status() {
    return snapshot();
  }

  return { start, retry, cancel, status };
}

export { DEFAULT_AVD_NAME, DEFAULT_SYSTEM_IMAGE, STEP_ORDER };
