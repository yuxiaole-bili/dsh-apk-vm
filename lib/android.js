/**
 * lib/android.js — dependency-free Android device backend for the APK VM preview panel.
 *
 * Scope
 * -----
 * Drives *any* adb-reachable open-source Android runtime (QEMU/Android-x86 VM reached
 * through `adb connect host:port`, a locally spawned AOSP emulator, or a USB device)
 * using only Node.js built-in modules. Exposes VM lifecycle state, APK discovery /
 * inspection / install / launch, PNG screenshots and input injection.
 *
 * Device selection is ATTACH-FIRST:
 *   - if `options.serial` is set, that serial is authoritative (network serials such
 *     as `127.0.0.1:5555` are brought up with `adb connect` on start());
 *   - otherwise the first device reported by `adb devices` in state `device` is used;
 *   - an AOSP emulator is spawned ONLY when `options.emulatorPath` AND `options.avdName`
 *     are explicitly configured, no device exists, and `options.spawnEmulator !== false`.
 *
 * No shell is ever used on the host: every external program is launched with
 * child_process.spawn(exe, argvArray). The only string command is the *remote* command
 * passed as one argv element to `adb shell`, and its arguments are strictly validated.
 *
 * Export contract (binding):
 *   export class AndroidVm {
 *     constructor(options = {})            // see DEFAULT_OPTIONS below
 *     async status()                       // { state, serial, avd, bootMs, error, logTail }
 *     async start()                        // idempotent, never throws for expected boot failures
 *     async stop()
 *     async screenSize()                   // { width, height }
 *     async screenshot()                   // Buffer (PNG)
 *     async listApks(roots = [])           // [{ path, name, size, mtime }]
 *     async inspectApk(path)               // { packageName, label, launchActivity }
 *     async installApk(path)               // { packageName, label, launchActivity }
 *     async launchPackage(packageName, launchActivity)
 *     async input(payload)                 // { ok: true }
 *     async dispose()
 *     // additions requested by the VM runtime pivot:
 *     async connect(serial)                // adb connect + wait online; returns status snapshot
 *     async waitBooted(timeoutMs)          // wait for sys.boot_completed=1; returns status snapshot
 *   }
 *
 * States: 'stopped' | 'starting' | 'booting' | 'ready' | 'error'
 *
 * Timing note: software-emulated Android (TCG) is very slow; every externally visible
 * operation is bounded by a timeout and the event loop is never blocked.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

/** Default tuning; every value can be overridden via constructor options. */
export const DEFAULT_OPTIONS = Object.freeze({
  // adb / SDK discovery
  sdkRoot: null, // e.g. 'D:\\Android\\sdk'; otherwise ANDROID_HOME / ANDROID_SDK_ROOT / known path
  adbPath: null, // explicit adb executable
  aapt2Path: null, // explicit aapt2 executable
  emulatorPath: null, // explicit emulator executable — required to enable spawning
  avdName: null, // AVD name — required to enable spawning
  spawnEmulator: true, // spawn only when emulatorPath+avdName are configured
  emulatorArgs: [], // extra argv appended to the emulator command line

  // device selection
  serial: null, // authoritative adb serial (e.g. '127.0.0.1:5555', 'emulator-5558')
  port: 5558, // console port used only when spawning the AOSP emulator

  // boot speed / acceleration
  gpuMode: 'host', // 'host' uses the host GPU; 'swiftshader_indirect' is the software fallback
  accel: 'auto', // 'auto' detects AEHD/WHPX/KVM/HAXM; 'on' forces it; 'off' forces TCG
  requireAccel: true, // fail fast instead of hanging forever when x86_64 has no hypervisor
  accelCheckTimeoutMs: 15 * 1000,
  quickBoot: true, // load the saved AVD snapshot when present
  snapshotName: 'default_boot',
  saveSnapshotAfterBoot: true, // save a cold-boot snapshot so the next start is a quick boot

  // timing (ms)
  bootTimeoutMs: 20 * 60 * 1000,
  connectTimeoutMs: 45 * 1000,
  pollIntervalMs: 2000,
  commandTimeoutMs: 20 * 1000,
  launchTimeoutMs: 60 * 1000,
  installTimeoutMs: 5 * 60 * 1000,
  screenshotTimeoutMs: 120 * 1000,
  apkDumpTimeoutMs: 60 * 1000,
  shutdownTimeoutMs: 20 * 1000,
  bootProbeCacheMs: 1000,

  // bounds
  maxLogLines: 200,
  maxOutputBytes: 8 * 1024 * 1024,
  screenshotMaxBytes: 48 * 1024 * 1024,
  maxApkDepth: 6,
  maxApkResults: 500,
  apkRoots: [], // default roots for listApks(); empty => [process.cwd()]

  log: null, // optional (line: string) => void sink in addition to the bounded logTail
});

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '$RECYCLE.BIN',
  'System Volume Information',
]);

const NETWORK_SERIAL_RE = /^[A-Za-z0-9._\-]+:\d{1,5}$/;
const SERIAL_RE = /^[A-Za-z0-9._\-:]+$/;
const PACKAGE_RE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/;
const COMPONENT_RE = /^[A-Za-z0-9_.]+$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Friendly key names used by UI/HTTP callers -> Android keycodes. */
const KEYCODE_ALIASES = Object.freeze({
  recents: 'APP_SWITCH',
  recent: 'APP_SWITCH',
  appswitch: 'APP_SWITCH',
  app_switch: 'APP_SWITCH',
  menu: 'MENU',
  backspace: 'DEL',
  delete: 'DEL',
  del: 'DEL',
  return: 'ENTER',
  escape: 'ESCAPE',
  volumeup: 'VOLUME_UP',
  volumedown: 'VOLUME_DOWN',
  mute: 'VOLUME_MUTE',
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function asPositiveInt(value, fallback) {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number === 'number' && Number.isFinite(number) && number > 0) return Math.floor(number);
  return fallback;
}

function isNetworkSerial(serial) {
  return typeof serial === 'string' && NETWORK_SERIAL_RE.test(serial);
}

function isPng(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length > PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

function splitLines(text) {
  return String(text).split(/\r?\n/);
}

/** Compare two Android build-tools version directory names, newest first. */
function compareVersionsDesc(a, b) {
  const parse = (value) => {
    const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(value));
    return m ? [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)] : [0, 0, 0];
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return right[index] - left[index];
  }
  return String(b).localeCompare(String(a));
}

/** Candidate Android SDK roots, most explicit first. */
function candidateSdkRoots(explicitRoot) {
  const roots = [];
  if (explicitRoot) roots.push(String(explicitRoot));
  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const value = process.env[key];
    if (value && value.trim()) roots.push(value.trim());
  }
  const home = os.homedir();
  if (process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
  }
  // Linux / macOS / generic per-user installs.
  roots.push(path.join(home, 'Android', 'Sdk'));
  roots.push(path.join(home, 'Library', 'Android', 'sdk'));
  if (process.env.USERPROFILE) {
    roots.push(path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Android', 'Sdk'));
  }
  // Common system-wide installs.
  roots.push('/usr/lib/android-sdk');
  roots.push('/opt/android-sdk');
  roots.push('/opt/android/sdk');
  // Verified location on this host; still validated with existsSync before use.
  if (process.platform === 'win32') roots.push(path.join('D:\\', 'Android', 'sdk'));
  const unique = [];
  for (const root of roots) {
    const normalized = path.resolve(root);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (!unique.some((existing) => (process.platform === 'win32' ? existing.toLowerCase() === key : existing === key))) {
      unique.push(normalized);
    }
  }
  return unique;
}

function resolveAdbPath({ explicitPath, sdkRoot }) {
  if (explicitPath) return String(explicitPath);
  for (const root of candidateSdkRoots(sdkRoot)) {
    const candidate = path.join(root, 'platform-tools', `adb${EXE}`);
    if (existsSync(candidate)) return candidate;
  }
  return `adb${EXE}`; // last resort: rely on PATH; errors surface via spawn ENOENT
}

/** Resolve the emulator executable from an explicit path, SDK root or PATH. */
function resolveEmulatorPath({ explicitPath, sdkRoot }) {
  if (explicitPath) return String(explicitPath);
  for (const root of candidateSdkRoots(sdkRoot)) {
    const candidate = path.join(root, 'emulator', `emulator${EXE}`);
    if (existsSync(candidate)) return candidate;
  }
  // Last resort: rely on PATH.
  try {
    const pathValue = process.env.PATH || '';
    const entries = pathValue.split(path.delimiter).filter(Boolean);
    for (const entry of entries) {
      const candidate = path.join(entry, `emulator${EXE}`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Single-quote a string for the *remote* Android shell (mksh/toybox sh). */
function quoteForDeviceShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * `adb shell input text` needs spaces encoded as %s and a single device-shell token.
 * Newlines/tabs collapse to spaces (the input command cannot type them reliably).
 */
function encodeInputText(rawText) {
  const flattened = String(rawText)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f]/g, '');
  return quoteForDeviceShell(flattened.replace(/ /g, '%s'));
}

function parseCoordinate(value, field, { min = 0, max = 100000 } = {}) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    throw new Error(`input() requires a finite numeric "${field}" (received ${JSON.stringify(value)})`);
  }
  const rounded = Math.round(number);
  if (rounded < min || rounded > max) {
    throw new Error(`input() "${field}" must be between ${min} and ${max} (received ${number})`);
  }
  return rounded;
}

function normalizeKeycode(value) {
  if (value === undefined || value === null || value === '') {
    throw new Error('input({ type: "key" }) requires "key" or "keycode"');
  }
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const code = Number(text);
    if (!Number.isSafeInteger(code) || code < 0 || code > 100000) {
      throw new Error(`input() keycode out of range: ${text}`);
    }
    return String(code);
  }
  const upper = text.toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(upper)) {
    throw new Error(`input() invalid key: ${JSON.stringify(value)}`);
  }
  const alias = KEYCODE_ALIASES[text.toLowerCase().replace(/[-_\s]/g, '')];
  if (alias) return `KEYCODE_${alias}`;
  return upper.startsWith('KEYCODE_') ? upper : `KEYCODE_${upper}`;
}

/** Minimal ZIP entry reader for extracting an APK icon without extra deps. */
function readZipEntry(buffer, entryName) {
  const wanted = String(entryName || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!wanted) throw new Error('empty ZIP entry name');
  let eocd = -1;
  const min = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP/APK: end-of-central-directory not found');
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt ZIP central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength).replace(/\\/g, '/');
    if (name === wanted) {
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('corrupt ZIP local header');
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported ZIP compression method ${method}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP entry not found: ${wanted}`);
}

/** Parse `aapt2 dump badging` output. Exported shape is the module's public one. */
function parseBadging(text) {
  let packageName = null;
  let versionName = null;
  let versionCode = null;
  let sdkVersion = null;
  let targetSdkVersion = null;
  let applicationLabel = null;
  let launchActivity = null;
  let launchableLabel = null;
  let iconPath = null;
  let iconDensity = -1;
  const permissions = [];
  const features = [];
  const nativeCode = [];

  for (const rawLine of splitLines(text)) {
    const line = rawLine.trim();
    if (!packageName && line.startsWith('package:')) {
      const match = /^package:\s+name='([^']*)'/.exec(line);
      if (match) packageName = match[1];
      const versionCodeMatch = /\bversionCode='([^']*)'/.exec(line);
      const versionNameMatch = /\bversionName='([^']*)'/.exec(line);
      if (versionCodeMatch) versionCode = versionCodeMatch[1];
      if (versionNameMatch) versionName = versionNameMatch[1];
      continue;
    }
    if (line.startsWith('sdkVersion:')) {
      const match = /sdkVersion:'([^']*)'/.exec(line);
      if (match) sdkVersion = Number(match[1]);
      continue;
    }
    if (line.startsWith('targetSdkVersion:')) {
      const match = /targetSdkVersion:'([^']*)'/.exec(line);
      if (match) targetSdkVersion = Number(match[1]);
      continue;
    }
    if (line.startsWith('uses-permission:')) {
      const match = /name='((?:[^'\\]|\\.)*)'/.exec(line);
      if (match) permissions.push(unescapeAapt(match[1]));
      continue;
    }
    if (line.startsWith('uses-feature:')) {
      const match = /name='((?:[^'\\]|\\.)*)'/.exec(line);
      if (match) features.push(unescapeAapt(match[1]));
      continue;
    }
    if (line.startsWith('native-code:')) {
      const matches = line.match(/'([^']*)'/g) || [];
      for (const quoted of matches) nativeCode.push(quoted.slice(1, -1));
      continue;
    }
    if (line.startsWith('application:')) {
      if (!applicationLabel) {
        const match = /^application:.*?\blabel='((?:[^'\\]|\\.)*)'/.exec(line);
        if (match) applicationLabel = unescapeAapt(match[1]);
      }
      const iconMatch = /^application:.*?\bicon='((?:[^'\\]|\\.)*)'/.exec(line);
      if (iconMatch && !iconPath) iconPath = unescapeAapt(iconMatch[1]);
      continue;
    }
    if (line.startsWith('application-label:')) {
      if (!applicationLabel) {
        const match = /^application-label:'((?:[^'\\]|\\.)*)'/.exec(line);
        if (match) applicationLabel = unescapeAapt(match[1]);
      }
      continue;
    }
    if (line.startsWith('application-icon-')) {
      const match = /^application-icon-(\d+):'((?:[^'\\]|\\.)*)'/.exec(line);
      if (match) {
        const density = Number(match[1]);
        if (density > iconDensity) {
          iconDensity = density;
          iconPath = unescapeAapt(match[2]);
        }
      }
      continue;
    }
    if (!launchActivity && line.startsWith('launchable-activity:')) {
      const nameMatch = /name='((?:[^'\\]|\\.)*)'/.exec(line);
      const labelMatch = /label='((?:[^'\\]|\\.)*)'/.exec(line);
      if (nameMatch) launchActivity = unescapeAapt(nameMatch[1]);
      if (labelMatch) launchableLabel = unescapeAapt(labelMatch[1]);
    }
  }

  if (!packageName) {
    throw new Error('aapt2 badging output has no package: line (not a valid APK?)');
  }
  return {
    packageName,
    label: applicationLabel || launchableLabel || packageName,
    launchActivity: launchActivity || null,
    versionName: versionName || null,
    versionCode: versionCode || null,
    sdkVersion,
    targetSdkVersion,
    permissions: [...new Set(permissions)],
    features: [...new Set(features)],
    nativeCode: [...new Set(nativeCode)],
    iconPath: iconPath || null,
  };
}

function unescapeAapt(value) {
  return String(value).replace(/\\(['"\\])/g, '$1');
}

function parseWmSize(text) {
  const override = /Override size:\s*(\d+)\s*x\s*(\d+)/i.exec(text);
  const physical = /Physical size:\s*(\d+)\s*x\s*(\d+)/i.exec(text);
  const match = override || physical;
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

export class AndroidVm {
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    this.options = opts;

    this.sdkRoot = opts.sdkRoot ? String(opts.sdkRoot) : null;
    this.adbPath = resolveAdbPath({ explicitPath: opts.adbPath, sdkRoot: this.sdkRoot });
    this.emulatorPath = opts.emulatorPath
      ? String(opts.emulatorPath)
      : resolveEmulatorPath({ sdkRoot: this.sdkRoot });
    this.avdName = opts.avdName ? String(opts.avdName) : null;
    this.emulatorArgs = Array.isArray(opts.emulatorArgs) ? opts.emulatorArgs.map(String) : [];
    this.spawnEmulatorEnabled = opts.spawnEmulator !== false;

    this.serial = opts.serial ? String(opts.serial) : null;
    this.port = asPositiveInt(opts.port, DEFAULT_OPTIONS.port);
    this._external = false;
    this._externalSerial = null;
    this._managedAvdName = this.avdName;
    this._managedSerial = this.serial;
    this._managedPort = this.port;

    // Boot-speed knobs: host GPU, detected hypervisor, quick-boot snapshots.
    this.gpuMode =
      typeof opts.gpuMode === 'string' && opts.gpuMode.trim()
        ? opts.gpuMode.trim()
        : DEFAULT_OPTIONS.gpuMode;
    this.accel = opts.accel === 'on' || opts.accel === 'off' ? opts.accel : 'auto';
    this.requireAccel = opts.requireAccel !== false;
    this.accelCheckTimeoutMs = asPositiveInt(opts.accelCheckTimeoutMs, DEFAULT_OPTIONS.accelCheckTimeoutMs);
    this.quickBoot = opts.quickBoot !== false;
    this.snapshotName = opts.snapshotName ? String(opts.snapshotName) : DEFAULT_OPTIONS.snapshotName;
    this.saveSnapshotAfterBoot = opts.saveSnapshotAfterBoot !== false;

    this.bootTimeoutMs = asPositiveInt(opts.bootTimeoutMs, DEFAULT_OPTIONS.bootTimeoutMs);
    this.connectTimeoutMs = asPositiveInt(opts.connectTimeoutMs, DEFAULT_OPTIONS.connectTimeoutMs);
    this.pollIntervalMs = asPositiveInt(opts.pollIntervalMs, DEFAULT_OPTIONS.pollIntervalMs);
    this.commandTimeoutMs = asPositiveInt(opts.commandTimeoutMs, DEFAULT_OPTIONS.commandTimeoutMs);
    this.launchTimeoutMs = asPositiveInt(opts.launchTimeoutMs, DEFAULT_OPTIONS.launchTimeoutMs);
    this.installTimeoutMs = asPositiveInt(opts.installTimeoutMs, DEFAULT_OPTIONS.installTimeoutMs);
    this.screenshotTimeoutMs = asPositiveInt(opts.screenshotTimeoutMs, DEFAULT_OPTIONS.screenshotTimeoutMs);
    this.apkDumpTimeoutMs = asPositiveInt(opts.apkDumpTimeoutMs, DEFAULT_OPTIONS.apkDumpTimeoutMs);
    this.shutdownTimeoutMs = asPositiveInt(opts.shutdownTimeoutMs, DEFAULT_OPTIONS.shutdownTimeoutMs);
    this.bootProbeCacheMs = asPositiveInt(opts.bootProbeCacheMs, DEFAULT_OPTIONS.bootProbeCacheMs);

    this.maxLogLines = asPositiveInt(opts.maxLogLines, DEFAULT_OPTIONS.maxLogLines);
    this.maxOutputBytes = asPositiveInt(opts.maxOutputBytes, DEFAULT_OPTIONS.maxOutputBytes);
    this.screenshotMaxBytes = asPositiveInt(opts.screenshotMaxBytes, DEFAULT_OPTIONS.screenshotMaxBytes);
    this.maxApkDepth = asPositiveInt(opts.maxApkDepth, DEFAULT_OPTIONS.maxApkDepth);
    this.maxApkResults = asPositiveInt(opts.maxApkResults, DEFAULT_OPTIONS.maxApkResults);
    this.apkRoots = Array.isArray(opts.apkRoots) ? opts.apkRoots.map(String) : [];
    this.logSink = typeof opts.log === 'function' ? opts.log : null;

    // Runtime state.
    this._state = 'stopped';
    this._error = null;
    this._bootMs = null;
    this._serialActive = null;
    this._child = null; // spawned emulator process, if any
    this._spawnedByUs = false;
    this._bootStartAt = null;
    this._sawNotBooted = false;
    this._bootProbe = { serial: null, at: 0, booted: false };
    this._bootProbeInFlight = null;
    this._screenshotInFlight = null;
    this._devicesCache = { at: 0, devices: new Map() };
    this._lastProbeError = null;
    this._logTail = [];
    this._aapt2Resolved = undefined;
    this._starting = null;
    this._bootWait = null;
    this._waitEpoch = 0;
    this._disposed = false;
    this._disposing = null;

    // Boot-speed bookkeeping (exposed by status()).
    this._bootKind = null; // 'cold' | 'snapshot' | 'attach'
    this._snapshotAvailable = null;
    this._accelAvailable = null;
    this._snapshotSave = null;
    this._snapshotLoadFailed = false;
    this._lastLaunchArgs = null;

    // Rooted / debuggable guest state (exposed by status()).
    this._root = false;
    this._debugPrepared = false;
    this._debugToolkitPath = null;
    this._identity = null;
    this._preparePromise = null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Current VM snapshot. Refreshes device/boot state from adb when possible. */
  async status() {
    if (this._disposed) return this._snapshot();
    try {
      await this._refresh();
    } catch (error) {
      this._lastProbeError = error && error.message ? error.message : String(error);
      this._setState('error', `status() probe failed: ${this._lastProbeError}`);
    }
    return this._snapshot();
  }

  /**
   * Idempotent bring-up: attach to a live device, `adb connect` a configured network
   * serial, or (only when explicitly configured) spawn the AOSP emulator, then wait
   * for Android to finish booting. Expected failures are stored in status().error and
   * never thrown.
   */
  async start() {
    if (this._disposed) throw new Error('AndroidVm has been disposed');
    // Serialize with a start that a stop() may have interrupted: the stale run aborts
    // via _waitEpoch, then this call performs a clean attach/boot.
    while (this._starting) {
      await this._starting.catch(() => {});
    }
    const epoch = this._waitEpoch;
    this._starting = this._startInner(epoch)
      .catch((error) => {
        const message = error && error.message ? error.message : String(error);
        if (epoch === this._waitEpoch) this._setState('error', `start() failed: ${message}`);
      })
      .finally(() => {
        this._starting = null;
      });
    return this._starting;
  }

  /** Stop the attached VM: graceful emulator shutdown when possible, then adb detach. */
  async stop() {
    this._waitEpoch += 1; // abort an in-flight boot wait
    this._bootWait = null; // let a subsequent start() begin a fresh wait
    this._pushLog('[vm] stop requested');
    if (this._external) {
      // Never kill or disconnect a user's physical/remote device; just detach.
      this._serialActive = null;
      this._setState('stopped');
      this._pushLog(`[vm] detached external device ${this._externalSerial || ''}`.trim());
      return this._snapshot();
    }
    const serial = this._serialActive || this.serial;
    const child = this._child;

    if (serial) {
      try {
        const result = await this._adb(['-s', serial, 'emu', 'kill'], { timeoutMs: 10000 });
        if (result && result.code === 0) this._pushLog(`[vm] sent emulator kill to ${serial}`);
      } catch {
        /* not an emulator console device — ignore */
      }

      const deadline = Date.now() + this.shutdownTimeoutMs;
      let stillConnected = true;
      while (Date.now() < deadline) {
        const devices = await this._listDevices({ timeoutMs: 5000 });
        stillConnected = devices.has(serial);
        if (!stillConnected) break;
        if (isNetworkSerial(serial)) {
          await this._adb(['disconnect', serial], { timeoutMs: 10000 }).catch(() => {});
        }
        await sleep(500);
      }
      if (stillConnected && isNetworkSerial(serial)) {
        await this._adb(['disconnect', serial], { timeoutMs: 10000 }).catch(() => {});
      }
    }

    if (child && child.exitCode === null) {
      killProcessTree(child);
      const exited = await waitForChildExit(child, 5000);
      if (!exited && child.exitCode === null) killProcessTree(child);
    }

    this._child = null;
    this._spawnedByUs = false;
    this._serialActive = null;
    this._bootMs = null;
    this._bootKind = null;
    this._bootStartAt = null;
    this._sawNotBooted = false;
    this._bootProbe = { serial: null, at: 0, booted: false };
    this._root = false;
    this._debugPrepared = false;
    this._debugToolkitPath = null;
    this._identity = null;
    this._devicesCache = { at: 0, devices: new Map() };
    this._lastProbeError = null;
    this._setState('stopped');
    this._pushLog('[vm] stopped');
    return this._snapshot();
  }

  /** Device display size from `adb shell wm size` (override size preferred). */
  async screenSize() {
    const serial = await this._requireSerial();
    const output = await this._adbText(['-s', serial, 'shell', 'wm', 'size'], {
      timeoutMs: this.commandTimeoutMs,
    });
    const size = parseWmSize(output);
    if (!size) {
      throw new Error(`could not parse screen size from "wm size": ${output.trim().slice(0, 300)}`);
    }
    return size;
  }

  /** PNG screenshot as a Buffer (primary: `adb exec-out screencap -p`; file/pull fallback). */
  async screenshot() {
    // Coalesce concurrent requests (the panel may poll faster than screencap on TCG).
    if (this._screenshotInFlight) return this._screenshotInFlight;
    this._screenshotInFlight = this._screenshotInner().finally(() => {
      this._screenshotInFlight = null;
    });
    return this._screenshotInFlight;
  }

  async _screenshotInner() {
    const serial = await this._requireSerial();
    const startedAt = Date.now();

    try {
      const result = await this._adb(['-s', serial, 'exec-out', 'screencap', '-p'], {
        timeoutMs: this.screenshotTimeoutMs,
        maxBytes: this.screenshotMaxBytes,
      });
      if (!result.timedOut && result.code === 0 && isPng(result.stdout)) {
        this._pushLog(
          `[vm] screenshot ${result.stdout.length} bytes in ${Date.now() - startedAt}ms (exec-out, ${serial})`,
        );
        return result.stdout;
      }
      this._pushLog(
        `[vm] exec-out screencap unusable (code=${result.code}${result.timedOut ? ', timeout' : ''}, ` +
          `${result.stdout.length} bytes, png=${isPng(result.stdout)}); falling back to file+pull`,
      );
    } catch (error) {
      this._pushLog(`[vm] exec-out screencap failed (${error.message}); falling back to file+pull`);
    }

    const remotePath = `/data/local/tmp/dsh-screencap-${Date.now()}.png`;
    const localPath = path.join(
      os.tmpdir(),
      `dsh-screencap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
    );
    try {
      await this._adbText(['-s', serial, 'shell', 'screencap', '-p', remotePath], {
        timeoutMs: this.screenshotTimeoutMs,
      });
      const pull = await this._adb(['-s', serial, 'pull', remotePath, localPath], {
        timeoutMs: this.screenshotTimeoutMs,
      });
      if (pull.timedOut || pull.code !== 0) {
        const detail = pull.timedOut
          ? `timed out after ${this.screenshotTimeoutMs}ms`
          : `exit ${pull.code}: ${(pull.stderr || '').trim().slice(0, 300)}`;
        throw new Error(`adb pull failed (${detail})`);
      }
      const buffer = await fsp.readFile(localPath);
      if (!isPng(buffer)) {
        throw new Error(`pulled screencap is not a PNG (${buffer.length} bytes)`);
      }
      this._pushLog(
        `[vm] screenshot ${buffer.length} bytes in ${Date.now() - startedAt}ms (file+pull, ${serial})`,
      );
      return buffer;
    } catch (error) {
      throw new Error(`screenshot failed on ${serial}: ${error.message}`);
    } finally {
      await fsp.rm(localPath, { force: true }).catch(() => {});
      this._adb(['-s', serial, 'shell', 'rm', '-f', remotePath], { timeoutMs: 10000 }).catch(() => {});
    }
  }

  /**
   * Recursively find *.apk files. Depth-bounded, skips node_modules/.git and junk
   * VCS/OS directories, returns newest first: [{ path, name, size, mtime(ISO) }].
   */
  async listApks(roots = []) {
    const requested =
      Array.isArray(roots) && roots.length > 0
        ? roots
        : this.apkRoots.length > 0
          ? this.apkRoots
          : [process.cwd()];

    const results = [];
    const seen = new Set();
    const stack = [];
    for (const root of requested) {
      if (typeof root !== 'string' || root.trim() === '') continue;
      const absolute = path.resolve(root);
      stack.push({ dir: absolute, depth: 0 });
    }

    while (stack.length > 0 && results.length < this.maxApkResults) {
      const { dir, depth } = stack.pop();
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable / vanished directory
      }
      for (const entry of entries) {
        if (results.length >= this.maxApkResults) break;
        const name = entry.name;
        if (entry.isSymbolicLink()) continue; // avoid cycles / outside-tree links
        const fullPath = path.join(dir, name);
        if (entry.isDirectory()) {
          if (SKIP_DIR_NAMES.has(name) || /^\$/.test(name)) continue;
          if (depth + 1 <= this.maxApkDepth) stack.push({ dir: fullPath, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile() || !/\.apk$/i.test(name)) continue;
        const key = IS_WIN ? fullPath.toLowerCase() : fullPath;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const stat = await fsp.stat(fullPath);
          results.push({
            path: fullPath,
            name,
            size: stat.size,
            mtime: new Date(stat.mtimeMs).toISOString(),
          });
        } catch {
          /* file vanished mid-scan */
        }
      }
    }

    results.sort(
      (left, right) =>
        right.mtime.localeCompare(left.mtime) || left.name.localeCompare(right.name),
    );
    return results;
  }

  /** Read packageName / label / launchActivity from an APK with aapt2 `dump badging`. */
  async inspectApk(apkPath) {
    const file = await this._assertApkFile(apkPath);
    const aapt2 = await this._findAapt2();
    if (!aapt2) {
      throw new Error(
        'aapt2 not found: set options.aapt2Path or install Android SDK build-tools ' +
          '(searched ANDROID_HOME/ANDROID_SDK_ROOT/build-tools/*/aapt2)',
      );
    }
    const result = await this._run(aapt2, ['dump', 'badging', file], {
      timeoutMs: this.apkDumpTimeoutMs,
      maxBytes: 4 * 1024 * 1024,
    });
    if (result.timedOut) {
      throw new Error(`aapt2 dump badging timed out after ${this.apkDumpTimeoutMs}ms for ${file}`);
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout.toString('utf8')).trim().slice(0, 400);
      throw new Error(`aapt2 dump badging failed (exit ${result.code}): ${detail}`);
    }
    return parseBadging(result.stdout.toString('utf8'));
  }

  /** Extract the launcher icon (PNG/WebP/JPEG) referenced by an APK's badging. */
  async inspectApkIcon(apkPath) {
    const file = await this._assertApkFile(apkPath);
    const metadata = await this.inspectApk(file);
    if (!metadata.iconPath) throw new Error('APK has no launcher icon');
    const archive = await fsp.readFile(file);
    const icon = readZipEntry(archive, metadata.iconPath);
    const lower = metadata.iconPath.toLowerCase();
    const mime = lower.endsWith('.webp')
      ? 'image/webp'
      : lower.endsWith('.jpg') || lower.endsWith('.jpeg')
        ? 'image/jpeg'
        : lower.endsWith('.xml')
          ? 'application/xml'
          : 'image/png';
    return { data: icon, mime, entry: metadata.iconPath, packageName: metadata.packageName };
  }

  /**
   * Install an APK with `adb install -r` (retries with -t for test-only packages),
   * then resolve its metadata and best-effort launch it so the panel shows the app.
   * Returns { packageName, label, launchActivity }.
   */
  async installApk(apkPath) {
    const file = await this._assertApkFile(apkPath);
    const serial = await this._requireSerial();
    const stat = await fsp.stat(file);
    const metadata = await this.inspectApk(file);

    this._pushLog(
      `[vm] installing ${path.basename(file)} (${stat.size} bytes) on ${serial} ` +
        `[${metadata.packageName}]`,
    );
    const startedAt = Date.now();
    let result = await this._adb(['-s', serial, 'install', '-r', file], {
      timeoutMs: this.installTimeoutMs,
      maxBytes: 8 * 1024 * 1024,
    });
    let output = `${result.stdout.toString('utf8')}\n${result.stderr}`;
    if (/INSTALL_FAILED_TEST_ONLY/i.test(output)) {
      this._pushLog('[vm] package is test-only; retrying with adb install -r -t');
      result = await this._adb(['-s', serial, 'install', '-r', '-t', file], {
        timeoutMs: this.installTimeoutMs,
        maxBytes: 8 * 1024 * 1024,
      });
      output = `${result.stdout.toString('utf8')}\n${result.stderr}`;
    }

    if (result.timedOut) {
      throw new Error(`adb install timed out after ${this.installTimeoutMs}ms`);
    }
    const failure = /Failure\s*\[([^\]]+)\]\s*:?\s*([^\r\n]*)/i.exec(output);
    if (failure) {
      throw new Error(
        `adb install failed: ${failure[1]}${failure[2] && failure[2].trim() ? `: ${failure[2].trim()}` : ''}`,
      );
    }
    if (result.code !== 0 || !/Success/i.test(output)) {
      throw new Error(
        `adb install did not report success (exit ${result.code}): ${output.trim().slice(0, 400)}`,
      );
    }
    this._pushLog(`[vm] installed ${metadata.packageName} in ${Date.now() - startedAt}ms`);

    if (metadata.launchActivity) {
      try {
        await this.launchPackage(metadata.packageName, metadata.launchActivity);
        this._pushLog(`[vm] launched ${metadata.packageName}/${metadata.launchActivity}`);
      } catch (error) {
        this._pushLog(`[vm] install succeeded but launch failed: ${error.message}`);
      }
    } else {
      this._pushLog(`[vm] ${metadata.packageName} exposes no launchable activity; not launched`);
    }
    return metadata;
  }

  /** Launch a package/activity via `adb shell am start -n` (monkey fallback without activity). */
  async launchPackage(packageName, launchActivity) {
    const pkg = String(packageName || '').trim();
    if (!PACKAGE_RE.test(pkg)) {
      throw new Error(`invalid package name: ${JSON.stringify(packageName)}`);
    }
    const serial = await this._requireSerial();

    let command;
    if (launchActivity) {
      let activity = String(launchActivity).trim();
      if (!COMPONENT_RE.test(activity)) {
        throw new Error(`invalid activity name: ${JSON.stringify(launchActivity)}`);
      }
      if (activity.startsWith('.')) activity = pkg + activity;
      else if (!activity.includes('.')) activity = `${pkg}.${activity}`;
      command = `am start -n ${pkg}/${activity}`;
    } else {
      command = `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`;
    }

    const result = await this._adb(['-s', serial, 'shell', command], {
      timeoutMs: this.launchTimeoutMs,
      maxBytes: 512 * 1024,
    });
    const output = `${result.stdout.toString('utf8')}\n${result.stderr}`.trim();
    if (result.timedOut) {
      throw new Error(`"${command}" timed out after ${this.launchTimeoutMs}ms`);
    }
    if (
      result.code !== 0 ||
      /Error:|Exception|does not exist|No activities found|not found/i.test(output)
    ) {
      throw new Error(`launch failed (${command}): ${output.slice(0, 500)}`);
    }
    return { ok: true };
  }

  /**
   * Inject input: { type: 'tap', x, y } | { type: 'swipe', x1, y1, x2, y2, durationMs? }
   * | { type: 'key', key } | { type: 'text', text }. Resolves { ok: true }.
   */
  async input(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('input(payload) requires an object payload');
    }
    const type = String(payload.type || payload.action || payload.kind || '').toLowerCase();

    let command;
    if (type === 'tap') {
      const x = parseCoordinate(payload.x, 'x');
      const y = parseCoordinate(payload.y, 'y');
      command = `input tap ${x} ${y}`;
    } else if (type === 'swipe') {
      const x1 = parseCoordinate(payload.x1, 'x1');
      const y1 = parseCoordinate(payload.y1, 'y1');
      const x2 = parseCoordinate(payload.x2, 'x2');
      const y2 = parseCoordinate(payload.y2, 'y2');
      const duration = parseCoordinate(
        payload.durationMs !== undefined ? payload.durationMs : payload.duration !== undefined ? payload.duration : 300,
        'durationMs',
        { min: 1, max: 60000 },
      );
      command = `input swipe ${x1} ${y1} ${x2} ${y2} ${duration}`;
    } else if (type === 'key' || type === 'keyevent') {
      const keycode = normalizeKeycode(
        payload.key !== undefined ? payload.key : payload.keycode !== undefined ? payload.keycode : payload.code,
      );
      command = `input keyevent ${keycode}`;
    } else if (type === 'text') {
      const rawText = payload.text !== undefined ? payload.text : payload.value;
      if (typeof rawText !== 'string' || rawText.length === 0) {
        throw new Error('input({ type: "text" }) requires a non-empty string "text"');
      }
      if (rawText.length > 4096) {
        throw new Error('input({ type: "text" }) text is limited to 4096 characters');
      }
      command = `input text ${encodeInputText(rawText)}`;
    } else {
      throw new Error(
        `unsupported input type ${JSON.stringify(type || '(missing)')}; expected tap|swipe|key|text`,
      );
    }

    const serial = await this._requireSerial();
    const result = await this._adb(['-s', serial, 'shell', command], {
      timeoutMs: this.commandTimeoutMs,
      maxBytes: 256 * 1024,
    });
    const output = `${result.stdout.toString('utf8')}\n${result.stderr}`.trim();
    if (result.timedOut) {
      throw new Error(`"${command}" timed out after ${this.commandTimeoutMs}ms`);
    }
    if (result.code !== 0 || /^(?:Error|Exception|java\.lang\.)/im.test(output)) {
      throw new Error(`input ${type} failed (${command}): ${output.slice(0, 500) || `exit ${result.code}`}`);
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Root / debug operations (DSH debug surface)
  // ---------------------------------------------------------------------------

  /** Serial of the active device or a clear error. */
  _debugSerial() {
    const serial = this._serialActive || this.serial;
    if (!serial) throw new Error('No Android device is attached');
    return serial;
  }

  /**
   * Bring up the rooted debug surface: `adb root`, debug global settings and a
   * small on-device debug helper. Idempotent per boot; safe to call repeatedly.
   */
  async _prepareDebugSystem() {
    if (!(this._serialActive || this.serial)) return null;
    if (this._preparePromise) return this._preparePromise;
    this._preparePromise = (async () => {
      this._debugPrepared = true;
      await this._enableRoot();
      if (this._root) {
        await this._applyDebugSettings();
        await this._installDebugToolkit();
      }
      await this._readIdentity();
      this._pushLog(
        `[vm] debug interface ready: root=${this._root === true}` +
          (this._debugToolkitPath ? ` toolkit=${this._debugToolkitPath}` : ''),
      );
      return this.debugStatus();
    })()
      .catch((error) => {
        this._pushLog(`[vm] debug interface preparation failed: ${error && error.message ? error.message : error}`);
        return this.debugStatus();
      })
      .finally(() => {
        this._preparePromise = null;
      });
    return this._preparePromise;
  }

  /** Ensure adbd is running as root (userdebug images support `adb root`). */
  async ensureRoot() {
    if (this._root === true) return true;
    if (!(this._serialActive || this.serial)) return false;
    await this._prepareDebugSystem();
    return this._root === true;
  }

  async _enableRoot() {
    if (this._root === true) return true;
    const serial = this._debugSerial();
    try {
      const result = await this._adb(['-s', serial, 'root'], { timeoutMs: 20 * 1000, maxBytes: 64 * 1024 });
      const text = `${result.stdout.toString('utf8')}\n${result.stderr}`.trim();
      if (/already running as root/i.test(text)) {
        this._root = true;
      } else if (/restarting adbd as root/i.test(text) || result.code === 0) {
        await sleep(800);
        await this._adb(['-s', serial, 'wait-for-device'], { timeoutMs: this.commandTimeoutMs });
        const id = (await this._adbText(['-s', serial, 'shell', 'id'], { timeoutMs: 10 * 1000 })).trim();
        this._root = /uid=0\(root\)/.test(id);
      } else {
        this._pushLog(`[vm] adb root rejected: ${text.slice(0, 240) || `exit ${result.code}`}`);
        this._root = false;
      }
    } catch (error) {
      this._root = false;
      this._pushLog(`[vm] adb root failed: ${error && error.message ? error.message : error}`);
    }
    if (this._root) this._pushLog('[vm] adb root enabled (uid=0)');
    return this._root === true;
  }

  async _applyDebugSettings() {
    const serial = this._debugSerial();
    const commands = [
      'settings put global adb_enabled 1',
      'settings put global development_settings_enabled 1',
      'settings put global verifier_verify_adb_installs 0',
      'settings put global package_verifier_enable 0',
      'setprop persist.sys.usb.config adb',
      'setprop persist.sys.root_access 3',
    ];
    for (const command of commands) {
      try {
        await this._adbText(['-s', serial, 'shell', command], { timeoutMs: 15 * 1000 });
      } catch {
        /* best effort: some settings are read-only on some images */
      }
    }
  }

  /** Push a small root-ready helper script + README into /data/local/tmp/dsh. */
  async _installDebugToolkit() {
    const serial = this._debugSerial();
    const dir = '/data/local/tmp/dsh';
    const scriptPath = `${dir}/debug.sh`;
    const readmePath = `${dir}/README.txt`;
    const script = [
      '#!/system/bin/sh',
      '# DSH APK VM debug helper. adbd is root, so all commands are uid=0.',
      'cmd="$1"; shift',
      'case "$cmd" in',
      '  info) getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.name; id; wm size; wm density ;;',
      '  logs) logcat -d -t "${1:-200}" $2 $3 $4 ;;',
      '  prop) if [ -n "$2" ]; then setprop "$1" "$2"; else getprop "$1"; fi ;;',
      '  pkgs) pm list packages -3 -f ;;',
      '  install) pm install -r -t "$1" ;;',
      '  help|*) cat /data/local/tmp/dsh/README.txt ;;',
      'esac',
      '',
    ].join('\n');
    const readme = [
      'DSH APK VM debug toolkit',
      '',
      'debug.sh info                 Android/root/display info',
      'debug.sh logs [lines] [tag]   dump logcat',
      'debug.sh prop <name> [value]  get/set a system property',
      'debug.sh pkgs                 list third-party packages',
      'debug.sh install <apk>        install an APK on-device',
      '',
      'adbd is running as root; DSH also exposes these operations over',
      '/apk-vm/debug/* and the apk_vm tool.',
      '',
    ].join('\n');
    const tempDir = os.tmpdir();
    const localScript = path.join(tempDir, `dsh-debug-${process.pid}.sh`);
    const localReadme = path.join(tempDir, `dsh-debug-${process.pid}.txt`);
    try {
      await fsp.writeFile(localScript, script, 'utf8');
      await fsp.writeFile(localReadme, readme, 'utf8');
      await this._adbText(['-s', serial, 'shell', 'mkdir', '-p', dir], { timeoutMs: 10 * 1000 });
      for (const [local, remote] of [
        [localScript, scriptPath],
        [localReadme, readmePath],
      ]) {
        const result = await this._adb(['-s', serial, 'push', local, remote], {
          timeoutMs: 30 * 1000,
          maxBytes: 128 * 1024,
        });
        if (result.code !== 0) throw new Error(`adb push ${remote} failed: ${result.stderr.slice(0, 240)}`);
      }
      await this._adbText(['-s', serial, 'shell', 'chmod', '755', scriptPath], { timeoutMs: 10 * 1000 });
      this._debugToolkitPath = scriptPath;
    } finally {
      await fsp.rm(localScript, { force: true }).catch(() => {});
      await fsp.rm(localReadme, { force: true }).catch(() => {});
    }
  }

  async _readIdentity() {
    const serial = this._debugSerial();
    try {
      const text = await this._adbText(['-s', serial, 'shell', 'getprop'], { timeoutMs: 15 * 1000 });
      const props = {};
      for (const line of text.split(/\r?\n/)) {
        const match = /^\[([^\]]+)\]: \[(.*)\]$/.exec(line.trim());
        if (match) props[match[1]] = match[2];
      }
      this._identity = {
        release: props['ro.build.version.release'] || null,
        sdk: props['ro.build.version.sdk'] ? Number(props['ro.build.version.sdk']) : null,
        model: props['ro.product.model'] || null,
        device: props['ro.product.device'] || null,
        abi: props['ro.product.cpu.abi'] || props['ro.product.cpu.abilist'] || null,
        debugBuild: props['ro.debuggable'] === '1',
        adbSecure: props['ro.adb.secure'] === '1',
        root: this._root === true,
      };
    } catch {
      this._identity = null;
    }
    return this._identity;
  }

  /** Rooted shell, bounded output. `root:false` runs as the current adbd user. */
  async shell(command, options = {}) {
    if (typeof command !== 'string' || !command.trim()) throw new Error('shell command must be a non-empty string');
    if (command.length > 8192) throw new Error('shell command is limited to 8192 characters');
    if (options.root !== false) {
      try {
        await this.ensureRoot();
      } catch {
        /* fall back to the current adbd user */
      }
    }
    const serial = this._debugSerial();
    const result = await this._adb(['-s', serial, 'shell', command], {
      timeoutMs: asPositiveInt(options.timeoutMs, this.commandTimeoutMs),
      maxBytes: asPositiveInt(options.maxBytes, 256 * 1024),
    });
    return {
      ok: !result.timedOut && result.code === 0,
      code: result.code,
      root: this._root === true,
      timedOut: result.timedOut === true,
      stdout: result.stdout.toString('utf8').slice(0, 100000),
      stderr: result.stderr.slice(0, 20000),
    };
  }

  async logcat(options = {}) {
    const serial = this._debugSerial();
    const lines = Math.min(1000, Math.max(1, Number(options.lines) || 200));
    const args = ['-s', serial, 'logcat'];
    const buffer = String(options.buffer || '').toLowerCase();
    if (buffer) {
      if (!['main', 'system', 'crash', 'events', 'all', 'radio', 'kernel'].includes(buffer)) {
        throw new Error(`invalid logcat buffer: ${buffer}`);
      }
      args.push('-b', buffer);
    }
    args.push('-d', '-t', String(lines));
    if (options.filter) args.push(String(options.filter).slice(0, 200));
    const result = await this._adb(args, { timeoutMs: 30 * 1000, maxBytes: 1024 * 1024 });
    const text = result.stdout.toString('utf8');
    return {
      ok: result.code === 0 && !result.timedOut,
      lines: splitLines(text).slice(-lines),
      text: text.slice(-400000),
      timedOut: result.timedOut === true,
    };
  }

  async getprop(name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(name)) throw new Error('invalid property name');
    const serial = this._debugSerial();
    const out = await this._adbText(['-s', serial, 'shell', 'getprop', name], { timeoutMs: 10 * 1000 });
    return { name, value: out.trim() };
  }

  async setprop(name, value) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(name)) throw new Error('invalid property name');
    const text = String(value == null ? '' : value);
    if (text.length > 512) throw new Error('property value is limited to 512 characters');
    if (/[\r\n\0]/.test(text)) throw new Error('property value must be a single line');
    await this.ensureRoot();
    const serial = this._debugSerial();
    const quoted = `'${text.replace(/'/g, `'\\''`)}'`;
    const result = await this._adb(['-s', serial, 'shell', `setprop ${name} ${quoted}`], {
      timeoutMs: 15 * 1000,
      maxBytes: 64 * 1024,
    });
    if (result.code !== 0 || result.timedOut) {
      throw new Error(`setprop ${name} failed: ${result.stderr.toString('utf8').slice(0, 300) || `exit ${result.code}`}`);
    }
    return { ok: true, name, value: text, root: this._root === true };
  }

  async listPackages(options = {}) {
    const serial = this._debugSerial();
    const thirdParty = options.thirdPartyOnly !== false;
    const args = ['-s', serial, 'shell', 'pm', 'list', 'packages', '-f'];
    if (thirdParty) args.push('-3');
    const text = await this._adbText(args, { timeoutMs: 20 * 1000 });
    const packages = [];
    for (const line of text.split(/\r?\n/)) {
      const match = /^package:(.*)=([A-Za-z0-9_.]+)$/.exec(line.trim());
      if (match) packages.push({ apkPath: match[1], packageName: match[2] });
    }
    packages.sort((a, b) => a.packageName.localeCompare(b.packageName));
    return { ok: true, thirdPartyOnly: thirdParty, packages };
  }

  async deviceInfo() {
    const serial = this._debugSerial();
    const identity = this._identity || (await this._readIdentity());
    let size = null;
    let density = null;
    let uptime = null;
    try {
      const wm = await this._adbText(['-s', serial, 'shell', 'wm', 'size'], { timeoutMs: 10 * 1000 });
      const match = /(\d+)\s*x\s*(\d+)/.exec(wm);
      if (match) size = { width: Number(match[1]), height: Number(match[2]) };
      const wmDensity = await this._adbText(['-s', serial, 'shell', 'wm', 'density'], { timeoutMs: 10 * 1000 });
      const densityMatch = /(\d+)/.exec(wmDensity);
      if (densityMatch) density = Number(densityMatch[1]);
      uptime = (await this._adbText(['-s', serial, 'shell', 'cat', '/proc/uptime'], { timeoutMs: 10 * 1000 })).trim();
    } catch {
      /* optional extras */
    }
    return {
      ok: true,
      serial,
      state: this._state,
      root: this._root === true,
      debugToolkit: this._debugToolkitPath,
      avatar: undefined,
      identity,
      size,
      density,
      uptime,
    };
  }

  async pushFile(localPath, remotePath) {
    const serial = this._debugSerial();
    const local = path.resolve(String(localPath));
    if (!existsSync(local)) throw new Error(`local file not found: ${local}`);
    const remote = String(remotePath || '');
    if (!/^\/(?:data\/local\/tmp|sdcard|storage\/emulated\/0)(?:\/|$)/.test(remote)) {
      throw new Error('remote path must be under /data/local/tmp, /sdcard or /storage/emulated/0');
    }
    const result = await this._adb(['-s', serial, 'push', local, remote], {
      timeoutMs: 5 * 60 * 1000,
      maxBytes: 256 * 1024,
    });
    if (result.code !== 0) throw new Error(`adb push failed: ${result.stderr.toString('utf8').slice(0, 300)}`);
    return { ok: true, localPath: local, remotePath: remote, root: this._root === true };
  }

  async pullFile(remotePath, localPath) {
    const serial = this._debugSerial();
    const remote = String(remotePath || '');
    if (!/^\/(?:data\/local\/tmp|sdcard|storage\/emulated\/0)(?:\/|$)/.test(remote)) {
      throw new Error('remote path must be under /data/local/tmp, /sdcard or /storage/emulated/0');
    }
    const local = path.resolve(String(localPath));
    await fsp.mkdir(path.dirname(local), { recursive: true }).catch(() => {});
    const result = await this._adb(['-s', serial, 'pull', remote, local], {
      timeoutMs: 5 * 60 * 1000,
      maxBytes: 256 * 1024,
    });
    if (result.code !== 0) throw new Error(`adb pull failed: ${result.stderr.toString('utf8').slice(0, 300)}`);
    let size = null;
    try {
      size = (await fsp.stat(local)).size;
    } catch {
      /* ignore */
    }
    return { ok: true, remotePath: remote, localPath: local, bytes: size };
  }

  async reboot(mode = '') {
    const serial = this._debugSerial();
    const args = ['-s', serial, 'reboot'];
    if (mode) args.push(String(mode));
    const result = await this._adb(args, { timeoutMs: 20 * 1000, maxBytes: 64 * 1024 });
    if (result.code !== 0 && !result.timedOut) {
      throw new Error(`adb reboot failed: ${result.stderr.toString('utf8').slice(0, 300)}`);
    }
    this._pushLog(`[vm] adb reboot${mode ? ` ${mode}` : ''} requested`);
    return { ok: true, mode: mode || 'system' };
  }

  async forceStop(packageName) {
    this._assertPackageName(packageName);
    return this.shell(`am force-stop ${packageName}`, { timeoutMs: 15 * 1000 });
  }

  async clearData(packageName) {
    this._assertPackageName(packageName);
    return this.shell(`pm clear ${packageName}`, { timeoutMs: 30 * 1000 });
  }

  async uninstall(packageName) {
    this._assertPackageName(packageName);
    return this.shell(`pm uninstall ${packageName}`, { timeoutMs: 30 * 1000 });
  }

  /**
   * Lock the display rotation. Accepts 'portrait' | 'landscape' | 'left' |
   * 'right' | 'upside-down' or an Android user_rotation number 0..3.
   */
  async rotate(orientation = 'landscape') {
    const map = { portrait: 0, landscape: 1, left: 1, right: 3, 'upside-down': 2, upside_down: 2 };
    const rotation =
      typeof orientation === 'number'
        ? Math.min(3, Math.max(0, Math.round(orientation)))
        : map[String(orientation || '').toLowerCase()];
    if (rotation === undefined) throw new Error(`invalid rotation: ${JSON.stringify(orientation)}`);
    await this.ensureRoot();
    const serial = this._debugSerial();
    const result = await this._adb(
      ['-s', serial, 'shell', `settings put system accelerometer_rotation 0; settings put system user_rotation ${rotation}`],
      { timeoutMs: 15000, maxBytes: 64 * 1024 },
    );
    if (result.code !== 0 || result.timedOut) {
      throw new Error(`rotate failed: ${result.stderr.toString('utf8').slice(0, 300) || `exit ${result.code}`}`);
    }
    return { ok: true, rotation, orientation: String(orientation) };
  }

  /** Dump the current UIAutomator hierarchy XML (for agent/UI inspection). */
  async uiDump() {
    await this.ensureRoot();
    const serial = this._debugSerial();
    const remote = '/data/local/tmp/dsh-window.xml';
    const result = await this._adb(
      ['-s', serial, 'shell', `uiautomator dump ${remote} >/dev/null 2>&1; cat ${remote}`],
      { timeoutMs: 45000, maxBytes: 1024 * 1024 },
    );
    let xml = result.stdout.toString('utf8').trim();
    if (!/<hierarchy[\s>]/.test(xml)) {
      throw new Error(`uiautomator dump failed: ${result.stderr.toString('utf8').slice(0, 300) || 'empty hierarchy'}`);
    }
    const nodes = (xml.match(/<node\b/g) || []).length;
    if (xml.length > 500000) xml = xml.slice(0, 500000);
    return {
      ok: true,
      rotation: (xml.match(/<hierarchy rotation="(\d+)"/) || [])[1] || null,
      nodes,
      bytes: Buffer.byteLength(xml),
      xml,
      remotePath: remote,
    };
  }

  /** Record a short MP4 from the guest display and pull it to the host temp dir. */
  async screenRecord(options = {}) {
    const seconds = Math.min(60, Math.max(1, Math.round(Number(options.seconds) || 5)));
    const serial = this._debugSerial();
    const stamp = Date.now();
    const remote = `/sdcard/dsh-record-${stamp}.mp4`;
    const command = `screenrecord --time-limit ${seconds} --size 540x960 ${remote}`;
    const result = await this._adb(['-s', serial, 'shell', command], {
      timeoutMs: (seconds + 25) * 1000,
      maxBytes: 128 * 1024,
    });
    if (result.timedOut || result.code !== 0) {
      throw new Error(`screenrecord failed: ${result.stderr.toString('utf8').slice(0, 300) || `exit ${result.code}`}`);
    }
    const localPath = path.join(os.tmpdir(), `dsh-apk-vm-record-${stamp}.mp4`);
    await this.pullFile(remote, localPath);
    await this._adbText(['-s', serial, 'shell', 'rm', '-f', remote], { timeoutMs: 10000 }).catch(() => {});
    let bytes = null;
    try {
      bytes = (await fsp.stat(localPath)).size;
    } catch {
      /* ignore */
    }
    this._pushLog(`[vm] screenrecord ${seconds}s -> ${localPath} (${bytes || '?'} bytes)`);
    return { ok: true, seconds, localPath, bytes };
  }

  /** Small performance snapshot: load average, memory and top CPU processes. */
  async perfSnapshot() {
    const serial = this._debugSerial();
    const text = await this._adbText(
      [
        '-s',
        serial,
        'shell',
        'cat /proc/loadavg; echo ---MEM---; head -n 3 /proc/meminfo; echo ---CPU---; dumpsys cpuinfo | head -n 24',
      ],
      { timeoutMs: 30000, maxBytes: 128 * 1024 },
    );
    const [loadPart, rest = ''] = text.split('---MEM---');
    const [memPart, cpuPart = ''] = rest.split('---CPU---');
    const memNums = {};
    for (const line of memPart.split(/\r?\n/)) {
      const match = /^(MemTotal|MemFree|MemAvailable|Buffers|Cached):\s+(\d+)\s+kB/.exec(line.trim());
      if (match) memNums[match[1]] = Number(match[2]);
    }
    return {
      ok: true,
      sampledAt: Date.now(),
      loadavg: loadPart.trim().split(/\s+/).slice(0, 3).join(' '),
      memTotalKb: memNums.MemTotal || null,
      memFreeKb: memNums.MemFree || null,
      memAvailableKb: memNums.MemAvailable || null,
      cpuinfo: cpuPart.trim().split(/\r?\n/).slice(0, 24),
    };
  }

  /** List AVD names available to the configured emulator. */
  async listAvds() {
    if (!this.emulatorPath) return [];
    try {
      const result = await this._run(this.emulatorPath, ['-list-avds'], { timeoutMs: 15000, maxBytes: 64 * 1024 });
      if (result.code !== 0 || result.timedOut) return [];
      return String(result.stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('INFO') && !line.startsWith('WARNING'));
    } catch {
      return [];
    }
  }

  /** Switch the configured AVD (stops the current emulator first). */
  async setAvd(avdName) {
    const target = String(avdName || '').trim();
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(target)) throw new Error(`invalid AVD name: ${JSON.stringify(avdName)}`);
    if (target === this.avdName) return { ok: true, avdName: target, changed: false };
    await this.stop();
    this.avdName = target;
    this._snapshotAvailable = null;
    this._bootKind = null;
    this._identity = null;
    this._root = false;
    this._debugPrepared = false;
    this._debugToolkitPath = null;
    this._pushLog(`[vm] AVD switched to ${target}`);
    return { ok: true, avdName: target, changed: true };
  }

  _assertPackageName(packageName) {
    if (typeof packageName !== 'string' || !PACKAGE_RE.test(packageName)) {
      throw new Error(`invalid package name: ${JSON.stringify(packageName)}`);
    }
  }

  debugStatus() {
    return {
      root: this._root === true,
      prepared: this._debugPrepared === true,
      toolkit: this._debugToolkitPath,
      identity: this._identity,
      adb: this._serialActive || this.serial || null,
    };
  }

  /**
   * Connect to a network adb device (`adb connect host:port`) and wait until adb
   * reports it in state `device`. Non-network serials are only waited on.
   * Returns a status snapshot. Throws on connection failure/timeout.
   */
  async connect(serial) {
    const target = serial ? String(serial).trim() : this.serial;
    if (!target) throw new Error('connect(serial) requires a serial or a configured serial option');
    if (!SERIAL_RE.test(target)) throw new Error(`invalid adb serial: ${JSON.stringify(target)}`);

    this.serial = target;
    this._serialActive = target;
    this._pushLog(`[vm] connecting to ${target}`);

    try {
      if (isNetworkSerial(target)) {
        const result = await this._adb(['connect', target], { timeoutMs: this.connectTimeoutMs });
        const output = `${result.stdout.toString('utf8')}\n${result.stderr}`.trim();
        if (result.timedOut) {
          throw new Error(`adb connect ${target} timed out after ${this.connectTimeoutMs}ms`);
        }
        const failed = /(?:cannot|failed|unable|refused|does not match|unknown host)/i.test(output);
        if (failed && !/already connected/i.test(output)) {
          throw new Error(`adb connect ${target} failed: ${output || `exit ${result.code}`}`);
        }
      }
    } catch (error) {
      this._setState('error', error.message);
      this._pushLog(`[vm] ${error.message}`);
      throw error;
    }

    const deadline = Date.now() + this.connectTimeoutMs;
    let lastState = null;
    for (;;) {
      const devices = await this._listDevices();
      if (this._lastProbeError) {
        // keep polling; a transient adb server hiccup should not abort a connect
      }
      const deviceState = devices.get(target) || null;
      lastState = deviceState;
      if (deviceState === 'device') {
        if (this._state !== 'ready') this._setState('starting');
        this._pushLog(`[vm] connected: ${target}`);
        return this._snapshot();
      }
      if (deviceState === 'unauthorized') {
        this._setState('error', `adb device ${target} is unauthorized; accept the debugging prompt`);
        throw new Error(`adb device ${target} is unauthorized`);
      }
      if (Date.now() >= deadline) {
        const message = `timed out after ${this.connectTimeoutMs}ms waiting for ${target} ` +
          `(last adb state: ${lastState || 'absent'})`;
        this._setState('error', message);
        throw new Error(message);
      }
      await sleep(500);
    }
  }

  /**
   * Wait until `sys.boot_completed` reports 1 for the attached device. Expected
   * failure (timeout) is stored in status().error; this method does not throw.
   * Returns a status snapshot.
   */
  async waitBooted(timeoutMs) {
    const epoch = this._waitEpoch;
    if (this._bootWait && this._bootWait.epoch === epoch) return this._bootWait.promise;
    const entry = { epoch, promise: null };
    entry.promise = this._waitBootInner(timeoutMs, epoch)
      .catch((error) => {
        if (entry.epoch === this._waitEpoch) {
          this._setState('error', `waitBooted failed: ${error && error.message ? error.message : error}`);
        }
        return this._snapshot();
      })
      .finally(() => {
        if (this._bootWait === entry) this._bootWait = null;
      });
    this._bootWait = entry;
    return entry.promise;
  }

  /**
   * List devices visible to adb (emulators and physical/remote devices) with
   * model/product metadata for the device picker.
   */
  async listDevices() {
    let result;
    try {
      result = await this._adb(['devices', '-l'], { timeoutMs: 15000 });
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error), devices: [], current: this._serialActive || this.serial || null, external: this._external };
    }
    if (result.timedOut) return { ok: false, error: 'adb devices timed out', devices: [], current: this._serialActive || this.serial || null, external: this._external };
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout.toString('utf8')).trim().slice(0, 300);
      return { ok: false, error: `adb devices failed (exit ${result.code}): ${detail}`, devices: [], current: this._serialActive || this.serial || null, external: this._external };
    }
    const devices = [];
    for (const line of splitLines(result.stdout.toString('utf8'))) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('List of devices') || trimmed.startsWith('*')) continue;
      const match = /^(\S+)\s+(\S+)(.*)$/.exec(trimmed);
      if (!match) continue;
      const serial = match[1];
      const state = match[2];
      const fields = {};
      for (const part of match[3].trim().split(/\s+/)) {
        const colon = part.indexOf(':');
        if (colon > 0) fields[part.slice(0, colon)] = part.slice(colon + 1);
      }
      const kind = serial.startsWith('emulator-') ? 'emulator' : serial.includes(':') ? 'network' : 'physical';
      devices.push({
        serial,
        state,
        kind,
        model: fields.model || null,
        product: fields.product || null,
        device: fields.device || null,
        transportId: fields.transport_id || null,
      });
    }
    return {
      ok: true,
      devices,
      current: this._serialActive || this.serial || null,
      external: this._external === true,
      externalSerial: this._externalSerial || null,
      managedAvdName: this._managedAvdName || null,
    };
  }

  /**
   * Attach to an already-online adb device (physical USB or network) for this
   * plugin session. The managed AVD identity is preserved for detachDevice().
   */
  async attachDevice(serial) {
    const target = String(serial || '').trim();
    if (!target) throw new Error('attachDevice(serial) requires a device serial');
    if (!SERIAL_RE.test(target)) throw new Error(`invalid adb serial: ${JSON.stringify(target)}`);
    const listed = await this.listDevices();
    const entry = listed.devices.find((device) => device.serial === target);
    if (!entry) throw new Error(`adb device ${target} is not visible; connect it first`);
    if (entry.state === 'unauthorized') throw new Error(`adb device ${target} is unauthorized; accept the debugging prompt`);
    if (entry.state !== 'device') throw new Error(`adb device ${target} is ${entry.state}, not online`);

    if (this._serialActive === target && this._state === 'ready') {
      // Same device already attached: only switch the identity to external.
      if (!this._external) {
        this._managedAvdName = this.avdName;
        this._managedSerial = this.serial;
        this._managedPort = this.port;
      }
      this._external = true;
      this._externalSerial = target;
      this.avdName = '';
      this.serial = target;
      this.port = null;
      this._pushLog(`[vm] external device ${target} marked as active`);
      return this._snapshot();
    }

    const managed = this._external
      ? { avdName: this._managedAvdName, serial: this._managedSerial, port: this._managedPort }
      : { avdName: this.avdName, serial: this.serial, port: this.port };
    if (this._state !== 'stopped') await this.stop();
    this._managedAvdName = managed.avdName;
    this._managedSerial = managed.serial;
    this._managedPort = managed.port;
    this._external = true;
    this._externalSerial = target;
    this.avdName = '';
    this.serial = target;
    this.port = null;
    this._serialActive = null;
    this._state = 'stopped';
    this._pushLog(`[vm] attaching external device ${target}`);
    await this.start();
    return this._snapshot();
  }

  /** Restore the managed AVD identity after an external-device session. */
  async detachDevice() {
    if (!this._external) return this._snapshot();
    this._waitEpoch += 1;
    this._serialActive = null;
    this._external = false;
    this._externalSerial = null;
    this.avdName = this._managedAvdName;
    this.serial = this._managedSerial;
    this.port = this._managedPort;
    this._setState('stopped');
    this._pushLog('[vm] external device detached; managed AVD identity restored');
    return this._snapshot();
  }

  /** Stop the VM (if we own it) and mark this instance disposed. */
  async dispose() {
    if (this._disposing) return this._disposing;
    this._disposing = (async () => {
      try {
        await this.stop();
      } catch {
        /* dispose must never throw */
      }
      this._disposed = true;
      this._logTail = [];
      this._setState('stopped');
    })();
    return this._disposing;
  }

  // ---------------------------------------------------------------------------
  // start() internals
  // ---------------------------------------------------------------------------

  async _startInner(epoch = this._waitEpoch) {
    this._bootMs = null;
    this._bootStartAt = null;
    this._sawNotBooted = false;
    this._bootProbe = { serial: null, at: 0, booted: false };
    if (this._error) this._error = null;
    this._pushLog(`[vm] start requested (adb=${this.adbPath})`);

    let devices = await this._listDevices();
    if (epoch !== this._waitEpoch) return;
    let target = this._resolveTarget(devices);

    // A configured network serial that is present-but-not-online (or absent) is
    // re-established with `adb connect`; this is the normal path for a QEMU VM.
    if (this.serial && isNetworkSerial(this.serial) && (!target || devices.get(this.serial) !== 'device')) {
      try {
        await this.connect(this.serial);
        target = this.serial;
      } catch (error) {
        if (epoch !== this._waitEpoch) return;
        this._setState('error', error.message);
        this._pushLog(`[vm] ${error.message}`);
        return;
      }
      if (epoch !== this._waitEpoch) return;
    }

    // A stale/offline emulator device (e.g. an emulator that crashed and left
    // its adb entry behind) must not trap us in the attach path forever:
    // without a live child of our own, fall through and spawn a fresh VM.
    if (
      target &&
      devices.get(target) !== 'device' &&
      !this._child &&
      !this.serial &&
      this.emulatorPath &&
      this.avdName &&
      this.spawnEmulatorEnabled
    ) {
      this._pushLog(`[vm] ignoring stale ${devices.get(target)} device ${target}; spawning a fresh emulator`);
      this._serialActive = null;
      target = null;
    }

    if (!target) {
      if (this.emulatorPath && this.avdName && this.spawnEmulatorEnabled) {
        await this._spawnEmulatorAndWait(epoch);
        return;
      }
      const checked = this.serial
        ? `configured serial ${this.serial} is not connected`
        : 'no adb device is online';
      const hint =
        'Start the open-source Android VM (e.g. QEMU) and either call connect("host:port"), ' +
        'set options.serial, or explicitly configure options.emulatorPath + options.avdName.';
      if (epoch !== this._waitEpoch) return;
      this._setState('error', `No Android device available: ${checked}. ${hint}`);
      this._pushLog(`[vm] ${this._error}`);
      return;
    }

    this._serialActive = target;
    this._pushLog(`[vm] attaching to existing device ${target}`);
    if (this._state !== 'ready') this._setState('starting');
    if (!this._bootStartAt) this._bootStartAt = Date.now();
    await this.waitBooted(this.bootTimeoutMs);
    if (epoch !== this._waitEpoch) return; // stop() interrupted this run
    if (this._state === 'ready') await this._prepareDebugSystem();
  }

  // ---------------------------------------------------------------------------
  // Boot-speed helpers: hypervisor detection, host GPU, quick-boot snapshots
  // ---------------------------------------------------------------------------

  /** The AVD directory (`~/.android/avd/<name>.avd`), honoring AVD home env vars. */
  _avdDirectory() {
    if (!this.avdName) return null;
    const avdHome =
      process.env.ANDROID_AVD_HOME ||
      (process.env.ANDROID_EMULATOR_HOME
        ? path.join(process.env.ANDROID_EMULATOR_HOME, 'avd')
        : path.join(os.homedir(), '.android', 'avd'));
    return path.join(avdHome, `${this.avdName}.avd`);
  }

  /** Whether a saved quick-boot snapshot directory looks usable. */
  _snapshotPresent(name) {
    if (!this.quickBoot) return false;
    const dir = this._avdDirectory();
    if (!dir) return false;
    const snap = path.join(dir, 'snapshots', name || this.snapshotName);
    try {
      // A real emulator quick-boot snapshot has snapshot.pb; a leftover
      // `ram.img` from a crashed `-mem-path` run is NOT a restorable snapshot.
      return existsSync(path.join(snap, 'snapshot.pb'));
    } catch {
      return false;
    }
  }

  /**
   * Detect a usable CPU hypervisor (AEHD / WHPX / KVM / HAXM / HVF) through the
   * SDK's `emulator-check accel`. Returns false when only software TCG is
   * available. Result is cached for the lifetime of this AndroidVm.
   */
  async _detectAcceleration() {
    if (this.accel === 'off') return false;
    if (this.accel === 'on') return true;
    if (this._accelAvailable !== null) return this._accelAvailable;
    if (!this.emulatorPath) {
      this._accelAvailable = false;
      return false;
    }
    const checkName = IS_WIN ? 'emulator-check.exe' : 'emulator-check';
    const checkPath = path.join(path.dirname(this.emulatorPath), checkName);
    if (!existsSync(checkPath)) {
      // No checker: let the emulator decide (its own error is surfaced in logTail).
      this._accelAvailable = true;
      return true;
    }
    let available = false;
    let detail = '';
    try {
      const result = await this._run(checkPath, ['accel'], {
        timeoutMs: this.accelCheckTimeoutMs,
        maxBytes: 64 * 1024,
      });
      detail = `${result.stdout.toString('utf8')}\n${result.stderr}`.trim();
      available =
        result.code === 0 &&
        /(usable|installed|whpx|aehd|kvm|haxm|hvf)/i.test(detail) &&
        !/not installed|not supported|disabled/i.test(detail);
    } catch (error) {
      detail = error && error.message ? error.message : String(error);
      available = false;
    }
    this._accelAvailable = available;
    this._pushLog(
      `[vm] CPU acceleration: ${available ? 'hardware' : 'software TCG'}${detail ? ` (${detail.split(/\r?\n/).slice(0, 2).join('; ')})` : ''}`,
    );
    return available;
  }

  /**
   * Compose the emulator argv for the fastest viable boot:
   * - restore the saved snapshot when available (quick boot)
   * - otherwise cold boot and let the caller save a fresh snapshot afterwards
   * - use host GPU unless configured otherwise
   * - only force `-accel off` when no hypervisor is detected
   */
  async _buildLaunchPlan() {
    const accelAvailable = await this._detectAcceleration();
    const snapshotAvailable = this.quickBoot && this._snapshotPresent();
    if (!accelAvailable && this.requireAccel && this.accel !== 'off') {
      const message =
        process.platform === 'win32'
          ? 'No usable CPU hypervisor (AEHD/WHPX) was found: an x86_64 Android image cannot boot under pure TCG (the guest stays offline forever). Install/enable AEHD (or Windows Hypervisor Platform) and reboot Windows once, then retry.'
          : process.platform === 'darwin'
            ? 'No usable CPU hypervisor (macOS Hypervisor.framework/HVF) was found: an x86_64 Android image cannot boot under pure TCG. Enable hardware virtualization and retry.'
            : 'No usable CPU hypervisor (KVM/HAXM) was found: an x86_64 Android image cannot boot under pure TCG. Enable KVM/HAXM and retry.';
      return { args: [], bootKind: 'cold', accelAvailable, snapshotAvailable, fatal: message };
    }
    const bootKind = snapshotAvailable ? 'snapshot' : 'cold';
    const args = ['-avd', this.avdName, '-no-window', '-no-audio', '-no-boot-anim'];
    if (snapshotAvailable) {
      args.push('-snapshot', this.snapshotName);
    } else if (!this.quickBoot) {
      args.push('-no-snapshot');
    }
    if (!accelAvailable) args.push('-accel', 'off');
    if (this.gpuMode) args.push('-gpu', this.gpuMode);
    // NOTE: the Android emulator only accepts `-prop qemu.*`; ro./service.
    // properties cannot be injected from the command line. Root/debug state is
    // therefore established right after boot (adb root + debug settings) and
    // captured by the quick-boot snapshot, so subsequent quick boots restore it.
    args.push('-port', String(this.port), ...this.emulatorArgs);
    return { args, bootKind, accelAvailable, snapshotAvailable };
  }

  /** Save a quick-boot snapshot of the running device (deduplicated). */
  async saveSnapshot(name) {
    const serial = this._serialActive || this.serial;
    if (!serial) throw new Error('saveSnapshot requires an attached device');
    if (this._snapshotSave) return this._snapshotSave;
    const snapName = name ? String(name) : this.snapshotName;
    this._snapshotSave = (async () => {
      this._pushLog(`[vm] saving quick-boot snapshot "${snapName}"`);
      const result = await this._adb(['-s', serial, 'emu', 'avd', 'snapshot', 'save', snapName], {
        timeoutMs: 120 * 1000,
        maxBytes: 256 * 1024,
      });
      const output = `${result.stdout.toString('utf8')}\n${result.stderr}`.trim();
      if (result.timedOut || result.code !== 0) {
        throw new Error(`snapshot save failed: ${output.slice(0, 400) || `exit ${result.code}`}`);
      }
      this._snapshotAvailable = true;
      this._snapshotSavedAt = Date.now();
      this._pushLog(`[vm] quick-boot snapshot saved ("${snapName}")`);
      return { ok: true, name: snapName, output: output.slice(0, 400) };
    })().finally(() => {
      this._snapshotSave = null;
    });
    return this._snapshotSave;
  }

  async _maybeSaveSnapshot() {
    if (!this.quickBoot || !this.saveSnapshotAfterBoot) return;
    try {
      await this.saveSnapshot();
    } catch (error) {
      this._pushLog(`[vm] snapshot save skipped: ${error && error.message ? error.message : error}`);
    }
  }

  async _spawnEmulatorAndWait(epoch = this._waitEpoch) {
    this._spawnedByUs = true;
    this._serialActive = this.serial || `emulator-${this.port}`;
    this.serial = this._serialActive;
    this._bootStartAt = Date.now();
    this._sawNotBooted = false;
    this._bootProbe = { serial: null, at: 0, booted: false };
    this._snapshotLoadFailed = false;
    this._setState('starting');

    const plan = await this._buildLaunchPlan();
    if (epoch !== this._waitEpoch) return;
    this._bootKind = plan.bootKind;
    this._accelAvailable = plan.accelAvailable;
    this._snapshotAvailable = plan.snapshotAvailable;
    if (plan.fatal) {
      this._setState('error', plan.fatal);
      this._pushLog(`[vm] ${plan.fatal}`);
      return;
    }
    this._lastLaunchArgs = plan.args.slice();
    this._pushLog(
      `[vm] spawning emulator (${plan.bootKind}${plan.snapshotAvailable ? ` snapshot=${this.snapshotName}` : ''}` +
        `, accel=${plan.accelAvailable ? 'hardware' : 'TCG'}, gpu=${this.gpuMode}) port=${this.port}`,
    );

    const args = plan.args;

    let child;
    try {
      child = spawn(this.emulatorPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this._setState('error', `failed to spawn emulator: ${error.message}`);
      return;
    }
    this._child = child;

    const forward = (prefix) => (chunk) => {
      for (const line of splitLines(chunk.toString('utf8'))) {
        const text = line.trimEnd();
        if (text.trim()) this._pushLog(`${prefix}${text}`);
        if (/failed to load snapshot|starting from scratch|different avd configuration|ignoring -snapshot option/i.test(text)) {
          this._snapshotLoadFailed = true;
        }
      }
    };
    child.stdout.on('data', forward(''));
    child.stderr.on('data', forward('[emu] '));
    child.on('error', (error) => {
      if (epoch === this._waitEpoch && this._state !== 'stopped' && this._state !== 'ready') {
        this._setState('error', `emulator spawn error: ${error.message}`);
      }
    });
    child.on('exit', (code, signal) => {
      this._pushLog(`[vm] emulator exited (code=${code}, signal=${signal})`);
      const current = this._child === child;
      if (current) this._child = null;
      // Surface crashes for the run that still owns this VM instance.
      if (
        current &&
        epoch === this._waitEpoch &&
        !this._disposed &&
        this._state !== 'stopped' &&
        this._state !== 'ready'
      ) {
        this._setState('error', `emulator exited (code ${code}, signal ${signal || 'none'}) before boot completed`);
      }
    });

    await this.waitBooted(this.bootTimeoutMs);
    if (epoch !== this._waitEpoch) return; // stop() interrupted this run
    if (this._state === 'ready') {
      if (this._bootKind === 'snapshot' && this._snapshotLoadFailed) {
        this._bootKind = 'cold';
        this._pushLog('[vm] snapshot load failed; continuing as cold boot and rebuilding the snapshot');
      }
      await this._warmUpSpawnedDevice();
      // Cold boot produced the first image of the system; persist it so every
      // later start takes the snapshot path (seconds instead of a boot).
      if (this._bootKind === 'cold') void this._maybeSaveSnapshot();
    }
  }

  async _warmUpSpawnedDevice() {
    const serial = this._serialActive;
    if (!serial) return;
    try {
      await this._adbText(['-s', serial, 'shell', 'wm', 'dismiss-keyguard'], {
        timeoutMs: 15000,
      });
      this._pushLog('[vm] keyguard dismissed');
    } catch {
      /* best effort only */
    }
    // adb root + debug settings + on-device toolkit; included in the snapshot
    // saved by the caller, so a quick boot restores the rooted debug surface.
    await this._prepareDebugSystem();
  }

  // ---------------------------------------------------------------------------
  // Boot-wait / status probing
  // ---------------------------------------------------------------------------

  async _waitBootInner(timeoutMs, epoch = this._waitEpoch) {
    const budget = asPositiveInt(timeoutMs, this.bootTimeoutMs);
    const deadline = Date.now() + budget;
    if (!this._bootStartAt) this._bootStartAt = Date.now();
    this._pushLog(`[vm] waiting for Android boot (timeout ${Math.round(budget / 1000)}s)`);
    let lastLoggedState = null;

    for (;;) {
      if (this._disposed) return this._snapshot();
      if (epoch !== this._waitEpoch) {
        // stop() was requested while we waited
        return this._snapshot();
      }
      if (this._child && this._child.exitCode !== null) {
        this._setState('error', `emulator exited (code ${this._child.exitCode}) before Android booted`);
        return this._snapshot();
      }

      const devices = await this._listDevices();
      if (epoch !== this._waitEpoch) return this._snapshot();
      const target = this._resolveTarget(devices);

      if (target && devices.get(target) === 'device') {
        this._serialActive = target;
        const booted = await this._probeBootedCached(target);
        if (epoch !== this._waitEpoch) return this._snapshot();
        if (booted) {
          const bootMs = this._bootStartAt ? Date.now() - this._bootStartAt : null;
          this._bootMs = bootMs;
          this._setState('ready');
          const kind = this._bootKind || 'attach';
          this._pushLog(
            `[vm] boot completed on ${target}` +
              (bootMs !== null ? ` in ${(bootMs / 1000).toFixed(1)}s` : ' (device was already booted)') +
              ` [${kind}]`,
          );
          return this._snapshot();
        }
        this._sawNotBooted = true;
        if (this._state !== 'booting') this._setState('booting');
      } else if (target) {
        const deviceState = devices.get(target);
        this._serialActive = target;
        if (deviceState === 'unauthorized') {
          this._setState('error', `adb device ${target} is unauthorized; accept the debugging prompt`);
          return this._snapshot();
        }
        if (this._state !== 'starting') this._setState('starting');
      } else {
        if (lastLoggedState !== 'waiting-for-device') {
          this._pushLog(
            `[vm] no adb device yet (${this.serial ? `waiting for ${this.serial}` : 'waiting for any device'})`,
          );
          lastLoggedState = 'waiting-for-device';
        }
        if (this._state !== 'starting' && this._state !== 'error') this._setState('starting');
      }

      if (Date.now() >= deadline) {
        const targetLabel = this.serial || this._serialActive || 'any adb device';
        const message =
          `timed out after ${Math.round(budget / 1000)}s waiting for Android boot on ${targetLabel}` +
          (this._lastProbeError ? ` (adb probe error: ${this._lastProbeError})` : '');
        this._setState('error', message);
        this._pushLog(`[vm] ${message}`);
        return this._snapshot();
      }
      await sleep(this.pollIntervalMs);
    }
  }

  async _refresh() {
    const devices = await this._listDevices();

    if (this._lastProbeError) {
      if (this._state !== 'error') this._setState('error', this._lastProbeError);
      return;
    }

    const target = this._resolveTarget(devices);
    if (target) {
      this._serialActive = target;
      const deviceState = devices.get(target);
      if (deviceState === 'device') {
        if (this._state !== 'ready') {
          const booted = await this._probeBootedCached(target);
          if (booted) {
            if (this._bootStartAt) {
              this._bootMs = Date.now() - this._bootStartAt;
            }
            this._setState('ready');
          } else {
            this._sawNotBooted = true;
            if (this._state !== 'booting') this._setState('booting');
          }
        }
      } else if (deviceState === 'unauthorized') {
        this._setState('error', `adb device ${target} is unauthorized; accept the debugging prompt`);
      } else {
        if (this._state === 'ready' || this._state === 'booting') {
          this._pushLog(`[vm] device ${target} went ${deviceState}`);
        }
        this._setState('starting');
      }
    } else {
      this._bootProbe = { serial: null, at: 0, booted: false };
      if (this._child && this._child.exitCode === null) {
        this._setState('starting');
      } else if (this._state !== 'error') {
        this._serialActive = null;
        this._setState('stopped');
      } else {
        // Keep the error message but do not report a stale serial.
        this._serialActive = null;
      }
    }
  }

  /** Run `getprop sys.boot_completed` with a short cache + single-flight coalescing. */
  async _probeBootedCached(serial) {
    const cache = this._bootProbe;
    if (cache.serial === serial && Date.now() - cache.at < this.bootProbeCacheMs) {
      return cache.booted;
    }
    if (this._bootProbeInFlight) return this._bootProbeInFlight;

    this._bootProbeInFlight = (async () => {
      let booted = false;
      try {
        const result = await this._adb(['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
          timeoutMs: Math.min(this.commandTimeoutMs, 15000),
          maxBytes: 4096,
        });
        booted =
          result.code === 0 && !result.timedOut && result.stdout.toString('utf8').trim() === '1';
      } catch {
        booted = false;
      }
      this._bootProbe = { serial, booted, at: Date.now() };
      return booted;
    })().finally(() => {
      this._bootProbeInFlight = null;
    });
    return this._bootProbeInFlight;
  }

  // ---------------------------------------------------------------------------
  // adb plumbing
  // ---------------------------------------------------------------------------

  _resolveTarget(devices) {
    if (this.serial) {
      return devices.has(this.serial) ? this.serial : null;
    }
    for (const [serial, state] of devices) {
      if (state === 'device') return serial;
    }
    for (const [serial] of devices) return serial;
    return null;
  }

  async _adb(args, options = {}) {
    return this._run(this.adbPath, args, options);
  }

  async _adbText(args, options = {}) {
    const result = await this._adb(args, options);
    if (result.timedOut) {
      throw new Error(`adb ${args.join(' ')} timed out after ${options.timeoutMs || this.commandTimeoutMs}ms`);
    }
    if (result.code !== 0) {
      const detail = `${result.stderr}\n${result.stdout.toString('utf8')}`.trim().slice(0, 500);
      throw new Error(`adb ${args.join(' ')} failed (exit ${result.code}): ${detail}`);
    }
    return result.stdout.toString('utf8');
  }

  /** Bounded, non-blocking child process runner. Never uses a host shell. */
  _run(executable, args, options = {}) {
    const timeoutMs = asPositiveInt(options.timeoutMs, this.commandTimeoutMs);
    const maxBytes = asPositiveInt(options.maxBytes, this.maxOutputBytes);

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(executable, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(new Error(`failed to spawn ${executable}: ${error.message}`));
        return;
      }

      const stdoutChunks = [];
      let stdoutBytes = 0;
      let stdoutTruncated = false;
      const stderrChunks = [];
      let stderrBytes = 0;
      let settled = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      child.stdout.on('data', (chunk) => {
        if (stdoutBytes >= maxBytes) {
          stdoutTruncated = true;
          return;
        }
        const room = maxBytes - stdoutBytes;
        const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
        stdoutChunks.push(slice);
        stdoutBytes += slice.length;
        if (slice.length < chunk.length) stdoutTruncated = true;
      });
      child.stderr.on('data', (chunk) => {
        if (stderrBytes >= 256 * 1024) return;
        const room = 256 * 1024 - stderrBytes;
        const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
        stderrChunks.push(slice);
        stderrBytes += slice.length;
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`failed to run ${executable}: ${error.message}`));
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code,
          signal,
          timedOut,
          truncated: stdoutTruncated,
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        });
      });
    });
  }

  /** Parse `adb devices -l`; returns Map<serial, state>. Never throws. */
  async _listDevices(options = {}) {
    let result;
    try {
      result = await this._adb(['devices', '-l'], { timeoutMs: options.timeoutMs || 15000 });
    } catch (error) {
      this._lastProbeError = `adb devices failed: ${error.message}`;
      this._devicesCache = { at: Date.now(), devices: new Map() };
      return new Map();
    }
    if (result.timedOut) {
      this._lastProbeError = 'adb devices timed out';
      this._devicesCache = { at: Date.now(), devices: new Map() };
      return new Map();
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout.toString('utf8')).trim().slice(0, 300);
      this._lastProbeError = `adb devices failed (exit ${result.code}): ${detail}`;
      this._devicesCache = { at: Date.now(), devices: new Map() };
      return new Map();
    }

    const devices = new Map();
    for (const line of splitLines(result.stdout.toString('utf8'))) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('List of devices') || trimmed.startsWith('*')) continue;
      const match = /^(\S+)\s+(\S+)/.exec(trimmed);
      if (!match) continue;
      devices.set(match[1], match[2]);
    }
    this._devicesCache = { at: Date.now(), devices };
    this._lastProbeError = null;
    return devices;
  }

  async _requireSerial() {
    if (this._serialActive) {
      const devices = await this._listDevices();
      if (this._lastProbeError) {
        throw new Error(`adb unavailable: ${this._lastProbeError}`);
      }
      if (devices.get(this._serialActive) === 'device') return this._serialActive;
      this._serialActive = null;
    }
    const devices = await this._listDevices();
    if (this._lastProbeError) {
      throw new Error(`adb unavailable: ${this._lastProbeError}`);
    }
    const serial = this._resolveTarget(devices);
    if (!serial || devices.get(serial) !== 'device') {
      throw new Error(
        'no Android device is online; call start() or connect(serial) first ' +
          `(adb=${this.adbPath})`,
      );
    }
    this._serialActive = serial;
    return serial;
  }

  async _assertApkFile(apkPath) {
    if (typeof apkPath !== 'string' || apkPath.trim() === '') {
      throw new Error('an APK path is required');
    }
    const file = path.resolve(apkPath);
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      throw new Error(`APK not found: ${file}`);
    }
    if (!stat.isFile()) throw new Error(`not a regular file: ${file}`);
    return file;
  }

  /** Locate aapt2: explicit option, then newest SDK build-tools, then PATH. */
  async _findAapt2() {
    if (this._aapt2Resolved !== undefined) return this._aapt2Resolved;
    if (this.options.aapt2Path) {
      const explicit = String(this.options.aapt2Path);
      this._aapt2Resolved = existsSync(explicit) ? explicit : null;
      if (this._aapt2Resolved) return this._aapt2Resolved;
    }
    for (const root of candidateSdkRoots(this.sdkRoot)) {
      const buildTools = path.join(root, 'build-tools');
      let entries;
      try {
        entries = await fsp.readdir(buildTools, { withFileTypes: true });
      } catch {
        continue;
      }
      const versions = entries
        .filter((entry) => entry.isDirectory() && /^\d/.test(entry.name))
        .map((entry) => entry.name)
        .sort(compareVersionsDesc);
      for (const version of versions) {
        const candidate = path.join(buildTools, version, `aapt2${EXE}`);
        if (existsSync(candidate)) {
          this._aapt2Resolved = candidate;
          return candidate;
        }
      }
    }
    this._aapt2Resolved = null;
    return null;
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  _setState(state, error = null) {
    const previous = this._state;
    const previousError = this._error;
    this._error = state === 'error' ? error || 'unknown error' : null;
    this._state = state;
    if (previous !== state) {
      const suffix = state === 'error' ? `: ${this._error}` : '';
      this._pushLog(`[vm] state ${previous} -> ${state}${suffix}`);
    } else if (state === 'error' && this._error !== previousError) {
      this._pushLog(`[vm] error: ${this._error}`);
    }
  }

  _snapshot() {
    return {
      state: this._state,
      serial: this._serialActive || null,
      avd: this._state === 'stopped' ? null : this.avdName || null,
      external: this._external === true,
      externalSerial: this._externalSerial || null,
      managedAvd: this._managedAvdName || null,
      bootMs: this._bootMs,
      bootKind: this._bootKind,
      quickBoot: this.quickBoot,
      snapshotName: this.snapshotName,
      snapshotAvailable: this._snapshotAvailable === true || this._snapshotPresent(),
      gpuMode: this.gpuMode,
      accel: this._accelAvailable,
      root: this._root === true,
      debugPrepared: this._debugPrepared === true,
      debugToolkit: this._debugToolkitPath,
      identity: this._identity,
      error: this._error,
      logTail: this._logTail.slice(),
    };
  }

  _pushLog(line) {
    const text = String(line);
    for (const rawLine of splitLines(text)) {
      const entry = rawLine.trimEnd();
      if (!entry) continue;
      this._logTail.push(entry);
      if (this._logTail.length > this.maxLogLines) {
        this._logTail.splice(0, this._logTail.length - this.maxLogLines);
      }
      if (this.logSink) {
        try {
          this.logSink(entry);
        } catch {
          /* user log sink must not break the VM */
        }
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Process helpers
// -----------------------------------------------------------------------------

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve(true);
      return;
    }
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.once('exit', () => finish(true));
  });
}

function killProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* already dead */
  }
  if (IS_WIN && child.pid) {
    // argv array, no host shell; /T also reaps the emulator's qemu child.
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {});
    } catch {
      /* ignore */
    }
  }
}

export default AndroidVm;
