/**
 * lib/autosetup.js — first-use auto-provisioning orchestrator.
 *
 * A fresh plugin install cannot boot the VM until the host has a JDK, the
 * Android SDK command-line tools, the SDK packages, a system image matching
 * the host CPU and an AVD. `createAutoSetup()` runs that chain in the
 * background on first use and exposes a small JSON-safe progress snapshot for
 * the HTTP routes, the panel and the `apk_vm` Agent tool.
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
 *  - While `ensureJdk` downloads, throttled progress is published as
 *    `status.detail.progress = { received, total, percent }` (total/percent may
 *    be null when the server does not send a content length).
 *  - The JDK step holds an exclusive lock file `<jdkRoot>/.lock` so two plugin
 *    processes cannot download the same archive at once; locks older than 30
 *    minutes are treated as abandoned and removed.
 *  - The JDK and system-image steps first check for at least 3 GB of free disk
 *    space and fail with an actionable error instead of a truncated download.
 *    The whole queued plan is also checked once against a cumulative
 *    free-space estimate before the first step starts (best effort; the target
 *    is the configured SDK root, the AVD home's parent, or the home directory).
 *  - Transient step failures (timeouts, stalled/hung transfers, ECONNRESET/
 *    ECONNREFUSED/5xx, DNS/network errors) are retried up to `stepRetries`
 *    times with exponential backoff; the retry attempt and next delay are
 *    visible in the status message and `detail`. Permanent failures (4xx,
 *    checksum mismatch, missing tools, invalid options) fail immediately.
 *    Cancellation requested during the backoff wait is honored.
 *
 * Status snapshot (JSON-safe, small):
 *   { state, step, totalSteps, stepId, message, detail, error, warnings,
 *     startedAt, updatedAt, finishedAt, reason }
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultJdkRoot } from './jdk.js';
import { DEFAULT_AVD_NAME, DEFAULT_SYSTEM_IMAGE } from './setup.js';

/** Keep status snapshots small; these are polled by the panel. */
const MAX_WARNINGS = 8;
const MAX_ERROR_CHARS = 600;
const MAX_DETAIL_TEXT = 400;

/** Minimum free space required before a JDK/system-image download (bytes). */
const MIN_FREE_DISK_BYTES = 3 * 1024 ** 3;
/** Exclusive provisioning lock file inside the managed JDK root. */
const LOCK_FILE_NAME = '.lock';
/** A lock older than this is considered abandoned and is removed. */
const LOCK_STALE_MS = 30 * 60 * 1000;
/** Minimum percent delta between two published download-progress updates. */
const PROGRESS_MIN_PERCENT_DELTA = 5;
/** Steps that download large artifacts and therefore need the disk precheck. */
const DISK_CHECK_STEPS = Object.freeze({ jdk: 'JDK', image: 'Android system image' });

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

/** Per-step retry policy: transient network failures are retried with backoff. */
const DEFAULT_STEP_RETRIES = 3;
const MIN_STEP_RETRIES = 1;
const MAX_STEP_RETRIES = 10;
const DEFAULT_RETRY_DELAY_MS = 2000;
const MAX_RETRY_DELAY_MS = 30 * 1000;

/** Rough per-step download/install footprint used by the cumulative disk precheck. */
const STEP_DISK_ESTIMATES = Object.freeze({
  jdk: 650 * 1024 ** 2,
  bootstrap: 200 * 1024 ** 2,
  tools: 1.6 * 1024 ** 3,
  image: 4.0 * 1024 ** 3,
  avd: 400 * 1024 ** 2,
});

/**
 * Permanent (do not retry) failures win over transient keywords: a 4xx from
 * sdkmanager, a checksum mismatch, a missing tool or an invalid option is not
 * going to fix itself by waiting.
 */
const PERMANENT_ERROR_RE =
  /HTTP 4\d\d|checksum mismatch|not found: install|sdkmanager not found|java \(jdk 17\+\) is required|android sdk not found|unsupported platform|invalid |must be |must not /i;
/** Transient failures worth retrying with exponential backoff. */
const TRANSIENT_ERROR_RE =
  /timed out|timeout|stalled|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|ENETUNREACH|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|HTTP 5\d\d/i;

/** Classify a step error message: true when retrying may succeed. */
function isTransientSetupError(message) {
  const text = limitText(message, MAX_ERROR_CHARS);
  if (!text) return false;
  if (PERMANENT_ERROR_RE.test(text)) return false;
  return TRANSIENT_ERROR_RE.test(text);
}

/** Clamp an integer option into [min, max], falling back when not a number. */
function clampIntegerOption(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

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

function formatMegabytes(bytes) {
  return `${Math.max(0, Math.round(bytes / (1024 * 1024)))} MB`;
}

function formatGigabytes(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
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
 * @param {number} [options.jdkVersion] pinned Temurin major for the managed JDK (default 17).
 * @param {string} [options.platform=process.platform] host platform for the tools.
 * @param {string} [options.home] home directory for jdkRoot discovery (default `os.homedir()`).
 * @param {object} [options.env] environment map passed to JDK discovery (tests/hermetic runs).
 * @param {Function} [options.statfs] injected `fs.statfs`-shaped free-space probe (tests).
 * @param {number} [options.stepRetries=3] attempts per step on transient failures (clamped to 1..10).
 * @param {number} [options.retryDelayMs=2000] first retry delay (ms); doubles per attempt, capped at 30 s.
 * @param {number} [options.minFreeDiskBytes] override the cumulative free-space budget for the queued plan.
 * @param {Function} [options.sleep] injected `(ms) => Promise` wait used by the retry backoff (tests).
 * @param {string[]} [options.sdkManagerArgs] extra sdkmanager argv forwarded to bootstrap/tools/image.
 * @param {Record<string,string>} [options.sdkManagerEnv] extra sdkmanager child env forwarded to those steps.
 * @param {{host:string,port:number,user?:string,password?:string}} [options.networkProxy] sdkmanager proxy.
 * @param {string} [options.commandLineToolsUrl] cmdline-tools archive override (bootstrap step only).
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
  const jdkVersion =
    raw.jdkVersion === undefined || raw.jdkVersion === null || raw.jdkVersion === ''
      ? undefined
      : Number(raw.jdkVersion);
  const avdName = typeof raw.avdName === 'string' && raw.avdName ? raw.avdName : DEFAULT_AVD_NAME;
  const systemImage =
    typeof raw.systemImage === 'string' && raw.systemImage ? raw.systemImage : DEFAULT_SYSTEM_IMAGE;
  const platform = raw.platform ? String(raw.platform) : process.platform;
  const home = typeof raw.home === 'string' && raw.home ? raw.home : undefined;
  const env = raw.env && typeof raw.env === 'object' ? raw.env : undefined;
  const log = typeof raw.log === 'function' ? raw.log : null;
  const onUpdate = typeof raw.onUpdate === 'function' ? raw.onUpdate : null;
  const stepRetries = clampIntegerOption(raw.stepRetries, DEFAULT_STEP_RETRIES, MIN_STEP_RETRIES, MAX_STEP_RETRIES);
  const retryDelayMs = clampIntegerOption(raw.retryDelayMs, DEFAULT_RETRY_DELAY_MS, 1, MAX_RETRY_DELAY_MS);
  const minFreeDiskBytes =
    Number.isFinite(Number(raw.minFreeDiskBytes)) && Number(raw.minFreeDiskBytes) > 0
      ? Math.floor(Number(raw.minFreeDiskBytes))
      : null;
  const sleep =
    typeof raw.sleep === 'function'
      ? raw.sleep
      : (ms) =>
          new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            if (typeof timer.unref === 'function') timer.unref();
          });
  // sdkmanager hardening options forwarded to the steps that run sdkmanager.
  const sdkManagerOptions = {};
  if (raw.sdkManagerArgs !== undefined) sdkManagerOptions.sdkManagerArgs = raw.sdkManagerArgs;
  if (raw.sdkManagerEnv !== undefined) sdkManagerOptions.sdkManagerEnv = raw.sdkManagerEnv;
  if (raw.networkProxy !== undefined) sdkManagerOptions.networkProxy = raw.networkProxy;
  const commandLineToolsUrl =
    typeof raw.commandLineToolsUrl === 'string' && raw.commandLineToolsUrl ? raw.commandLineToolsUrl : undefined;

  const injected = raw.deps && typeof raw.deps === 'object' ? raw.deps : {};
  const statfs =
    typeof raw.statfs === 'function'
      ? raw.statfs
      : typeof injected.statfs === 'function'
        ? injected.statfs
        : typeof fsp.statfs === 'function'
          ? fsp.statfs.bind(fsp)
          : null;
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
  let downloadProgress = null; // last published {received,total,percent} for the JDK step

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

  /**
   * Record a status message, then notify observers with an immutable copy.
   * `extraDetail` is merged shallowly into `detail` (retry attempt metadata).
   */
  function publish(text, extraDetail) {
    message = text;
    if (extraDetail && typeof extraDetail === 'object') {
      detail = { ...(detail && typeof detail === 'object' ? detail : {}), ...extraDetail };
    }
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

  /** The managed JDK root shared by `ensureJdk()` and the provisioning lock. */
  function jdkDirectory() {
    if (jdkRoot) return jdkRoot;
    try {
      return defaultJdkRoot({ home, env, platform }) || null;
    } catch {
      return null;
    }
  }

  /**
   * Publish throttled JDK download progress as `detail.progress`. Only the
   * three documented fields are exposed; updates stop as soon as a cancel has
   * been requested.
   */
  function reportJdkProgress(event) {
    if (cancelRequested || state !== 'running') return;
    if (!event || typeof event !== 'object') return;
    const received = Number(event.received);
    if (!Number.isFinite(received) || received < 0) return;
    const total = Number(event.total);
    const hasTotal = Number.isFinite(total) && total > 0;
    const percent = hasTotal ? Math.min(100, Math.round((received / total) * 100)) : null;
    const previous = downloadProgress;
    if (previous && percent !== null) {
      if (percent === previous.percent) return;
      if (percent < 100 && percent - previous.percent < PROGRESS_MIN_PERCENT_DELTA) return;
    }
    downloadProgress = { received, total: hasTotal ? total : null, percent };
    detail = {
      ...(detail && typeof detail === 'object' ? detail : {}),
      progress: { received, total: hasTotal ? total : null, percent },
    };
    updatedAt = nowIso();
    const snap = snapshot();
    if (onUpdate) {
      try {
        onUpdate(snap);
      } catch {
        /* an observer must never break provisioning */
      }
    }
  }

  /** Nearest existing ancestor directory of `target` (it may not exist yet). */
  async function nearestExistingDirectory(target) {
    let current = target ? path.resolve(String(target)) : null;
    while (current) {
      try {
        const stats = await fsp.stat(current);
        if (stats.isDirectory()) return current;
      } catch {
        /* keep walking up */
      }
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
    return null;
  }

  /** Free bytes on the filesystem holding `target`, or null when unknown. */
  async function freeDiskBytes(target) {
    if (typeof statfs !== 'function') return null;
    const dir = await nearestExistingDirectory(target);
    if (!dir) return null;
    const stats = await statfs(dir);
    const blockSize = Number(stats && stats.bsize);
    const availableBlocks = Number(stats && stats.bavail);
    if (!Number.isFinite(blockSize) || blockSize <= 0) return null;
    if (!Number.isFinite(availableBlocks) || availableBlocks < 0) return null;
    return { path: dir, free: availableBlocks * blockSize };
  }

  /** Actionable "not enough free disk space" guard for the download steps. */
  async function checkDiskSpace(id) {
    const label = DISK_CHECK_STEPS[id];
    if (!label) return { ok: true };
    const target = id === 'jdk' ? jdkDirectory() : sdkRoot || null;
    let measured;
    try {
      measured = await freeDiskBytes(target);
    } catch {
      // Best effort: a filesystem that cannot report free space must not block setup.
      return { ok: true };
    }
    if (!measured || measured.free >= MIN_FREE_DISK_BYTES) return { ok: true };
    return {
      ok: false,
      error:
        `not enough free disk space for the ${label} download: ${measured.path} has ` +
        `${formatMegabytes(measured.free)} free, at least ${formatGigabytes(MIN_FREE_DISK_BYTES)} ` +
        'is required; free up disk space and retry',
    };
  }

  /**
   * Disk that will receive the queued plan: the configured SDK root, else the
   * parent of the AVD home, else the user's home directory. The last fallback
   * keeps the cumulative precheck active for a zero-config first run (the
   * managed JDK/SDK/AVD all live under the home directory by default).
   */
  function provisioningDiskTarget() {
    if (sdkRoot) return sdkRoot;
    if (env && typeof env.ANDROID_AVD_HOME === 'string' && env.ANDROID_AVD_HOME.trim()) {
      return path.dirname(path.resolve(env.ANDROID_AVD_HOME.trim()));
    }
    return home || os.homedir();
  }

  /**
   * Cumulative free-space precheck for the whole queued plan (best effort: a
   * filesystem that cannot report free space never blocks provisioning).
   * `minFreeDiskBytes` overrides the sum of the per-step estimates.
   */
  async function checkCumulativeDiskSpace(needed) {
    if (!Array.isArray(needed) || needed.length === 0) return { ok: true };
    const target = provisioningDiskTarget();
    if (!target) return { ok: true };
    const estimated = needed.reduce((total, id) => total + (STEP_DISK_ESTIMATES[id] || 0), 0);
    const required = minFreeDiskBytes !== null ? minFreeDiskBytes : estimated;
    if (!(required > 0)) return { ok: true };
    let measured;
    try {
      measured = await freeDiskBytes(target);
    } catch {
      return { ok: true };
    }
    if (!measured || measured.free >= required) return { ok: true };
    return {
      ok: false,
      error:
        `not enough free disk space to provision the Android VM environment: ${measured.path} has ` +
        `${formatMegabytes(measured.free)} free, but the ${needed.length} queued step(s) need about ` +
        `${formatMegabytes(required)}; free up disk space and retry`,
    };
  }

  /** Read an existing lock file; tolerate truncated content via mtime fallback. */
  async function readLockFile(lockPath) {
    let payload = null;
    try {
      payload = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
    } catch {
      /* truncated or non-JSON lock: fall back to the file mtime */
    }
    let mtimeMs = Number.NaN;
    try {
      mtimeMs = (await fsp.stat(lockPath)).mtimeMs;
    } catch {
      /* the holder may have removed the lock meanwhile */
    }
    let startedMs = Number.NaN;
    if (payload && typeof payload.startedAt === 'string') {
      startedMs = Date.parse(payload.startedAt);
    }
    const reference = Number.isFinite(startedMs) ? startedMs : mtimeMs;
    const ageMs = Number.isFinite(reference) ? Date.now() - reference : 0;
    return { payload, ageMs };
  }

  function describeLockHolder(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const pid = Number.isInteger(payload.pid) ? payload.pid : null;
    const started = typeof payload.startedAt === 'string' ? payload.startedAt : null;
    if (pid !== null && started) return ` by pid ${pid} since ${started}`;
    if (pid !== null) return ` by pid ${pid}`;
    return '';
  }

  /**
   * Create `<jdkRoot>/.lock` exclusively. A lock older than 30 minutes is
   * treated as abandoned, removed and retried once.
   */
  async function acquireJdkLock(retried = false) {
    const dir = jdkDirectory();
    if (!dir) {
      return {
        ok: false,
        error: 'could not determine the managed JDK directory for the provisioning lock',
      };
    }
    const lockPath = path.join(path.resolve(dir), LOCK_FILE_NAME);
    const payload = JSON.stringify({ pid: process.pid, startedAt: nowIso(), purpose: 'jdk-download' });
    let handle = null;
    try {
      await fsp.mkdir(path.dirname(lockPath), { recursive: true });
      handle = await fsp.open(lockPath, 'wx');
      await handle.writeFile(`${payload}\n`, 'utf8');
      return { ok: true, path: lockPath, handle };
    } catch (err) {
      const created = Boolean(handle);
      if (handle) await handle.close().catch(() => {});
      if (err && err.code === 'EEXIST') {
        const existing = await readLockFile(lockPath);
        if (existing.ageMs > LOCK_STALE_MS) {
          await fsp.rm(lockPath, { force: true }).catch(() => {});
          if (!retried) return acquireJdkLock(true);
        }
        return {
          ok: false,
          error:
            `another provisioning process is downloading the JDK (lock ${lockPath} is held` +
            `${describeLockHolder(existing.payload)}); wait for it to finish and retry ` +
            `(stale locks older than ${Math.round(LOCK_STALE_MS / 60000)} minutes are removed automatically)`,
        };
      }
      if (created) await fsp.rm(lockPath, { force: true }).catch(() => {});
      return {
        ok: false,
        error:
          `could not create the JDK provisioning lock at ${lockPath}: ` +
          limitText(err && err.message ? err.message : err, 200),
      };
    }
  }

  /** Release the JDK provisioning lock (safe to call on every outcome). */
  async function releaseJdkLock(lock) {
    if (!lock) return;
    if (lock.handle) await lock.handle.close().catch(() => {});
    await fsp.rm(lock.path, { force: true }).catch(() => {});
  }

  /** Options passed to each provisioning dependency (argv-style, no shell). */
  function stepOptions(id) {
    const api = apiLevelFromImage(systemImage);
    const java = jdkRoot ? { jdkRoot } : {};
    switch (id) {
      case 'jdk': {
        const dir = jdkDirectory();
        return {
          ...(dir ? { jdkRoot: dir } : {}),
          platform,
          ...(jdkMirror ? { jdkMirror } : {}),
          ...(jdkVersion !== undefined ? { jdkVersion } : {}),
          ...(home ? { home } : {}),
          ...(env ? { env } : {}),
          onProgress: reportJdkProgress,
        };
      }
      case 'bootstrap':
        return {
          ...java,
          ...sdkManagerOptions,
          ...(commandLineToolsUrl ? { commandLineToolsUrl } : {}),
          sdkRoot: sdkRoot || undefined,
          systemImage,
          platform,
          acceptLicenses: true,
        };
      case 'tools':
        return {
          ...java,
          ...sdkManagerOptions,
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
          ...sdkManagerOptions,
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

  /** Single-line error text for the retry status message. */
  function oneLine(value) {
    return limitText(String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim(), 160);
  }

  /**
   * Publish the retry notice, then wait for the exponential backoff delay in
   * small slices so an in-flight cancel is honored without a long sleep.
   * @returns {Promise<boolean>} false when cancellation was requested.
   */
  async function waitForRetry(id, attempt, errorText) {
    const delay = Math.min(MAX_RETRY_DELAY_MS, retryDelayMs * 2 ** (attempt - 1));
    const label = STEP_LABELS[id] || id;
    publish(
      `step ${step}/${totalSteps}: ${label} (retry ${attempt + 1}/${stepRetries} in ` +
        `${Math.round(delay / 1000)}s: ${oneLine(errorText)})`,
      { attempt: attempt + 1, maxAttempts: stepRetries, nextDelayMs: delay },
    );
    let waited = 0;
    while (waited < delay) {
      if (cancelRequested) return false;
      const slice = Math.min(250, delay - waited);
      await sleep(slice);
      waited += slice;
    }
    return !cancelRequested;
  }

  /**
   * Run one dependency with transient-failure retries; resolve
   * {ok,error,warnings} — never reject. The JDK provisioning lock is acquired
   * once and held across retry attempts (released in `finally`).
   */
  async function runStep(id) {
    let stepLock = null;
    let lastError = `${id} failed`;
    let attempts = 0;
    try {
      // Fail fast with an actionable message instead of a truncated download.
      const disk = await checkDiskSpace(id);
      if (!disk.ok) return disk;
      // Only one plugin process may download/extract the managed JDK at a time.
      if (id === 'jdk') {
        const lock = await acquireJdkLock();
        if (!lock.ok) return lock;
        stepLock = lock;
      }
      while (attempts < stepRetries) {
        if (cancelRequested) return { ok: false, error: lastError, cancelled: true };
        attempts += 1;
        let result;
        try {
          result = await deps[STEP_DEP_NAMES[id]](stepOptions(id));
        } catch (err) {
          result = { ok: false, error: `${id} failed: ${limitText(err && err.message ? err.message : err)}` };
        }
        if (result && typeof result === 'object' && result.ok === false) {
          lastError = limitText(result.error || `${id} returned ok:false`);
          if (cancelRequested) return { ok: false, error: lastError, cancelled: true };
          const canRetry = attempts < stepRetries && isTransientSetupError(lastError);
          if (!canRetry) {
            // Budget exhausted by a transient error: say so, so the operator
            // knows the retry policy already ran; permanent errors stay plain.
            const exhausted = attempts >= stepRetries && isTransientSetupError(lastError);
            const error = exhausted
              ? `${lastError} (still failing after ${attempts} attempt${attempts === 1 ? '' : 's'})`
              : lastError;
            return { ok: false, error, attempts };
          }
          const proceed = await waitForRetry(id, attempts, lastError);
          if (!proceed) return { ok: false, error: lastError, cancelled: true, attempts };
          continue;
        }
        const stepWarnings =
          result && typeof result === 'object' && Array.isArray(result.warnings) ? result.warnings : [];
        return { ok: true, warnings: stepWarnings, attempts };
      }
      return {
        ok: false,
        error: `${lastError} (still failing after ${attempts} attempt${attempts === 1 ? '' : 's'})`,
        attempts,
      };
    } finally {
      if (stepLock) await releaseJdkLock(stepLock);
    }
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
    downloadProgress = null;
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
      // Best-effort combined disk precheck so a big plan fails before any
      // partial download starts (per-step checks below still run).
      const cumulativeDisk = await checkCumulativeDiskSpace(needed);
      if (!cumulativeDisk.ok) return finishFailed(cumulativeDisk.error);

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
   * interrupted; a retry backoff wait is interruptible. The state becomes
   * 'cancelled' once the current step returns or the backoff is interrupted.
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
