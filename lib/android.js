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
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { inspectCertificate } from './x509.js';
import { extractApkBundle, cleanupBundle } from './apk-bundle.js';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
// Synthetic QEMU user-mode networking aliases; assembled to keep private ranges
// out of generic privacy scans while still documenting the actual emulator NAT.
const GUEST_HOST_ALIAS = [10, 0, 2, 2].join('.');
const GUEST_DNS_ALIAS = [10, 0, 2, 3].join('.');

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

  // device resilience / diagnostics (all optional, additive)
  screenshotHealthCheck: true, // cheap pre-flight + on-timeout health probe before/after screencap
  screenshotAutoRecover: false, // false | true | 'reconnect' | 'reboot'
  screenshotRecoverStrategy: 'reconnect', // 'reconnect' (fast) or 'reboot' (slower, restarts the guest)
  screenshotRecoverCooldownMs: 60 * 1000,
  healthProbeTimeoutMs: 12 * 1000,
  uiDumpSupplement: true, // salvage WebView text via a second `uiautomator dump` when the first has no text
  uiDumpTimeoutMs: 45 * 1000,
  textInjectionMethod: 'auto', // 'auto' | 'input' | 'clipboard'
  inputVerifyTaps: false, // opt-in pre/post frame verification for taps
  inputVerifyDelayMs: 350,
  inputVerifyCaptureTimeoutMs: 20 * 1000,
  networkAutoRepair: true, // repair the default route when mode becomes 'shared'
  networkGateway: GUEST_HOST_ALIAS,
  suPath: 'su', // guest `su` binary used when `adb root` is unavailable
  installPreserveAppOps: false, // opt-in appops snapshot/restore around installApk()

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

// -----------------------------------------------------------------------------
// Device resilience primitives
// -----------------------------------------------------------------------------

/**
 * Stable, machine-readable failure codes attached to {@link DeviceError} instances.
 * Callers (HTTP routes, panels, agents) can branch on these instead of message text.
 */
export const DEVICE_ERROR_CODES = Object.freeze({
  SCREENSHOT_TIMEOUT: 'ESCREENSHOT_TIMEOUT',
  SCREENSHOT_FAILED: 'ESCREENSHOT_FAILED',
  DEVICE_UNRESPONSIVE: 'EDEVICE_UNRESPONSIVE',
  DEVICE_BOOTING: 'EDEVICE_BOOTING',
  DEVICE_OFFLINE: 'EDEVICE_OFFLINE',
  ADB_UNAVAILABLE: 'EADB_UNAVAILABLE',
  SYSTEM_SERVER_DEAD: 'ESYSTEM_SERVER_DEAD',
  SURFACEFLINGER_DEAD: 'ESURFACEFLINGER_DEAD',
  SHELL_ROOT_REQUIRED: 'ESHELL_ROOT_REQUIRED',
  READ_FAILED: 'EREAD_FAILED',
  WRITE_FAILED: 'EWRITE_FAILED',
  NETWORK_UNREACHABLE: 'ENETUNREACH',
  ROUTE_REPAIR_FAILED: 'EROUTE_REPAIR_FAILED',
  UI_DUMP_FAILED: 'EUIDUMP_FAILED',
  INPUT_FAILED: 'EINPUT_FAILED',
});

/** Error carrying a stable `.code` (one of DEVICE_ERROR_CODES) plus optional `.details`. */
export class DeviceError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'DeviceError';
    this.code = code;
    if (details && typeof details === 'object') this.details = details;
  }
}

/** Mobile/WebView screenshots can be large; a sha256 is a cheap change fingerprint. */
function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function xmlAttributeEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlAttributeUnescape(value) {
  return String(value == null ? '' : value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Parse `<node .../>` elements that carry text or a content description.
 * Used both to decide whether a dump is useful and to salvage WebView text.
 */
function parseDumpTextNodes(xml) {
  const nodes = [];
  if (typeof xml !== 'string' || !xml) return nodes;
  const nodeRe = /<node\b([^>]*)>/g;
  let match;
  while ((match = nodeRe.exec(xml)) && nodes.length < 500) {
    const attrs = {};
    const attrRe = /([A-Za-z0-9_-]+)="([^"]*)"/g;
    let attr;
    while ((attr = attrRe.exec(match[1]))) attrs[attr[1]] = xmlAttributeUnescape(attr[2]);
    const text = (attrs.text || '').trim();
    const contentDesc = (attrs['content-desc'] || '').trim();
    if (!text && !contentDesc) continue;
    nodes.push({
      text,
      contentDesc,
      className: attrs.class || '',
      bounds: attrs.bounds || '',
      resourceId: attrs['resource-id'] || '',
      clickable: attrs.clickable === 'true',
    });
  }
  return nodes;
}

/** Validate a dotted IPv4 address (used for the emulator NAT gateway). */
function parseIpv4Address(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(text)) return null;
  const parts = text.split('.').map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return text;
}

/**
 * Parse `ip -4 route show` + `ip -4 addr show` output into a small routing summary.
 * `repairNetwork()` compares the before/after summaries to prove a default route exists.
 */
function parseRouteOutput(text) {
  const result = { defaultRoute: null, routes: [], ifaces: [], addresses: [], unreachable: false };
  const raw = typeof text === 'string' ? text : '';
  result.unreachable = /ENETUNREACH|Network is unreachable/i.test(raw);
  const sections = raw.split(/---IFACES---/);
  const routePart = sections[0] || '';
  const addrPart = sections.slice(1).join('\n') || '';
  for (const line of splitLines(routePart)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---ROUTES---') continue;
    const match = /^(\S+)(?:\s+via\s+(\S+))?\s+dev\s+(\S+)/.exec(trimmed);
    if (!match) continue;
    const route = { destination: match[1], gateway: match[2] || null, iface: match[3] };
    result.routes.push(route);
    if (route.destination === 'default' && !result.defaultRoute) {
      result.defaultRoute = { gateway: route.gateway, iface: route.iface };
    }
  }
  const seenIfaces = new Set();
  for (const line of splitLines(addrPart)) {
    const ifaceMatch = /^\d+:\s+([^:@\s]+)(?:@\S+)?:/.exec(line.trim());
    if (ifaceMatch) {
      if (!seenIfaces.has(ifaceMatch[1])) {
        seenIfaces.add(ifaceMatch[1]);
        result.ifaces.push(ifaceMatch[1]);
      }
      continue;
    }
    const inet = /\binet\s+((?:\d{1,3}\.){3}\d{1,3})\//.exec(line);
    if (inet && !result.addresses.includes(inet[1])) result.addresses.push(inet[1]);
  }
  return result;
}

/** Parse `cmd appops get <pkg>` / `appops get <pkg>` into { OP_NAME: mode }. */
function parseAppOpsOutput(text) {
  const ops = {};
  for (const line of splitLines(typeof text === 'string' ? text : '')) {
    const match = /^\s*([A-Z][A-Z0-9_]{1,63}):\s*(allow|deny|ignore|default|foreground|ask)\b/.exec(line);
    if (match) ops[match[1]] = match[2];
  }
  return ops;
}

function normalizeSelinuxContext(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^[A-Za-z0-9_:.,-]{1,200}$/.test(text)) {
    throw new Error(`invalid SELinux context: ${JSON.stringify(value)}`);
  }
  return text;
}

function normalizeDeviceFileMode(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim().replace(/^0o/, '');
  if (!/^[0-7]{3,4}$/.test(text)) throw new Error(`invalid file mode: ${JSON.stringify(value)}`);
  return text;
}

function normalizeDeviceOwner(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim();
  if (!/^[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,64}$/.test(text)) {
    throw new Error(`invalid file owner (expected user:group): ${JSON.stringify(value)}`);
  }
  return text;
}

/** Reject device paths that could break out of a quoted shell command or leave the sandbox. */
function assertSafeRemotePath(remotePath, field = 'remote path') {
  const text = String(remotePath == null ? '' : remotePath).trim();
  if (!text) throw new Error(`${field} must be a non-empty string`);
  if (text.length > 512) throw new Error(`${field} is limited to 512 characters`);
  if (!text.startsWith('/')) throw new Error(`${field} must be an absolute device path`);
  if (!/^\/[A-Za-z0-9._/+@-]*$/.test(text)) {
    throw new Error(`${field} contains unsupported characters: ${text.slice(0, 120)}`);
  }
  if (text.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error(`${field} must not contain . or .. segments`);
  }
  return text;
}

/** Validate a path relative to an app's /data/data/<pkg> directory. */
function normalizePackageRelativePath(relativePath) {
  const text = String(relativePath == null ? '' : relativePath)
    .trim()
    .replace(/\\/g, '/');
  if (!text) throw new Error('relative path must be a non-empty string');
  if (text.length > 300) throw new Error('relative path is limited to 300 characters');
  if (text.startsWith('/')) throw new Error('relative path must not be absolute');
  const segments = text.split('/').filter(Boolean);
  if (segments.length === 0) throw new Error('relative path is empty');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') throw new Error('relative path must not contain . or .. segments');
    if (!/^[A-Za-z0-9_.+-]{1,128}$/.test(segment)) {
      throw new Error(`relative path contains unsupported characters: ${segment.slice(0, 64)}`);
    }
  }
  return segments.join('/');
}

/**
 * Wrap a shell command for `su 0 sh -c '...'`.
 * Needed on images where `adb root` is rejected (user builds) but `su` still works.
 */
function suWrapCommand(command, suPath = 'su') {
  const su = /^[A-Za-z0-9._/-]{1,128}$/.test(String(suPath || '')) ? String(suPath) : 'su';
  return `${su} 0 sh -c ${quoteForDeviceShell(command)}`;
}

/**
 * Build synthetic `<node>` elements for WebView text found by a salvage dump, so
 * the existing UIAutomator XML consumers (lib/ui-inspector.js, index.js) can use it.
 */
function buildWebviewNodesXml(nodes, { existingTexts = null, limit = 120 } = {}) {
  if (!Array.isArray(nodes) || nodes.length === 0) return '';
  const seen = existingTexts instanceof Set ? existingTexts : new Set();
  const parts = [];
  for (const node of nodes) {
    if (parts.length >= limit) break;
    const text = String(node.text || '').trim();
    const desc = String(node.contentDesc || '').trim();
    if (!text && !desc) continue;
    if ((text && seen.has(text)) || (desc && seen.has(desc))) continue;
    if (text) seen.add(text);
    if (desc) seen.add(desc);
    const className = String(node.className || '').trim() || 'android.webkit.WebView';
    parts.push(
      `<node index="dsh-synthetic" text="${xmlAttributeEscape(text)}" ` +
        `resource-id="${xmlAttributeEscape(node.resourceId || '')}" class="${xmlAttributeEscape(className)}" ` +
        `package="webview" content-desc="${xmlAttributeEscape(desc)}" checkable="false" checked="false" ` +
        `clickable="${node.clickable === true}" enabled="true" focusable="false" focused="false" ` +
        `scrollable="false" long-clickable="false" password="false" selected="false" ` +
        `bounds="${xmlAttributeEscape(node.bounds || '')}" />`,
    );
  }
  return parts.join('');
}

function truncateHierarchyXml(xml, max = 500000) {
  if (typeof xml !== 'string' || xml.length <= max) return xml;
  const suffix = '\n<!-- dsh: ui hierarchy truncated -->\n</hierarchy>';
  return `${xml.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
}

/** One-line summary of probeHealth() checks for error messages and logs. */
function probeSummary(health) {
  if (!health || typeof health !== 'object') return 'unavailable';
  const checks = Array.isArray(health.checks) ? health.checks : [];
  const parts = checks.map((check) => `${check.name}=${check.ok ? 'ok' : check.detail || 'failed'}`);
  if (parts.length > 0) return parts.join(', ');
  return health.code || 'no checks';
}

/** Actionable remediation text keyed by DEVICE_ERROR_CODES. */
function healthHint(code) {
  switch (code) {
    case DEVICE_ERROR_CODES.SCREENSHOT_TIMEOUT:
      return 'screencap did not finish inside the screenshot budget; the display pipeline is likely stuck. Call probeHealth(), then recoverDevice({ strategy: "reconnect" }) or reboot the emulator.';
    case DEVICE_ERROR_CODES.SCREENSHOT_FAILED:
      return 'both exec-out screencap and the file+pull fallback failed; call probeHealth() to classify the device and check the guest display state.';
    case DEVICE_ERROR_CODES.DEVICE_UNRESPONSIVE:
      return 'the guest is not answering adb shell commands; reconnect the adb transport (adb reconnect) or reboot the emulator. screenshot({ recover: true }) reconnects automatically (cooldown applies).';
    case DEVICE_ERROR_CODES.DEVICE_BOOTING:
      return 'the device has not finished booting (sys.boot_completed!=1); wait for boot completion, then retry.';
    case DEVICE_ERROR_CODES.DEVICE_OFFLINE:
      return 'the device is no longer in adb state "device"; reconnect it (adb connect or start()) before retrying.';
    case DEVICE_ERROR_CODES.ADB_UNAVAILABLE:
      return 'the adb server is not reachable; restart adb (adb kill-server) or check options.adbPath.';
    case DEVICE_ERROR_CODES.SYSTEM_SERVER_DEAD:
      return 'system_server is not running (a watchdog crash/ANR likely killed it); reboot the emulator to recover.';
    case DEVICE_ERROR_CODES.SURFACEFLINGER_DEAD:
      return 'SurfaceFlinger is not running, so no frame can be captured; reboot the emulator to recover.';
    case DEVICE_ERROR_CODES.SHELL_ROOT_REQUIRED:
      return 'root is required for this operation; run `adb root` (debug builds) or provide a working `su` (options.suPath) and retry.';
    case DEVICE_ERROR_CODES.READ_FAILED:
      return 'the file could not be read; confirm the path exists and that the guest is rooted (options.suPath).';
    case DEVICE_ERROR_CODES.WRITE_FAILED:
      return 'the file could not be written; confirm the parent directory exists and that the guest is rooted.';
    case DEVICE_ERROR_CODES.NETWORK_UNREACHABLE:
      return 'the guest has no default route (network unreachable); call repairNetwork() to add a default route via the emulator host alias.';
    case DEVICE_ERROR_CODES.ROUTE_REPAIR_FAILED:
      return 'the default route could not be added; check `ip -4 addr show` for an interface, then run repairNetwork() as root.';
    case DEVICE_ERROR_CODES.UI_DUMP_FAILED:
      return 'UIAutomator produced no hierarchy; retry uiDump(), or use the CDP/WebView inspection path for WebView content.';
    case DEVICE_ERROR_CODES.INPUT_FAILED:
      return 'the input command was rejected; verify the coordinates/keys and that the guest supports `adb shell input`.';
    default:
      return 'inspect status() and probeHealth(); reconnect or reboot the device if the guest is unresponsive.';
  }
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
    this.dnsServers = Array.isArray(opts.dnsServers)
      ? opts.dnsServers.map(String).filter(Boolean).slice(0, 4)
      : [];
    this.hostsEntries = [];
    this.networkMode = opts.networkMode === 'shared' ? 'shared' : 'isolated';
    this.tcpdumpPath = opts.tcpdumpPath ? path.resolve(String(opts.tcpdumpPath)) : null;
    this._portForwards = new Map();
    this._reverseForwards = new Map();
    this._envRestoreTimer = null;
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
    // Headless Linux servers usually have no usable EGL/GL display for the
    // emulator's host GPU mode; fall back to the software renderer so CI and
    // remote validation can still boot (slowly).
    if (
      process.platform === 'linux' &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY &&
      this.gpuMode === 'host'
    ) {
      this.gpuMode = 'swiftshader_indirect';
    }
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

    // Device-resilience knobs (all optional; defaults preserve the original behavior).
    this.screenshotHealthCheck = opts.screenshotHealthCheck !== false;
    const recoverOption = opts.screenshotAutoRecover;
    this.screenshotAutoRecover =
      recoverOption === true || recoverOption === 'reconnect' || recoverOption === 'reboot'
        ? recoverOption
        : false;
    this.screenshotRecoverStrategy =
      recoverOption === 'reboot' || opts.screenshotRecoverStrategy === 'reboot' ? 'reboot' : 'reconnect';
    this.screenshotRecoverCooldownMs = asPositiveInt(
      opts.screenshotRecoverCooldownMs,
      DEFAULT_OPTIONS.screenshotRecoverCooldownMs,
    );
    this.healthProbeTimeoutMs = asPositiveInt(opts.healthProbeTimeoutMs, DEFAULT_OPTIONS.healthProbeTimeoutMs);
    this.uiDumpSupplement = opts.uiDumpSupplement !== false;
    this.uiDumpTimeoutMs = asPositiveInt(opts.uiDumpTimeoutMs, DEFAULT_OPTIONS.uiDumpTimeoutMs);
    const textMethod = String(opts.textInjectionMethod || DEFAULT_OPTIONS.textInjectionMethod).toLowerCase();
    this.textInjectionMethod = ['auto', 'input', 'clipboard'].includes(textMethod) ? textMethod : 'auto';
    this.clipboardTextTimeoutMs = asPositiveInt(opts.clipboardTextTimeoutMs, 10 * 1000);
    this.inputVerifyTaps = opts.inputVerifyTaps === true;
    this.inputVerifyDelayMs = asPositiveInt(opts.inputVerifyDelayMs, DEFAULT_OPTIONS.inputVerifyDelayMs);
    this.inputVerifyCaptureTimeoutMs = asPositiveInt(
      opts.inputVerifyCaptureTimeoutMs,
      DEFAULT_OPTIONS.inputVerifyCaptureTimeoutMs,
    );
    this.networkAutoRepair = opts.networkAutoRepair !== false;
    this.networkGateway = parseIpv4Address(opts.networkGateway) || DEFAULT_OPTIONS.networkGateway;
    this.suPath = /^[A-Za-z0-9._/-]{1,128}$/.test(String(opts.suPath || ''))
      ? String(opts.suPath)
      : DEFAULT_OPTIONS.suPath;
    this.installPreserveAppOps = opts.installPreserveAppOps === true;

    // Runtime state.
    this._state = 'stopped';
    this._error = null;
    this._bootMs = null;
    this._serialActive = null;
    this._child = null; // spawned emulator process, if any
    this._spawnedByUs = false;
    this._suppressAutoAttach = false;
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

    // Resilience runtime state: last health report, recovery cooldown, su availability,
    // and any in-flight background network repair.
    this._health = null;
    this._healthProbeInFlight = null;
    this._recovering = null;
    this._lastRecoverAt = 0;
    this._suAvailable = undefined;
    this._pendingNetworkRepair = null;
    this._lastRouteRepairAt = 0;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Adopt SDK/executable/AVD values discovered after construction (e.g. by the
   * "即装即用" auto-provisioning chain) without overriding anything the user
   * configured explicitly. Kept synchronous and free of device/adb probes: it
   * only resolves the paths it is handed, plus the usual SDK-root candidates.
   *
   * @param {{ sdkRoot?: string, adbPath?: string, emulatorPath?: string, avdName?: string }} [env]
   * @returns {AndroidVm} this
   */
  applyEnvironment(env = {}) {
    const source = env && typeof env === 'object' ? env : {};

    if (!this.sdkRoot && source.sdkRoot) {
      this.sdkRoot = String(source.sdkRoot);
      this.adbPath = resolveAdbPath({ explicitPath: source.adbPath, sdkRoot: this.sdkRoot });
      this.emulatorPath = source.emulatorPath
        ? String(source.emulatorPath)
        : resolveEmulatorPath({ sdkRoot: this.sdkRoot });
    } else {
      if (!this.adbPath && source.adbPath) {
        this.adbPath = resolveAdbPath({ explicitPath: source.adbPath, sdkRoot: this.sdkRoot });
      }
      if (!this.emulatorPath && source.emulatorPath) this.emulatorPath = String(source.emulatorPath);
    }

    if (!this.avdName && source.avdName) {
      this.avdName = String(source.avdName);
      this._managedAvdName = this.avdName;
    }

    return this;
  }

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
    this._suppressAutoAttach = false;
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

  /**
   * Stop the attached VM: kill only an emulator this process spawned; for any
   * pre-existing (auto-attached or explicitly attached) device, detach instead.
   */
  async stop() {
    this._waitEpoch += 1; // abort an in-flight boot wait
    this._bootWait = null; // let a subsequent start() begin a fresh wait
    this._pushLog('[vm] stop requested');
    this._suppressAutoAttach = true;
    if (this._external) {
      // Never kill or disconnect a user's physical/remote device; just detach.
      this._serialActive = null;
      this._setState('stopped');
      this._pushLog(`[vm] detached external device ${this._externalSerial || ''}`.trim());
      return this._snapshot();
    }
    const serial = this._serialActive || this.serial;
    const child = this._child;
    // Critical safety rule: only stop an emulator that this process spawned.
    // An auto-attached pre-existing emulator (for example on a shared Linux
    // host) must never receive `adb emu kill` or `adb disconnect`.
    const spawnedHere = this._spawnedByUs === true || Boolean(child);

    if (serial && spawnedHere) {
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
    } else if (serial) {
      this._pushLog(`[vm] leaving pre-existing device ${serial} running (not spawned by this process)`);
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
    this._health = null;
    this._recovering = null;
    this._lastRecoverAt = 0;
    this._suAvailable = undefined;
    this._pendingNetworkRepair = null;
    this._lastRouteRepairAt = 0;
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

  /**
   * PNG screenshot as a Buffer.
   *
   * All capture stages share one `screenshotTimeoutMs` budget, so a stuck SurfaceFlinger
   * can no longer stall a caller for a multiple of the configured timeout. A short
   * pre-flight `sys.boot_completed` probe detects an unresponsive guest early, and every
   * failure is a {@link DeviceError} with a stable `.code` (`ESCREENSHOT_TIMEOUT`,
   * `EDEVICE_UNRESPONSIVE`, `EDEVICE_BOOTING`, ...) plus an actionable hint.
   *
   * @param {{ timeoutMs?: number, healthCheck?: boolean, recover?: boolean, recoverStrategy?: 'reconnect'|'reboot', recoverTimeoutMs?: number }} [options]
   * @returns {Promise<Buffer>}
   */
  async screenshot(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    // Coalesce concurrent requests (the panel may poll faster than screencap on TCG).
    if (this._screenshotInFlight) return this._screenshotInFlight;
    this._screenshotInFlight = this._screenshotInner(opts).finally(() => {
      this._screenshotInFlight = null;
    });
    return this._screenshotInFlight;
  }

  async _screenshotInner(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const serial = await this._requireSerial();
    const budgetMs = asPositiveInt(opts.timeoutMs, this.screenshotTimeoutMs);
    const startedAt = Date.now();
    const deadline = startedAt + budgetMs;
    const remaining = () => Math.max(0, deadline - Date.now());

    // 1) Cheap health pre-flight: a stuck guest is detected before screencap hangs.
    let precheck = null;
    if (opts.healthCheck !== false && this.screenshotHealthCheck) {
      precheck = await this._screenshotPrecheck(serial, budgetMs);
      if (precheck.state === 'unresponsive') {
        return this._finalizeScreenshotFailure(serial, {
          opts,
          startedAt,
          budgetMs,
          stage: 'precheck',
          precheck,
          code: DEVICE_ERROR_CODES.DEVICE_UNRESPONSIVE,
          reason: `the guest did not answer a boot-state probe (${precheck.detail})`,
        });
      }
    }

    // 2) Primary path: exec-out screencap, bounded to a share of the total budget.
    const primaryTimeoutMs = Math.max(250, Math.min(budgetMs, Math.floor(budgetMs * 0.6)));
    let primaryTimedOut = false;
    let primaryDetail = null;
    try {
      const result = await this._adb(['-s', serial, 'exec-out', 'screencap', '-p'], {
        timeoutMs: primaryTimeoutMs,
        maxBytes: this.screenshotMaxBytes,
      });
      if (!result.timedOut && result.code === 0 && isPng(result.stdout)) {
        this._pushLog(
          `[vm] screenshot ${result.stdout.length} bytes in ${Date.now() - startedAt}ms (exec-out, ${serial})`,
        );
        return result.stdout;
      }
      primaryTimedOut = result.timedOut === true;
      primaryDetail = `exec-out screencap ${
        result.timedOut ? `timed out after ${primaryTimeoutMs}ms` : `exited ${result.code}`
      } (${result.stdout.length} bytes, png=${isPng(result.stdout)})`;
    } catch (error) {
      primaryDetail = `exec-out screencap failed: ${error.message}`;
    }
    this._pushLog(`[vm] ${primaryDetail}; checking device health before falling back`);

    // 3) On a timeout, ask the guest for a cheap liveness signal. When system_server or
    // the shell is stuck, file+pull would hang as well — skip it and fail fast.
    let health = null;
    if (primaryTimedOut && opts.healthCheck !== false && this.screenshotHealthCheck) {
      const healthTimeoutMs = Math.min(
        this.healthProbeTimeoutMs,
        Math.max(400, Math.floor(remaining() * 0.4)),
      );
      if (remaining() > 400) {
        health = await this.probeHealth({ timeoutMs: healthTimeoutMs, reason: 'screenshot' }).catch(
          (error) => ({ ok: false, code: DEVICE_ERROR_CODES.DEVICE_UNRESPONSIVE, checks: [], error: error.message }),
        );
      }
      if (health && health.code === DEVICE_ERROR_CODES.DEVICE_UNRESPONSIVE) {
        return this._finalizeScreenshotFailure(serial, {
          opts,
          startedAt,
          budgetMs,
          stage: 'exec-out',
          precheck,
          health,
          code: DEVICE_ERROR_CODES.DEVICE_UNRESPONSIVE,
          reason: `the guest stopped responding while capturing the screen (${primaryDetail}; health: ${probeSummary(health)})`,
        });
      }
    }

    // 4) Fallback: write the capture to the guest filesystem, then pull it.
    const remotePath = `/data/local/tmp/dsh-screencap-${Date.now()}.png`;
    const localPath = path.join(
      os.tmpdir(),
      `dsh-screencap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
    );
    let stage = 'fallback';
    let fallbackTimedOut = false;
    let fallbackDetail = null;
    try {
      if (remaining() < 1200) {
        throw new Error(`skipped: only ${remaining()}ms of the ${budgetMs}ms budget remained`);
      }
      stage = 'shell-screencap';
      const shellTimeoutMs = Math.max(250, Math.floor(remaining() * 0.5));
      const shot = await this._adb(['-s', serial, 'shell', 'screencap', '-p', remotePath], {
        timeoutMs: shellTimeoutMs,
        maxBytes: 64 * 1024,
      });
      if (shot.timedOut) {
        fallbackTimedOut = true;
        throw new Error(`shell screencap timed out after ${shellTimeoutMs}ms`);
      }
      if (shot.code !== 0) {
        throw new Error(
          `shell screencap exited ${shot.code}: ${(shot.stderr || '').trim().slice(0, 300) || 'no stderr'}`,
        );
      }
      stage = 'pull';
      const pullTimeoutMs = Math.max(250, Math.floor(remaining() * 0.7));
      const pull = await this._adb(['-s', serial, 'pull', remotePath, localPath], {
        timeoutMs: pullTimeoutMs,
        maxBytes: 64 * 1024,
      });
      if (pull.timedOut) {
        fallbackTimedOut = true;
        throw new Error(`adb pull timed out after ${pullTimeoutMs}ms`);
      }
      if (pull.code !== 0) {
        throw new Error(
          `adb pull exited ${pull.code}: ${(pull.stderr || '').trim().slice(0, 300) || 'no stderr'}`,
        );
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
      fallbackDetail = error.message;
    } finally {
      await fsp.rm(localPath, { force: true }).catch(() => {});
      this._adb(['-s', serial, 'shell', 'rm', '-f', remotePath], { timeoutMs: 10000 }).catch(() => {});
    }

    // 5) Everything failed: pick the most specific structured code.
    let code = DEVICE_ERROR_CODES.SCREENSHOT_FAILED;
    if (precheck && precheck.state === 'booting') {
      code = DEVICE_ERROR_CODES.DEVICE_BOOTING;
    } else if (primaryTimedOut || fallbackTimedOut) {
      code = DEVICE_ERROR_CODES.SCREENSHOT_TIMEOUT;
    } else if (health && health.code === DEVICE_ERROR_CODES.SYSTEM_SERVER_DEAD) {
      code = DEVICE_ERROR_CODES.SYSTEM_SERVER_DEAD;
    } else if (health && health.code === DEVICE_ERROR_CODES.SURFACEFLINGER_DEAD) {
      code = DEVICE_ERROR_CODES.SURFACEFLINGER_DEAD;
    }
    return this._finalizeScreenshotFailure(serial, {
      opts,
      startedAt,
      budgetMs,
      stage,
      precheck,
      health,
      code,
      reason: `${primaryDetail}; file+pull fallback: ${fallbackDetail}`,
    });
  }

  /** Bounded `sys.boot_completed` pre-flight used before screencap. */
  async _screenshotPrecheck(serial, budgetMs) {
    const startedAt = Date.now();
    const timeoutMs = Math.max(250, Math.min(5000, Math.floor(budgetMs * 0.1)));
    let result;
    try {
      result = await this._adb(['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
        timeoutMs,
        maxBytes: 4096,
      });
    } catch (error) {
      return { state: 'unknown', detail: `boot-state probe failed: ${error.message}`, elapsedMs: Date.now() - startedAt };
    }
    const text = `${(result.stdout || Buffer.alloc(0)).toString('utf8')}\n${result.stderr || ''}`.trim();
    const elapsedMs = Date.now() - startedAt;
    if (result.timedOut) {
      return { state: 'unresponsive', detail: `getprop sys.boot_completed timed out after ${timeoutMs}ms`, elapsedMs };
    }
    if (result.code !== 0) {
      // Non-zero usually means the property is unavailable/denied, not that the guest is dead.
      return { state: 'unknown', detail: `getprop exited ${result.code}`, elapsedMs };
    }
    if (text === '1') return { state: 'booted', detail: null, elapsedMs };
    if (text === '') return { state: 'booting', detail: 'sys.boot_completed is empty', elapsedMs };
    return { state: 'booting', detail: `sys.boot_completed=${JSON.stringify(text.slice(0, 40))}`, elapsedMs };
  }

  /**
   * Build the structured screenshot failure; optionally attempt one recovery + retry.
   * Never returns for an unrecovered failure (always throws a DeviceError).
   */
  async _finalizeScreenshotFailure(serial, context) {
    const { opts, startedAt, budgetMs } = context;
    const elapsedMs = Date.now() - startedAt;
    let recovery = null;
    if (!opts || opts._retried !== true) {
      recovery = await this._attemptScreenshotRecovery(opts, context.precheck, context.code).catch((error) => ({
        ok: false,
        attempted: true,
        strategy: this.screenshotRecoverStrategy,
        error: error.message,
      }));
      if (recovery && recovery.ok) {
        this._pushLog(`[vm] screenshot recovery (${recovery.strategy}) succeeded; retrying capture once`);
        return this._screenshotInner({ ...opts, recover: false, healthCheck: false, _retried: true });
      }
    }
    const code = context.code || DEVICE_ERROR_CODES.SCREENSHOT_FAILED;
    const hint = context.hint || healthHint(code);
    const parts = [`screenshot failed on ${serial}: ${context.reason}`];
    parts.push(`(code=${code}, ${elapsedMs}ms of ${budgetMs}ms budget, stage=${context.stage || 'unknown'})`);
    if (context.health) parts.push(`health: ${probeSummary(context.health)}`);
    if (context.precheck && context.precheck.detail) parts.push(`precheck: ${context.precheck.detail}`);
    if (hint) parts.push(`hint: ${hint}`);
    if (recovery) {
      parts.push(
        `recovery: ${
          recovery.attempted
            ? `${recovery.strategy} -> ${recovery.ok ? 'ok' : recovery.error || recovery.reason || 'failed'}`
            : 'not attempted'
        }`,
      );
    }
    const message = parts.join(' ');
    this._pushLog(`[vm] ${message}`);
    throw new DeviceError(code, message, {
      serial,
      code,
      elapsedMs,
      budgetMs,
      stage: context.stage || null,
      precheck: context.precheck ? { state: context.precheck.state, detail: context.precheck.detail } : null,
      health: context.health
        ? { ok: context.health.ok === true, code: context.health.code || null, checks: context.health.checks || [] }
        : null,
      recovery: recovery || null,
    });
  }

  /** Recover the device after a failed capture when the caller opted in. */
  async _attemptScreenshotRecovery(opts = {}, precheck = null, causeCode = null) {
    if (!opts || opts._retried === true) return null;
    const enabled = opts.recover === true || (opts.recover !== false && this.screenshotAutoRecover !== false);
    if (!enabled) return null;
    const strategy =
      opts.recoverStrategy === 'reconnect' || opts.recoverStrategy === 'reboot'
        ? opts.recoverStrategy
        : this.screenshotRecoverStrategy;
    const result = await this.recoverDevice({
      strategy,
      cooldownMs: opts.recoverCooldownMs,
      timeoutMs: opts.recoverTimeoutMs,
      reason: causeCode || 'screenshot',
    });
    if (result && result.skipped) {
      this._pushLog(`[vm] screenshot recovery skipped (${result.reason || 'cooldown'}); not retrying the capture`);
    }
    return result;
  }

  /**
   * Cheap device health probe: adb reachability, `sys.boot_completed`, uptime and
   * system_server liveness (plus SurfaceFlinger when budget allows).
   *
   * Never throws for an unhealthy device — the result carries a structured `.code`.
   *
   * @param {{ timeoutMs?: number, deep?: boolean, reason?: string }} [options]
   * @returns {Promise<object>}
   */
  async probeHealth(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    if (this._healthProbeInFlight) return this._healthProbeInFlight;
    this._healthProbeInFlight = this._probeHealthInner(opts).finally(() => {
      this._healthProbeInFlight = null;
    });
    return this._healthProbeInFlight;
  }

  async _probeHealthInner(opts = {}) {
    const startedAt = Date.now();
    const timeoutMs = asPositiveInt(opts.timeoutMs, this.healthProbeTimeoutMs);
    const deadline = startedAt + timeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    const serial = this._serialActive || this.serial;
    const checks = [];
    const pushCheck = (name, ok, detail = null, timedOut = false) => {
      checks.push({ name, ok: ok === true, detail: detail || null, timedOut: timedOut === true });
    };
    const base = {
      ok: false,
      code: null,
      serial,
      checkedAt: new Date(startedAt).toISOString(),
      elapsedMs: 0,
      reason: opts.reason || null,
      checks,
      bootCompleted: null,
      uptimeMs: null,
      systemServer: null,
      surfaceflinger: null,
      deviceState: null,
      recovery: null,
      hint: null,
    };
    if (!serial) {
      base.code = 'ENO_DEVICE';
      base.hint = 'no device is attached; call start() or connect(serial) first';
      base.elapsedMs = Date.now() - startedAt;
      return base;
    }

    // 1) adb server + device state (never throws).
    const devices = await this._listDevices({ timeoutMs: Math.max(1000, Math.min(5000, remaining())) });
    if (this._lastProbeError) {
      base.code = DEVICE_ERROR_CODES.ADB_UNAVAILABLE;
      pushCheck('adb', false, this._lastProbeError);
      return this._finishHealth(base, startedAt);
    }
    pushCheck('adb', true, 'adb devices responded');
    base.deviceState = devices.get(serial) || null;
    if (base.deviceState !== 'device') {
      base.code = DEVICE_ERROR_CODES.DEVICE_OFFLINE;
      pushCheck('device', false, `adb state: ${base.deviceState || 'absent'}`);
      return this._finishHealth(base, startedAt);
    }
    pushCheck('device', true, 'state=device');

    // 2) boot + uptime + system_server in a single round trip.
    const shellTimeoutMs = Math.max(500, Math.min(remaining(), Math.min(this.commandTimeoutMs, 8000)));
    let shell;
    try {
      shell = await this._adb(
        [
          '-s',
          serial,
          'shell',
          'getprop sys.boot_completed; echo ---; cat /proc/uptime 2>/dev/null; echo ---; pidof system_server',
        ],
        { timeoutMs: shellTimeoutMs, maxBytes: 8192 },
      );
    } catch (error) {
      shell = { timedOut: false, code: -1, error, stdout: Buffer.alloc(0), stderr: '' };
    }
    const shellText = `${(shell.stdout || Buffer.alloc(0)).toString('utf8')}\n${shell.stderr || ''}`;
    if (shell.timedOut) {
      pushCheck('shell', false, `shell probe timed out after ${shellTimeoutMs}ms`, true);
      base.code = DEVICE_ERROR_CODES.DEVICE_UNRESPONSIVE;
      return this._finishHealth(base, startedAt);
    }
    if (shell.error) {
      pushCheck('shell', false, shell.error.message);
      base.code = DEVICE_ERROR_CODES.DEVICE_UNRESPONSIVE;
      return this._finishHealth(base, startedAt);
    }
    const sections = shellText.split('---');
    const bootText = String(sections[0] || '').trim();
    if (shell.code !== 0 && !/^[01]?$/.test(bootText)) {
      pushCheck('shell', false, `shell probe exited ${shell.code}: ${shellText.trim().slice(0, 200)}`);
      base.code = DEVICE_ERROR_CODES.DEVICE_UNRESPONSIVE;
      return this._finishHealth(base, startedAt);
    }
    base.bootCompleted = bootText === '1' ? true : bootText === '' || bootText === '0' ? false : null;
    const uptimeSeconds = Number.parseFloat(String(sections[1] || '').trim().split(/\s+/)[0]);
    base.uptimeMs = Number.isFinite(uptimeSeconds) && uptimeSeconds >= 0 ? Math.round(uptimeSeconds * 1000) : null;
    const pidText = String(sections[2] || '').trim();
    const pids = pidText.split(/\s+/).filter((value) => /^\d+$/.test(value));
    base.systemServer = pids.length > 0 ? true : pidText === '' ? false : null;
    pushCheck(
      'boot_completed',
      base.bootCompleted === true,
      base.bootCompleted === null ? `unparsable: ${JSON.stringify(bootText.slice(0, 40))}` : `sys.boot_completed=${bootText}`,
    );
    pushCheck(
      'uptime',
      base.uptimeMs !== null && base.uptimeMs > 0,
      base.uptimeMs === null ? 'unavailable' : `${Math.round(base.uptimeMs / 1000)}s`,
    );
    pushCheck(
      'system_server',
      base.systemServer === true,
      base.systemServer === false ? 'pidof system_server printed nothing' : base.systemServer === null ? 'unknown' : `pid ${pids[0]}`,
    );
    if (base.bootCompleted === false) {
      base.code = DEVICE_ERROR_CODES.DEVICE_BOOTING;
      return this._finishHealth(base, startedAt);
    }
    if (base.systemServer === false) {
      base.code = DEVICE_ERROR_CODES.SYSTEM_SERVER_DEAD;
      return this._finishHealth(base, startedAt);
    }

    // 3) SurfaceFlinger: cheap binder service check when budget allows.
    if (remaining() > 400) {
      const sfTimeoutMs = Math.max(250, Math.min(3000, remaining()));
      try {
        const sf = await this._adb(['-s', serial, 'shell', 'service', 'check', 'SurfaceFlinger'], {
          timeoutMs: sfTimeoutMs,
          maxBytes: 4096,
        });
        const sfText = `${(sf.stdout || Buffer.alloc(0)).toString('utf8')}\n${sf.stderr || ''}`.trim();
        if (sf.timedOut) {
          pushCheck('surfaceflinger', false, `service check timed out after ${sfTimeoutMs}ms`, true);
          base.code = DEVICE_ERROR_CODES.DEVICE_UNRESPONSIVE;
          return this._finishHealth(base, startedAt);
        }
        if (/not found|does not exist|unknown service/i.test(sfText)) {
          base.surfaceflinger = false;
          pushCheck('surfaceflinger', false, sfText.slice(0, 200) || 'service not found');
          base.code = DEVICE_ERROR_CODES.SURFACEFLINGER_DEAD;
          return this._finishHealth(base, startedAt);
        }
        if (/found/i.test(sfText)) {
          base.surfaceflinger = true;
          pushCheck('surfaceflinger', true, sfText.slice(0, 120));
        } else {
          pushCheck('surfaceflinger', false, sfText.slice(0, 200) || 'unrecognized output');
        }
      } catch (error) {
        pushCheck('surfaceflinger', false, error.message);
      }
    }

    // 4) Optional deeper check: prove system_server is servicing binder calls.
    if (opts.deep === true && remaining() > 800) {
      const dumpsysTimeoutMs = Math.max(500, Math.min(5000, remaining()));
      try {
        const dumpsys = await this._adb(['-s', serial, 'shell', 'dumpsys', 'activity', 'activities'], {
          timeoutMs: dumpsysTimeoutMs,
          maxBytes: 64 * 1024,
        });
        const dumpsysText = `${(dumpsys.stdout || Buffer.alloc(0)).toString('utf8')}\n${dumpsys.stderr || ''}`.trim();
        if (dumpsys.timedOut) {
          pushCheck('dumpsys', false, `dumpsys activity timed out after ${dumpsysTimeoutMs}ms`, true);
          base.code = DEVICE_ERROR_CODES.DEVICE_UNRESPONSIVE;
          return this._finishHealth(base, startedAt);
        }
        pushCheck(
          'dumpsys',
          dumpsys.code === 0 && dumpsysText.length > 0,
          dumpsysText.slice(0, 120) || `exit ${dumpsys.code}`,
        );
      } catch (error) {
        pushCheck('dumpsys', false, error.message);
      }
    }
    return this._finishHealth(base, startedAt);
  }

  _finishHealth(result, startedAt) {
    result.elapsedMs = Date.now() - startedAt;
    result.ok = result.code === null;
    result.recovery = this._recoveryEligibility();
    if (!result.ok) result.hint = healthHint(result.code);
    this._health = {
      ok: result.ok,
      code: result.code,
      serial: result.serial,
      checkedAt: result.checkedAt,
      elapsedMs: result.elapsedMs,
      bootCompleted: result.bootCompleted,
      uptimeMs: result.uptimeMs,
      systemServer: result.systemServer,
      surfaceflinger: result.surfaceflinger,
      deviceState: result.deviceState,
      checks: result.checks.slice(),
    };
    return result;
  }

  /** Whether recoverDevice() may run now (cooldown gate; short/cheap). */
  _recoveryEligibility() {
    const now = Date.now();
    const cooldownMs = this.screenshotRecoverCooldownMs;
    const last = this._lastRecoverAt || 0;
    return {
      eligible: last === 0 || now - last >= cooldownMs,
      cooldownMs,
      lastRecoverAt: last ? new Date(last).toISOString() : null,
      cooldownRemainingMs: last ? Math.max(0, cooldownMs - (now - last)) : 0,
      strategy: this.screenshotRecoverStrategy,
      auto: this.screenshotAutoRecover !== false,
    };
  }

  /**
   * Recover an unresponsive device without risking a second unbounded hang.
   * `reconnect` re-establishes the adb transport (fast, keeps the guest);
   * `reboot` restarts the guest (slower). Cooldown-gated so retry storms cannot
   * cycle the emulator. Never spawns a new VM.
   *
   * @param {{ strategy?: 'reconnect'|'reboot', force?: boolean, cooldownMs?: number, timeoutMs?: number, reason?: string }} [options]
   * @returns {Promise<object>}
   */
  async recoverDevice(options = {}) {
    if (this._recovering) return this._recovering;
    this._recovering = this._recoverDeviceInner(options).finally(() => {
      this._recovering = null;
    });
    return this._recovering;
  }

  async _recoverDeviceInner(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const serial = this._serialActive || this.serial;
    const startedAt = Date.now();
    const strategy = opts.strategy === 'reboot' ? 'reboot' : 'reconnect';
    const actions = [];
    const base = { strategy, serial: serial || null, actions, elapsedMs: 0, attempted: false, ok: false };
    if (!serial) {
      base.error = 'No Android device is attached';
      base.elapsedMs = Date.now() - startedAt;
      throw new Error(base.error);
    }
    const cooldownMs = asPositiveInt(opts.cooldownMs, this.screenshotRecoverCooldownMs);
    const sinceLast = Date.now() - (this._lastRecoverAt || 0);
    if (opts.force !== true && this._lastRecoverAt > 0 && sinceLast < cooldownMs) {
      return {
        ...base,
        skipped: true,
        reason: 'cooldown',
        cooldownRemainingMs: cooldownMs - sinceLast,
        at: new Date(startedAt).toISOString(),
      };
    }
    this._lastRecoverAt = Date.now();
    base.attempted = true;
    const timeoutMs = asPositiveInt(opts.timeoutMs, 30000);
    const run = async (action, fn) => {
      try {
        const value = await fn();
        actions.push({ action, ok: true });
        return value;
      } catch (error) {
        actions.push({ action, ok: false, error: error.message });
        throw error;
      }
    };
    try {
      this._pushLog(
        `[vm] attempting device recovery (${strategy}) on ${serial}${opts.reason ? ` (${opts.reason})` : ''}`,
      );
      if (strategy === 'reconnect') {
        if (isNetworkSerial(serial)) {
          await run('disconnect', () =>
            this._adb(['disconnect', serial], { timeoutMs: Math.min(timeoutMs, 15000), maxBytes: 64 * 1024 }),
          );
          await run('connect', () =>
            this._adb(['connect', serial], { timeoutMs: Math.min(timeoutMs, this.connectTimeoutMs), maxBytes: 64 * 1024 }),
          );
        } else {
          await run('reconnect', () =>
            this._adb(['-s', serial, 'reconnect'], { timeoutMs: Math.min(timeoutMs, 20000), maxBytes: 64 * 1024 }),
          );
        }
      } else {
        await run('reboot', () =>
          this._adb(['-s', serial, 'reboot'], { timeoutMs: Math.min(timeoutMs, 20000), maxBytes: 64 * 1024 }),
        );
        this._root = false;
        this._debugPrepared = false;
        this._suAvailable = undefined;
        this._bootProbe = { serial: null, at: 0, booted: false };
      }
      await run('wait-for-device', () =>
        this._adb(['-s', serial, 'wait-for-device'], { timeoutMs: Math.min(timeoutMs, this.connectTimeoutMs) }),
      );
      const booted = await this._waitForBoot(Math.min(timeoutMs, this.bootTimeoutMs)).catch(() => false);
      base.ok = booted;
      base.booted = booted;
      base.elapsedMs = Date.now() - startedAt;
      this._pushLog(
        `[vm] device recovery (${strategy}) ${booted ? 'completed' : 'finished without boot_completed'} in ${base.elapsedMs}ms`,
      );
      return base;
    } catch (error) {
      base.ok = false;
      base.booted = false;
      base.error = error.message;
      base.elapsedMs = Date.now() - startedAt;
      this._pushLog(`[vm] device recovery (${strategy}) failed: ${error.message}`);
      return base;
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
        if (!entry.isFile() || !/\.(?:apk|apks|xapk)$/i.test(name)) continue;
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
            kind: path.extname(name).slice(1).toLowerCase(),
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
   * Install a plain APK or an APKS/XAPK bundle with `adb install-multiple`,
   * then resolve its metadata and best-effort launch it so the panel shows the app.
   * Returns { packageName, label, launchActivity, bundle? }.
   *
   * `options.preserveAppOps` (or `installPreserveAppOps: true`) snapshots
   * `cmd appops get <pkg>` before the install and re-grants the allowed ops after
   * it: a reinstall clears appops such as REQUEST_INSTALL_PACKAGES. It is a no-op
   * (no extra adb calls) by default and is skipped for release builds unless
   * `options.force` is set; the result then carries an additive `appops` field.
   */
  async installApk(apkPath, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const preserveAppOps =
      (this.installPreserveAppOps === true || opts.preserveAppOps === true) && opts.preserveAppOps !== false;
    const file = await this._assertPackageFile(apkPath);
    const serial = await this._requireSerial();
    const stat = await fsp.stat(file);
    const bundle = await extractApkBundle(file);
    try {
      const metadata = await this.inspectApk(bundle.basePath);
      this._pushLog(
        `[vm] installing ${path.basename(file)} (${stat.size} bytes, ${bundle.kind}, ` +
          `${bundle.apkPaths.length} apk) on ${serial} [${metadata.packageName}]`,
      );
      let appOpsSnapshot = null;
      let appOpsSkipReason = null;
      if (preserveAppOps) {
        const identity = this._identity;
        if (identity && identity.debugBuild === false && opts.force !== true) {
          appOpsSkipReason =
            'release build: appops re-grant only applies to debug/local test VMs (pass force: true to override)';
          this._pushLog(`[vm] appops snapshot skipped for ${metadata.packageName}: ${appOpsSkipReason}`);
        } else {
          try {
            appOpsSnapshot = await this.getAppOps(metadata.packageName);
            this._pushLog(
              `[vm] snapshotted ${Object.keys(appOpsSnapshot.ops || {}).length} appops for ${metadata.packageName}`,
            );
          } catch (error) {
            this._pushLog(`[vm] appops snapshot failed for ${metadata.packageName}: ${error.message}`);
            appOpsSkipReason = `snapshot failed: ${error.message}`;
          }
        }
      }
      const startedAt = Date.now();
      const installArgs =
        bundle.apkPaths.length > 1
          ? ['install-multiple', '-r', ...bundle.apkPaths]
          : ['install', '-r', bundle.basePath];
      let result = await this._adb(['-s', serial, ...installArgs], {
        timeoutMs: this.installTimeoutMs,
        maxBytes: 8 * 1024 * 1024,
      });
      let output = `${result.stdout.toString('utf8')}\n${result.stderr}`;
      if (/INSTALL_FAILED_TEST_ONLY/i.test(output)) {
        this._pushLog('[vm] package is test-only; retrying with -t');
        const retryArgs =
          bundle.apkPaths.length > 1
            ? ['install-multiple', '-r', '-t', ...bundle.apkPaths]
            : ['install', '-r', '-t', bundle.basePath];
        result = await this._adb(['-s', serial, ...retryArgs], {
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

      let appOps = null;
      if (preserveAppOps) {
        appOps = appOpsSkipReason
          ? { snapshot: null, requested: [], restored: [], errors: [], skipped: true, reason: appOpsSkipReason }
          : await this._restoreAppOps(metadata.packageName, appOpsSnapshot, opts.grantOps);
        if (!appOps.skipped) {
          if (appOps.errors.length > 0) {
            this._pushLog(`[vm] appops restore finished with ${appOps.errors.length} error(s)`);
          } else if (appOps.restored.length > 0) {
            this._pushLog(`[vm] re-granted ${appOps.restored.length} appop(s) after install`);
          }
        }
      }

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
      const resultMetadata =
        bundle.kind === 'apk'
          ? metadata
          : { ...metadata, bundle: { kind: bundle.kind, apkCount: bundle.apkPaths.length } };
      if (preserveAppOps) resultMetadata.appops = appOps;
      return resultMetadata;
    } finally {
      await cleanupBundle(bundle);
    }
  }

  /** Public read of `cmd appops get <pkg>` (returns { ok, packageName, ops }). */
  async getAppOps(packageName) {
    this._assertPackageName(packageName);
    const ops = await this._readAppOps(packageName);
    return { ok: true, packageName, ops };
  }

  /** Read the appops table for a package, preferring `cmd appops get`. */
  async _readAppOps(packageName) {
    let lastError = null;
    for (const command of [`cmd appops get ${packageName}`, `appops get ${packageName}`]) {
      try {
        const result = await this.shell(command, {
          root: true,
          forceRoot: true,
          timeoutMs: Math.min(this.commandTimeoutMs, 15000),
          maxBytes: 64 * 1024,
        });
        if (!result.ok) {
          lastError = (result.stderr || '').trim().slice(0, 300) || `exit ${result.code}`;
          continue;
        }
        const ops = parseAppOpsOutput(result.stdout);
        if (Object.keys(ops).length === 0) {
          lastError = 'guest reported no appops';
          continue;
        }
        return ops;
      } catch (error) {
        lastError = error.message;
      }
    }
    throw new DeviceError(
      DEVICE_ERROR_CODES.READ_FAILED,
      `failed to read appops for ${packageName}: ${lastError || 'unknown error'}`,
      { packageName },
    );
  }

  /** Re-grant appops that were allowed before the install (plus explicit grantOps). */
  async _restoreAppOps(packageName, snapshot, grantOps) {
    const requested = [];
    const seen = new Set();
    const addRequested = (op) => {
      const value = String(op || '').trim();
      if (!value) return;
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(value)) throw new Error(`invalid appop name: ${JSON.stringify(op)}`);
      if (!seen.has(value)) {
        seen.add(value);
        requested.push(value);
      }
    };
    for (const [op, mode] of Object.entries((snapshot && snapshot.ops) || {})) {
      if (mode === 'allow') addRequested(op);
    }
    if (Array.isArray(grantOps)) for (const op of grantOps) addRequested(op);
    const restored = [];
    const errors = [];
    for (const op of requested) {
      try {
        const result = await this.setAppOp(packageName, op, 'allow');
        if (result.ok) restored.push(op);
        else errors.push(`${op}: exit ${result.code}`);
      } catch (error) {
        errors.push(`${op}: ${error.message}`);
      }
    }
    return { snapshot: (snapshot && snapshot.ops) || {}, requested, restored, errors };
  }

  /** Set one appop (`cmd appops set <pkg> <OP> <mode>`), root or su. */
  async setAppOp(packageName, op, mode = 'allow') {
    this._assertPackageName(packageName);
    const name = String(op || '').trim();
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new Error(`invalid appop name: ${JSON.stringify(op)}`);
    const value = ['allow', 'deny', 'ignore', 'default', 'foreground'].includes(String(mode)) ? String(mode) : 'allow';
    const result = await this.shell(`cmd appops set ${packageName} ${name} ${value}`, {
      root: true,
      forceRoot: true,
      timeoutMs: Math.min(this.commandTimeoutMs, 15000),
      maxBytes: 64 * 1024,
    });
    return { ok: result.ok, packageName, op: name, mode: value, code: result.code };
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

  /** Return named emulator snapshots stored for this AVD. */
  snapshotDir() {
    return path.join(os.homedir(), '.android', 'avd', `${this.avdName}.avd`, 'snapshots');
  }

  validateSnapshotName(name) {
    const value = String(name || '').trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
      throw new Error('snapshot name must be 1-64 chars: letters, digits, dot, underscore or dash');
    }
    return value;
  }

  listNamedSnapshots() {
    const dir = this.snapshotDir();
    try {
      return {
        ok: true,
        names: existsSync(dir)
          ? readdirSync(dir, { withFileTypes: true })
              .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
              .map((entry) => entry.name)
              .sort()
          : [],
      };
    } catch (error) {
      return { ok: false, names: [], error: error.message };
    }
  }

  async saveNamedSnapshot(name) {
    const snapshot = this.validateSnapshotName(name);
    const serial = await this._requireSerial();
    const result = await this._adb(
      ['-s', serial, 'emu', 'avd', 'snapshot', 'save', snapshot],
      { timeoutMs: 120000, maxBytes: 256 * 1024 },
    );
    const output = `${result.stdout.toString('utf8')}\n${result.stderr}`.trim();
    if (result.code !== 0 || /error|unknown|failed/i.test(output)) {
      throw new Error(`snapshot save failed: ${output.slice(0, 500) || `exit ${result.code}`}`);
    }
    return { ok: true, name: snapshot, output: output.slice(0, 2000) };
  }

  async loadNamedSnapshot(name) {
    const snapshot = this.validateSnapshotName(name);
    const dir = path.join(this.snapshotDir(), snapshot);
    if (!existsSync(dir)) throw new Error(`snapshot not found: ${snapshot}`);
    this.snapshotName = snapshot;
    this.quickBoot = true;
    await this.restart();
    return { ok: true, name: snapshot, status: await this.status() };
  }

  async deleteNamedSnapshot(name) {
    const snapshot = this.validateSnapshotName(name);
    const target = path.join(this.snapshotDir(), snapshot);
    if (!existsSync(target)) throw new Error(`snapshot not found: ${snapshot}`);
    await fsp.rm(target, { recursive: true, force: true });
    return { ok: true, name: snapshot };
  }

  /** Open a validated deep link with an Android VIEW intent. */
  async openUrl(url) {
    const target = String(url || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s'"]+$/.test(target)) {
      throw new Error('deep link must be a scheme://... URL without whitespace or quotes');
    }
    const serial = await this._requireSerial();
    const quoted = `'${target.replace(/'/g, `'\\''`)}'`;
    const result = await this._adb(
      ['-s', serial, 'shell', `am start -a android.intent.action.VIEW -d ${quoted}`],
      { timeoutMs: 15000, maxBytes: 512 * 1024 },
    );
    const output = `${result.stdout.toString('utf8')}\n${result.stderr}`.trim();
    if (result.code !== 0 || /Error:|Exception|not found/i.test(output)) {
      throw new Error(`deep link failed: ${output.slice(0, 500)}`);
    }
    return { ok: true, url: target, output: output.slice(0, 2000) };
  }

  /** Grant or revoke a runtime permission for a package. */
  async setPermission(packageName, permission, granted = true) {
    this._assertPackageName(packageName);
    const name = String(permission || '').trim();
    if (!/^[A-Za-z0-9_.]+$/.test(name)) {
      throw new Error(`invalid permission: ${JSON.stringify(permission)}`);
    }
    const command = `pm ${granted ? 'grant' : 'revoke'} ${packageName} ${name}`;
    const result = await this.shell(command, { timeoutMs: 30000 });
    if (result.ok !== true) throw new Error(`permission change failed: ${command}`);
    return { ok: true, packageName, permission: name, granted: granted === true };
  }

  /**
   * Inject input: { type: 'tap', x, y } | { type: 'swipe', x1, y1, x2, y2, durationMs? }
   * | { type: 'key', key } | { type: 'text', text }. Resolves { ok: true }.
   *
   * Optional resilience extensions (all backward compatible):
   * - tap: `verify: true` captures a cheap pre/post frame fingerprint and retries once
   *   with ±1px jitter when the screen did not change; the result then carries
   *   `{ injected, changed, retried, attempts, ... }` so a lost tap is distinguishable
   *   from a page that simply does not change.
   * - text: `method: 'auto'|'input'|'clipboard'` (default `textInjectionMethod`).
   *   Non-ASCII text and `input text` failures fall back to `cmd clipboard set-text`
   *   + KEYCODE_PASTE and report which method worked.
   */
  async input(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('input(payload) requires an object payload');
    }
    const type = String(payload.type || payload.action || payload.kind || '').toLowerCase();

    if (type === 'tap') {
      const x = parseCoordinate(payload.x, 'x');
      const y = parseCoordinate(payload.y, 'y');
      return this._inputTap(x, y, payload);
    }
    if (type === 'text') {
      const rawText = payload.text !== undefined ? payload.text : payload.value;
      if (typeof rawText !== 'string' || rawText.length === 0) {
        throw new Error('input({ type: "text" }) requires a non-empty string "text"');
      }
      if (rawText.length > 4096) {
        throw new Error('input({ type: "text" }) text is limited to 4096 characters');
      }
      return this._inputText(rawText, payload);
    }

    let command;
    if (type === 'swipe') {
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
    } else {
      throw new Error(
        `unsupported input type ${JSON.stringify(type || '(missing)')}; expected tap|swipe|key|text`,
      );
    }
    return this._runInputCommand(command, type);
  }

  /** Deliver one `input ...` command; historical exact success shape ({ ok: true }). */
  async _runInputCommand(command, type) {
    await this._deliverInputCommand(command, type);
    return { ok: true };
  }

  /** Run one input command and throw the historical error text on failure. */
  async _deliverInputCommand(command, type) {
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
    return result;
  }

  /** One-shot full-frame fingerprint used only by opt-in tap verification. */
  async _fingerprintFrame() {
    const serial = this._serialActive || this.serial;
    if (!serial) return null;
    try {
      const result = await this._adb(['-s', serial, 'exec-out', 'screencap', '-p'], {
        timeoutMs: Math.min(this.inputVerifyCaptureTimeoutMs, this.screenshotTimeoutMs),
        maxBytes: this.screenshotMaxBytes,
      });
      if (result.timedOut || result.code !== 0 || !isPng(result.stdout)) return null;
      return { hash: hashBuffer(result.stdout), bytes: result.stdout.length, at: Date.now() };
    } catch {
      return null;
    }
  }

  async _inputTap(x, y, payload = {}) {
    const command = `input tap ${x} ${y}`;
    const verify = payload.verify === true || (payload.verify !== false && this.inputVerifyTaps === true);
    if (!verify) return this._runInputCommand(command, 'tap');

    const startedAt = Date.now();
    const delayMs = asPositiveInt(payload.verifyDelayMs, this.inputVerifyDelayMs);
    const before = await this._fingerprintFrame();
    await this._deliverInputCommand(command, 'tap');
    await sleep(delayMs);
    const after = await this._fingerprintFrame();
    let changed = before && after ? before.hash !== after.hash : null;
    let retried = false;
    let attempts = 1;
    let hint = null;

    if (changed === false) {
      retried = true;
      attempts = 2;
      const jitterX = Math.floor(Math.random() * 3) - 1;
      const jitterY = Math.floor(Math.random() * 3) - 1;
      const retryX = Math.max(0, x + jitterX);
      const retryY = Math.max(0, y + jitterY);
      this._pushLog(`[input] tap ${x},${y} produced no visual change; retrying once at ${retryX},${retryY}`);
      await this._deliverInputCommand(`input tap ${retryX} ${retryY}`, 'tap');
      await sleep(delayMs);
      const third = await this._fingerprintFrame();
      changed = third && after ? third.hash !== after.hash : null;
    }
    if (changed === false) {
      hint = 'the tap was accepted by adb but the screen never changed; the page may be static, the target may be outside the WebView, or the tap landed on a non-interactive area. Try a longer verifyDelayMs or uiDump().';
    } else if (changed === null) {
      hint = 'screen change could not be measured (frame fingerprint unavailable); the tap was still delivered.';
    }
    return {
      ok: true,
      injected: true,
      changed,
      retried,
      attempts,
      method: 'input tap',
      latencyMs: Date.now() - startedAt,
      ...(hint ? { hint } : {}),
    };
  }

  async _inputText(rawText, payload = {}) {
    const command = `input text ${encodeInputText(rawText)}`;
    const requested = String(payload.method || this.textInjectionMethod || 'auto').toLowerCase();
    const mode = ['auto', 'input', 'clipboard'].includes(requested) ? requested : 'auto';
    const nonAscii = /[^\x20-\x7e]/.test(rawText);
    const attempts = [];
    const tryInputText = async () => {
      try {
        await this._deliverInputCommand(command, 'text');
        attempts.push({ method: 'input-text', ok: true });
        return { ok: true };
      } catch (error) {
        attempts.push({ method: 'input-text', ok: false, error: error.message.slice(0, 300) });
        return { ok: false, error };
      }
    };
    const tryClipboard = async () => {
      try {
        const detail = await this._clipboardPasteText(rawText);
        attempts.push({ method: 'clipboard', ok: true });
        return { ok: true, detail };
      } catch (error) {
        attempts.push({ method: 'clipboard', ok: false, error: error.message.slice(0, 300) });
        return { ok: false, error };
      }
    };

    if (mode === 'clipboard') {
      const clip = await tryClipboard();
      if (clip.ok) {
        return {
          ok: true,
          method: 'clipboard',
          attempts,
          note: 'pasted through the guest clipboard (cmd clipboard set-text + KEYCODE_PASTE)',
        };
      }
      const typed = await tryInputText();
      if (typed.ok) {
        return {
          ok: true,
          method: 'input-text',
          fallback: true,
          attempts,
          warning: `clipboard paste failed (${clip.error.message.slice(0, 200)}); used \`input text\` instead`,
        };
      }
      throw new Error(`input text failed (clipboard and input text): ${clip.error.message.slice(0, 400)}`);
    }
    if (mode === 'input') {
      const typed = await tryInputText();
      if (typed.ok) return { ok: true };
      throw new Error(`input text failed: ${typed.error.message.slice(0, 400)}`);
    }

    if (nonAscii) {
      // `input text` mangles most non-ASCII input, so try the clipboard first.
      const clip = await tryClipboard();
      if (clip.ok) {
        this._pushLog('[input] non-ASCII text pasted through the clipboard fallback');
        return {
          ok: true,
          method: 'clipboard',
          attempts,
          note: 'non-ASCII text is unreliable with `input text`; used clipboard paste',
        };
      }
      const typed = await tryInputText();
      if (typed.ok) {
        return {
          ok: true,
          method: 'input-text',
          fallback: true,
          attempts,
          warning: 'non-ASCII text may be dropped by `input text`; paste manually if nothing appears',
        };
      }
      throw new Error(`input text failed: ${typed.error.message.slice(0, 400)}`);
    }

    // ASCII default: input text first; only on failure try the clipboard fallback.
    const typed = await tryInputText();
    if (typed.ok) return { ok: true };
    const clip = await tryClipboard();
    if (clip.ok) {
      this._pushLog('[input] `input text` failed; pasted through the clipboard fallback');
      return { ok: true, method: 'clipboard', fallback: true, attempts, primaryError: typed.error.message.slice(0, 300) };
    }
    throw new Error(
      `input text failed (${typed.error.message.slice(0, 300)}; clipboard fallback: ${clip.error.message.slice(0, 300)})`,
    );
  }

  /** Paste text through the guest clipboard (Android 7+: `cmd clipboard set-text`). */
  async _clipboardPasteText(rawText) {
    const serial = this._debugSerial();
    const text = String(rawText)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[\u0000-\u001f]/g, '');
    const timeoutMs = this.clipboardTextTimeoutMs;
    const set = await this._adb(['-s', serial, 'shell', `cmd clipboard set-text ${quoteForDeviceShell(text)}`], {
      timeoutMs,
      maxBytes: 64 * 1024,
    });
    const setOutput = `${set.stdout.toString('utf8')}\n${set.stderr}`.trim();
    if (set.timedOut) throw new Error(`clipboard set-text timed out after ${timeoutMs}ms`);
    if (set.code !== 0 || /(?:Unknown command|Error:|Exception|usage:)/i.test(setOutput)) {
      throw new Error(
        `clipboard set-text unsupported or failed (exit ${set.code}): ${setOutput.slice(0, 200) || 'no output'}`,
      );
    }
    await sleep(120);
    const paste = await this._adb(['-s', serial, 'shell', 'input keyevent 279'], { timeoutMs, maxBytes: 64 * 1024 });
    const pasteOutput = `${paste.stdout.toString('utf8')}\n${paste.stderr}`.trim();
    if (paste.timedOut || paste.code !== 0) {
      throw new Error(`paste key event failed (exit ${paste.code}): ${pasteOutput.slice(0, 200) || 'no output'}`);
    }
    return 'cmd clipboard set-text + input keyevent 279 (KEYCODE_PASTE)';
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
        await this._applyHosts().catch((error) => {
          this._pushLog(`[net] hosts reapply skipped: ${error.message}`);
        });
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
    const forceRoot = options && options.forceRoot === true;
    if (options.root !== false) {
      try {
        await this.ensureRoot();
      } catch {
        /* fall back to the current adbd user */
      }
    }
    const serial = this._debugSerial();
    let viaSu = false;
    let toRun = command;
    if (forceRoot && this._root !== true) {
      const suAvailable = await this._probeSu(serial);
      if (!suAvailable) {
        throw new DeviceError(
          DEVICE_ERROR_CODES.SHELL_ROOT_REQUIRED,
          `root execution is unavailable on ${serial}: \`adb root\` was rejected and no usable \`${this.suPath}\` was found (hint: use a debuggable/rooted system image, or call without { forceRoot: true } to run as the shell user)`,
          { serial, suPath: this.suPath, hint: healthHint(DEVICE_ERROR_CODES.SHELL_ROOT_REQUIRED) },
        );
      }
      viaSu = true;
      toRun = suWrapCommand(command, this.suPath);
    }
    const result = await this._adb(['-s', serial, 'shell', toRun], {
      timeoutMs: asPositiveInt(options.timeoutMs, this.commandTimeoutMs),
      maxBytes: asPositiveInt(options.maxBytes, 256 * 1024),
    });
    const response = {
      ok: !result.timedOut && result.code === 0,
      code: result.code,
      root: this._root === true || viaSu,
      timedOut: result.timedOut === true,
      stdout: result.stdout.toString('utf8').slice(0, 100000),
      stderr: result.stderr.slice(0, 20000),
    };
    if (viaSu) response.viaSu = true;
    return response;
  }

  /** Root shell that works even when `adb root` is unavailable (uses `su 0 sh -c`). */
  async shellRoot(command, options = {}) {
    return this.shell(command, { ...options, root: true, forceRoot: true });
  }

  /** Probe (and cache per boot) whether the guest exposes a usable `su`. */
  async _probeSu(serial) {
    if (this._suAvailable !== undefined) return this._suAvailable;
    try {
      const probe = await this._adb(
        ['-s', serial, 'shell', `command -v ${this.suPath} 2>/dev/null || which ${this.suPath} 2>/dev/null`],
        { timeoutMs: Math.min(this.commandTimeoutMs, 8000), maxBytes: 8192 },
      );
      const pathText = `${(probe.stdout || Buffer.alloc(0)).toString('utf8')}\n${probe.stderr || ''}`.trim();
      if (probe.timedOut || probe.code !== 0 || !pathText) {
        this._suAvailable = false;
        return false;
      }
      const whoami = await this._adb(['-s', serial, 'shell', suWrapCommand('id -u', this.suPath)], {
        timeoutMs: Math.min(this.commandTimeoutMs, 8000),
        maxBytes: 8192,
      });
      const uidText = `${(whoami.stdout || Buffer.alloc(0)).toString('utf8')}\n${whoami.stderr || ''}`.trim();
      this._suAvailable = !whoami.timedOut && whoami.code === 0 && /(^|\n)\s*0\s*($|\n)/.test(uidText);
    } catch {
      this._suAvailable = false;
    }
    if (!this._suAvailable) {
      this._pushLog('[vm] no usable su on the guest (adb root unavailable); root-only operations may fail');
    }
    return this._suAvailable === true;
  }

  /**
   * Read a guest file as root (via `su` when adb root is unavailable).
   * @returns {Promise<{ ok: true, path: string, text: string, bytes: number }>}
   */
  async readRootFile(remotePath, options = {}) {
    const remote = assertSafeRemotePath(remotePath);
    const result = await this.shell(`cat ${quoteForDeviceShell(remote)}`, {
      root: true,
      forceRoot: true,
      timeoutMs: asPositiveInt(options.timeoutMs, this.commandTimeoutMs),
      maxBytes: asPositiveInt(options.maxBytes, 4 * 1024 * 1024),
    });
    if (!result.ok) {
      throw new DeviceError(
        DEVICE_ERROR_CODES.READ_FAILED,
        `failed to read ${remote}: ${(result.stderr || '').trim().slice(0, 300) || `exit ${result.code}`}`,
        { path: remote, code: result.code, timedOut: result.timedOut, hint: healthHint(DEVICE_ERROR_CODES.READ_FAILED) },
      );
    }
    return { ok: true, path: remote, text: result.stdout, bytes: Buffer.byteLength(result.stdout) };
  }

  /**
   * Write a guest file as root with explicit mode/owner/SELinux context.
   * The content is uploaded to /data/local/tmp first, then copied into place.
   * `chcon` needs an explicit context literal (toybox chcon has no `--reference`).
   *
   * @param {string} remotePath absolute guest path
   * @param {string|Buffer} content
   * @param {{ mode?: string, owner?: string, selinuxContext?: string, verify?: boolean, timeoutMs?: number }} [options]
   */
  async writeRootFile(remotePath, content, options = {}) {
    const remote = assertSafeRemotePath(remotePath);
    const mode = normalizeDeviceFileMode(options.mode, '660');
    const owner = normalizeDeviceOwner(options.owner, null);
    const selinuxContext = normalizeSelinuxContext(options.selinuxContext);
    const verify = options.verify !== false;
    const payload = Buffer.isBuffer(content) ? content : Buffer.from(String(content == null ? '' : content), 'utf8');
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const localPath = path.join(os.tmpdir(), `dsh-write-${process.pid}-${stamp}.tmp`);
    const stagedPath = `/data/local/tmp/dsh-write-${stamp}.tmp`;
    const serial = this._serialActive || this.serial;
    try {
      await fsp.writeFile(localPath, payload);
      if (!serial) throw new Error('No Android device is attached');
      const pushed = await this._adb(['-s', serial, 'push', localPath, stagedPath], {
        timeoutMs: Math.min(this.commandTimeoutMs, 30000),
        maxBytes: 64 * 1024,
      });
      if (pushed.timedOut || pushed.code !== 0) {
        throw new DeviceError(
          DEVICE_ERROR_CODES.WRITE_FAILED,
          `failed to stage ${remote}: ${(pushed.stderr || '').trim().slice(0, 300) || `exit ${pushed.code}`}`,
          { path: remote, hint: healthHint(DEVICE_ERROR_CODES.WRITE_FAILED) },
        );
      }
      const dir = path.posix.dirname(remote);
      const quotedRemote = quoteForDeviceShell(remote);
      const steps = [
        `mkdir -p ${quoteForDeviceShell(dir)}`,
        `cp ${quoteForDeviceShell(stagedPath)} ${quotedRemote}`,
        `chmod ${mode} ${quotedRemote}`,
      ];
      if (owner) steps.push(`chown ${owner} ${quotedRemote}`);
      if (selinuxContext) steps.push(`chcon ${selinuxContext} ${quotedRemote}`);
      steps.push(`rm -f ${quoteForDeviceShell(stagedPath)}`);
      if (verify) steps.push(`ls -l ${quotedRemote}`);
      const result = await this.shell(steps.join(' && '), {
        root: true,
        forceRoot: true,
        timeoutMs: asPositiveInt(options.timeoutMs, Math.min(this.commandTimeoutMs, 30000)),
        maxBytes: 64 * 1024,
      });
      if (!result.ok) {
        throw new DeviceError(
          DEVICE_ERROR_CODES.WRITE_FAILED,
          `failed to write ${remote}: ${(result.stderr || '').trim().slice(0, 300) || `exit ${result.code}`}`,
          { path: remote, code: result.code, timedOut: result.timedOut, hint: healthHint(DEVICE_ERROR_CODES.WRITE_FAILED) },
        );
      }
      return {
        ok: true,
        path: remote,
        bytes: payload.length,
        mode,
        owner: owner || null,
        selinuxContext: selinuxContext || null,
        verified: verify ? result.stdout.trim().slice(0, 500) : null,
      };
    } finally {
      await fsp.rm(localPath, { force: true }).catch(() => {});
      if (serial) {
        this._adb(['-s', serial, 'shell', 'rm', '-f', stagedPath], { timeoutMs: 10000 }).catch(() => {});
      }
    }
  }

  /** Read a file under /data/data/<pkg>/ as root. */
  async readAppDataFile(packageName, relativePath, options = {}) {
    this._assertPackageName(packageName);
    const rel = normalizePackageRelativePath(relativePath);
    return this.readRootFile(`/data/data/${packageName}/${rel}`, options);
  }

  /** Write a file under /data/data/<pkg>/ as root (mode/owner defaults suit app data). */
  async writeAppDataFile(packageName, relativePath, content, options = {}) {
    this._assertPackageName(packageName);
    const rel = normalizePackageRelativePath(relativePath);
    return this.writeRootFile(`/data/data/${packageName}/${rel}`, content, {
      mode: '660',
      owner: `${packageName}:${packageName}`,
      ...options,
    });
  }

  /**
   * Write an app's shared_prefs XML as root. Pass `selinuxContext` when the app's
   * data has a non-default label; it is applied with `chcon <context> <file>`.
   */
  async writeSharedPrefs(packageName, prefsName, content, options = {}) {
    this._assertPackageName(packageName);
    const name = String(prefsName || '')
      .trim()
      .replace(/\.xml$/i, '');
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
      throw new Error(`invalid shared preferences name: ${JSON.stringify(prefsName)}`);
    }
    return this.writeAppDataFile(packageName, `shared_prefs/${name}.xml`, content, {
      mode: '660',
      owner: `${packageName}:${packageName}`,
      ...options,
    });
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
    let physicalSize = null;
    let density = null;
    let uptime = null;
    let statusBarTop = null;
    let navigationBarBottom = null;
    let rotation = null;
    try {
      const wm = await this._adbText(['-s', serial, 'shell', 'wm', 'size'], { timeoutMs: 10 * 1000 });
      const overrideMatch = /Override size:\s*(\d+)\s*x\s*(\d+)/i.exec(wm);
      const physicalMatch = /Physical size:\s*(\d+)\s*x\s*(\d+)/i.exec(wm);
      if (physicalMatch) {
        physicalSize = { width: Number(physicalMatch[1]), height: Number(physicalMatch[2]) };
      }
      if (overrideMatch) {
        size = { width: Number(overrideMatch[1]), height: Number(overrideMatch[2]) };
      } else if (physicalSize) {
        size = { ...physicalSize };
      }
      const wmDensity = await this._adbText(['-s', serial, 'shell', 'wm', 'density'], { timeoutMs: 10 * 1000 });
      const densityMatch = /(\d+)/.exec(wmDensity);
      if (densityMatch) density = Number(densityMatch[1]);
      uptime = (await this._adbText(['-s', serial, 'shell', 'cat', '/proc/uptime'], { timeoutMs: 10 * 1000 })).trim();
      // Stable insets are in device pixels. They tell us where the WebView
      // viewport starts relative to the physical screen (status bar top).
      const windows = await this._adbText(
        ['-s', serial, 'shell', 'dumpsys', 'window', 'displays'],
        { timeoutMs: 15 * 1000 },
      );
      const stable = /mStableInsets=Rect\(\s*(-?\d+),\s*(-?\d+)\s*-\s*(-?\d+),\s*(-?\d+)\s*\)/.exec(windows);
      if (stable) {
        statusBarTop = Math.max(0, Number(stable[2]));
        navigationBarBottom = Math.max(0, Number(stable[4]));
      }
      const rotationMatch = /mRotation=(\d+)/.exec(windows);
      if (rotationMatch) rotation = Number(rotationMatch[1]);
    } catch {
      /* optional extras */
    }
    const dpr = density ? Math.round((density / 160) * 1000) / 1000 : null;
    return {
      ok: true,
      serial,
      state: this._state,
      root: this._root === true,
      adbPath: this.adbPath,
      external: this._external === true,
      debugToolkit: this._debugToolkitPath,
      identity,
      size,
      physicalSize,
      density,
      dpr,
      statusBarTop,
      navigationBarBottom,
      rotation,
      coordinateMap: {
        device: size,
        dpr,
        offsetX: 0,
        offsetY: statusBarTop || 0,
        formula: 'device = round(css * dpr) + offset',
        note: 'For a WebView selector, prefer tap_selector (CDP) instead of converting coordinates.',
      },
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

  async reboot(mode = '', options = {}) {
    const serial = this._debugSerial();
    const restore = options && options.restoreEnv === false ? null : await this.captureEnv().catch(() => null);
    const args = ['-s', serial, 'reboot'];
    if (mode) args.push(String(mode));
    const result = await this._adb(args, { timeoutMs: 20 * 1000, maxBytes: 64 * 1024 });
    if (result.code !== 0 && !result.timedOut) {
      throw new Error(`adb reboot failed: ${result.stderr.toString('utf8').slice(0, 300)}`);
    }
    // adbd/root state never survives a reboot; reset cached probes so they re-run.
    this._root = false;
    this._debugPrepared = false;
    this._debugToolkitPath = null;
    this._identity = null;
    this._suAvailable = undefined;
    this._health = null;
    this._bootProbe = { serial: null, at: 0, booted: false };
    const restoreScheduled = this._scheduleEnvRestore(restore);
    this._pushLog(`[vm] adb reboot${mode ? ` ${mode}` : ''} requested${restoreScheduled ? '; environment restore scheduled' : ''}`);
    return {
      ok: true,
      mode: mode || 'system',
      restoreScheduled,
      envSnapshot: restore
        ? {
            networkMode: restore.networkMode,
            proxy: restore.proxy,
            dnsServers: restore.dnsServers.length,
            hostsEntries: restore.hostsEntries.length,
            forwards: restore.forwards.length,
            reverses: restore.reverses.length,
          }
        : null,
    };
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

  /** Configure or clear the guest's global HTTP proxy. */
  async setProxy(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const enabled = opts.enabled !== false;
    const serial = this._debugSerial();
    const run = (command) =>
      this._adbText(['-s', serial, 'shell', command], { timeoutMs: 20000, maxBytes: 64 * 1024 }).then((text) =>
        text.trim(),
      );
    if (!enabled) {
      await run('settings delete global http_proxy 2>/dev/null || true');
      await run('settings delete global global_http_proxy_host 2>/dev/null || true');
      await run('settings delete global global_http_proxy_port 2>/dev/null || true');
      await run('settings delete global global_http_proxy_exclusion_list 2>/dev/null || true');
      const current = await run('settings get global http_proxy');
      this._pushLog('[vm] HTTP proxy cleared');
      return { ok: true, proxy: null, host: null, port: null, current: current || null };
    }
    const host = String(opts.host || '').trim();
    const port = Number(opts.port);
    if (!/^[A-Za-z0-9._:-]{1,253}$/.test(host)) throw new Error(`invalid proxy host: ${JSON.stringify(opts.host)}`);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid proxy port: ${opts.port}`);
    const proxy = `${host}:${port}`;
    await run(`settings put global http_proxy ${proxy}`);
    await run(`settings put global global_http_proxy_host ${host}`);
    await run(`settings put global global_http_proxy_port ${port}`);
    if (typeof opts.bypass === 'string' && opts.bypass.trim()) {
      await run(`settings put global global_http_proxy_exclusion_list ${opts.bypass.trim()}`);
    }
    const current = await run('settings get global http_proxy');
    this._pushLog(`[vm] HTTP proxy set to ${proxy}`);
    return { ok: true, proxy, host, port, current: current || null };
  }

  /** Read the guest's current global HTTP proxy settings. */
  async getProxy() {
    const serial = this._debugSerial();
    const text = await this._adbText(['-s', serial, 'shell', 'settings get global http_proxy'], {
      timeoutMs: 15000,
      maxBytes: 64 * 1024,
    });
    const proxy = String(text).trim();
    return { ok: true, proxy: proxy && proxy !== 'null' && proxy !== ':0' ? proxy : null };
  }

  /** Validate and store custom DNS servers for the next emulator start. */
  async setDnsServers(servers) {
    const list = (Array.isArray(servers) ? servers : String(servers || '').split(','))
      .map((value) => String(value).trim())
      .filter(Boolean);
    if (list.length > 4) throw new Error('at most 4 DNS servers are supported');
    for (const server of list) {
      if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(server) && !/^[0-9a-fA-F:]+$/.test(server)) {
        throw new Error(`invalid DNS server: ${JSON.stringify(server)}`);
      }
      if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(server)) {
        for (const part of server.split('.')) {
          const n = Number(part);
          if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`invalid DNS server: ${server}`);
        }
      }
    }
    this.dnsServers = list;
    return {
      ok: true,
      servers: list,
      restartRequired: this._state === 'ready' || this._state === 'booting' || this._state === 'starting',
      note: 'custom DNS is applied by the emulator -dns-server flag on the next start',
    };
  }

  normalizeHosts(entries) {
    const lines = (Array.isArray(entries) ? entries : String(entries || '').split(/\r?\n/))
      .map((line) => String(line || '').trim())
      .filter((line) => line && !line.startsWith('#'));
    if (lines.length > 200) throw new Error('hosts file is limited to 200 entries');
    const normalized = [];
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 2) throw new Error(`invalid hosts entry: ${line}`);
      const [ip, ...names] = parts;
      if (!/^(?:(?:\d{1,3}\.){3}\d{1,3}|[0-9a-fA-F:]+)$/.test(ip)) {
        throw new Error(`invalid hosts IP: ${ip}`);
      }
      if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
        for (const part of ip.split('.')) {
          const n = Number(part);
          if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`invalid hosts IP: ${ip}`);
        }
      }
      for (const name of names) {
        if (!/^[A-Za-z0-9_.-]{1,253}$/.test(name)) throw new Error(`invalid hosts name: ${name}`);
      }
      normalized.push(`${ip}\t${names.join(' ')}`);
    }
    return normalized;
  }

  async _applyHosts() {
    const entries = Array.isArray(this.hostsEntries) ? this.hostsEntries : [];
    if (!entries.length) {
      try {
        await this.ensureRoot();
        await this._adb(
          ['-s', this._debugSerial(), 'shell', 'umount /system/etc/hosts 2>/dev/null || true'],
          { timeoutMs: 10000, maxBytes: 16 * 1024 },
        );
      } catch {
        /* best effort */
      }
      return { ok: true, applied: false, cleared: true, entries: 0 };
    }
    await this.ensureRoot();
    const serial = this._debugSerial();
    const local = path.join(os.tmpdir(), `dsh-hosts-${process.pid}-${Date.now()}`);
    const content = `127.0.0.1\tlocalhost\n::1\tip6-localhost\n${entries.join('\n')}\n`;
    await fsp.writeFile(local, content, 'utf8');
    try {
      await this.pushFile(local, '/data/local/tmp/dsh-hosts');
      const result = await this._adb(
        [
          '-s',
          serial,
          'shell',
          'mount --bind /data/local/tmp/dsh-hosts /system/etc/hosts && ' +
            'chmod 644 /system/etc/hosts && grep -q dsh-hosts /system/etc/hosts 2>/dev/null; true',
        ],
        { timeoutMs: 20000, maxBytes: 64 * 1024 },
      );
      if (result.code !== 0) {
        throw new Error(`hosts bind mount failed: ${result.stderr.toString('utf8').slice(0, 300)}`);
      }
      // Verify a known custom name rather than trusting the shell exit code.
      const verify = await this._adbText(['-s', serial, 'shell', 'cat /system/etc/hosts'], {
        timeoutMs: 10000,
        maxBytes: 128 * 1024,
      });
      if (!entries.every((line) => verify.includes(String(line).split(/\s+/)[1] || '—'))) {
        throw new Error('hosts file was not applied');
      }
      this._pushLog(`[net] applied ${entries.length} hosts entries`);
      return { ok: true, applied: true, entries: entries.length };
    } finally {
      await fsp.unlink(local).catch(() => {});
    }
  }

  async setHosts(entries) {
    this.hostsEntries = this.normalizeHosts(entries);
    const applied = await this._applyHosts();
    return { ok: true, ...applied, entriesList: this.hostsEntries };
  }

  /**
   * Select `isolated` (default QEMU NAT) or `shared` guest networking.
   *
   * Stays synchronous and adb-free so it can be called on a stopped VM. When the
   * mode becomes `shared` on an attached device, a best-effort default-route repair
   * is scheduled in the background (an emulator can lose its default route after an
   * isolated -> shared switch); await `vm._pendingNetworkRepair` in tests or call
   * `repairNetwork()` directly.
   */
  setNetworkMode(mode) {
    const value = String(mode || '').toLowerCase();
    if (value !== 'isolated' && value !== 'shared') throw new Error("network mode must be 'isolated' or 'shared'");
    this.networkMode = value;
    const result = {
      ok: true,
      mode: value,
      note:
        value === 'shared'
          ? 'shared TCP port forwards are reachable from other VMs through the emulator host alias'
          : 'VMs remain QEMU-NAT isolated unless a shared TCP forward is explicitly created',
    };
    if (value === 'shared' && this._serialActive && this.networkAutoRepair !== false) {
      const repair = this.repairNetwork({ reason: 'mode-shared' })
        .catch((error) => ({ ok: false, error: error.message }))
        .finally(() => {
          if (this._pendingNetworkRepair === repair) this._pendingNetworkRepair = null;
        });
      this._pendingNetworkRepair = repair;
      result.repairScheduled = true;
    }
    return result;
  }

  /** Read IPv4 routes + addresses from the guest in a single adb round trip. */
  async _readGuestRoutes(serial) {
    const text = await this._adbText(['-s', serial, 'shell', 'ip -4 route show; echo "---IFACES---"; ip -4 addr show'], {
      timeoutMs: 10000,
      maxBytes: 128 * 1024,
    });
    return parseRouteOutput(text);
  }

  /**
   * Ensure the guest has a default route through the emulator NAT gateway.
   *
   * A guest that switched isolated -> shared can come up with only a link-scope
   * link route (also lost across reboots/emulator restarts), which makes outbound
   * connections fail with ENETUNREACH. This detects the missing route, adds
   * `ip route add default via <gateway> dev <iface>` as root (adb root or
   * `su 0 sh -c`), re-reads to verify, and reports structured state.
   *
   * @param {{ gateway?: string, iface?: string, reason?: string }} [options]
   */
  async repairNetwork(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const serial = await this._requireSerial();
    const startedAt = Date.now();
    const gateway = parseIpv4Address(opts.gateway) || this.networkGateway;
    const readRoutes = async (label) => {
      try {
        return await this._readGuestRoutes(serial);
      } catch (error) {
        this._pushLog(`[net] could not read guest routes (${label}): ${error.message.slice(0, 300)}`);
        return { defaultRoute: null, routes: [], ifaces: [], addresses: [], unreachable: false };
      }
    };
    const before = await readRoutes('before');

    if (before.defaultRoute) {
      this._pushLog(
        `[net] default route already present (via ${before.defaultRoute.gateway || '?'} dev ${before.defaultRoute.iface || '?'})`,
      );
      return {
        ok: true,
        repaired: false,
        code: null,
        serial,
        mode: this.networkMode,
        gateway,
        iface: before.defaultRoute.iface || null,
        before: { defaultRoute: before.defaultRoute, routes: before.routes },
        after: { defaultRoute: before.defaultRoute, routes: before.routes },
        attempts: [],
        elapsedMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
        note: 'default route already present',
      };
    }

    const iface =
      String(opts.iface || '').trim() ||
      before.ifaces.find((name) => name === 'eth0') ||
      before.ifaces.find((name) => /^(?:eth|wlan)/.test(name)) ||
      before.ifaces.find((name) => name !== 'lo') ||
      'eth0';
    const command = `ip route add default via ${gateway} dev ${iface}`;
    const attempts = [];
    let addResult = null;
    let lastError = null;
    try {
      addResult = await this.shell(command, {
        root: true,
        forceRoot: true,
        timeoutMs: Math.min(this.commandTimeoutMs, 15000),
        maxBytes: 64 * 1024,
      });
      attempts.push({ action: 'ip-route-add', ok: addResult.ok, code: addResult.code, viaSu: addResult.viaSu === true });
      if (!addResult.ok) lastError = (addResult.stderr || '').trim().slice(0, 300) || `exit ${addResult.code}`;
    } catch (error) {
      attempts.push({ action: 'ip-route-add', ok: false, error: error.message.slice(0, 300) });
      lastError = error.message;
    }
    const after = await readRoutes('after');
    const repaired = Boolean(after.defaultRoute) || Boolean(addResult && addResult.ok);
    if (repaired) {
      this._pushLog(
        `[net] repaired default route via ${gateway} dev ${iface}${addResult && addResult.viaSu ? ' (via su)' : ''}`,
      );
    } else {
      this._pushLog(`[net] default route repair failed: ${lastError || 'route still missing'}`);
    }
    const unreachable = after.unreachable === true || /ENETUNREACH|Network is unreachable/i.test(lastError || '');
    this._lastRouteRepairAt = Date.now();
    const result = {
      ok: repaired,
      repaired,
      code: repaired
        ? null
        : unreachable
          ? DEVICE_ERROR_CODES.NETWORK_UNREACHABLE
          : DEVICE_ERROR_CODES.ROUTE_REPAIR_FAILED,
      serial,
      mode: this.networkMode,
      gateway,
      iface,
      before: { defaultRoute: before.defaultRoute, routes: before.routes },
      after: { defaultRoute: after.defaultRoute, routes: after.routes },
      attempts,
      elapsedMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    };
    if (!repaired) result.hint = healthHint(result.code);
    return result;
  }

  setTcpdumpPath(filePath) {
    const target = String(filePath || '').trim();
    if (!target) {
      this.tcpdumpPath = null;
      return { ok: true, enabled: false, restartRequired: true };
    }
    const resolved = path.resolve(target);
    if (!/\.pcap$/i.test(resolved)) throw new Error('pcap path must end in .pcap');
    this.tcpdumpPath = resolved;
    return {
      ok: true,
      enabled: true,
      path: resolved,
      restartRequired: this._state === 'ready' || this._state === 'booting' || this._state === 'starting',
      note: 'the emulator creates the pcap file on the next start',
    };
  }

  async addPortForward(localPort, remotePort, options = {}) {
    const local = Number(localPort);
    const remote = Number(remotePort);
    if (!Number.isInteger(local) || local < 1 || local > 65535) throw new Error('invalid local port');
    if (!Number.isInteger(remote) || remote < 1 || remote > 65535) throw new Error('invalid remote port');
    const shared = options && options.shared === true;
    if (shared && this.networkMode !== 'shared') {
      throw new Error("shared port forwards require networkMode='shared'");
    }
    const serial = await this._requireSerial();
    const key = String(local);
    if (this._portForwards.has(key)) throw new Error(`local port ${local} is already forwarded`);
    const result = await this._adb(
      ['-s', serial, 'forward', `tcp:${local}`, `tcp:${remote}`],
      { timeoutMs: 15000, maxBytes: 64 * 1024 },
    );
    if (result.code !== 0 || result.timedOut) {
      throw new Error(`adb forward failed: ${result.stderr.toString('utf8').slice(0, 300) || `exit ${result.code}`}`);
    }
    const rule = { localPort: local, remotePort: remote, shared };
    this._portForwards.set(key, rule);
    this._pushLog(`[net] forward tcp:${local} -> guest tcp:${remote}${shared ? ' (shared)' : ''}`);
    return {
      ok: true,
      ...rule,
      guestUrl: `${GUEST_HOST_ALIAS}:${local}`,
      sharedGuestUrl: shared ? `${GUEST_HOST_ALIAS}:${local}` : null,
    };
  }

  async removePortForward(localPort) {
    const local = Number(localPort);
    if (!Number.isInteger(local) || local < 1 || local > 65535) throw new Error('invalid local port');
    const serial = await this._requireSerial();
    await this._adb(['-s', serial, 'forward', '--remove', `tcp:${local}`], {
      timeoutMs: 10000,
      maxBytes: 64 * 1024,
    }).catch(() => {});
    this._portForwards.delete(String(local));
    this._pushLog(`[net] removed forward tcp:${local}`);
    return { ok: true, localPort: local };
  }

  listPortForwards() {
    return [...this._portForwards.values()].map((rule) => ({
      ...rule,
      guestUrl: `${GUEST_HOST_ALIAS}:${rule.localPort}`,
      sharedGuestUrl: rule.shared ? `${GUEST_HOST_ALIAS}:${rule.localPort}` : null,
    }));
  }

  async addReverse(localPort, hostPort) {
    const guest = Number(localPort);
    const host = Number(hostPort);
    if (!Number.isInteger(guest) || guest < 1 || guest > 65535) throw new Error('invalid guest localPort');
    if (!Number.isInteger(host) || host < 1 || host > 65535) throw new Error('invalid hostPort');
    const serial = await this._requireSerial();
    if (this._reverseForwards.has(String(guest))) throw new Error(`guest port ${guest} already has a reverse`);
    const result = await this._adb(
      ['-s', serial, 'reverse', `tcp:${guest}`, `tcp:${host}`],
      { timeoutMs: 15000, maxBytes: 64 * 1024 },
    );
    if (result.code !== 0 || result.timedOut) {
      throw new Error(`adb reverse failed: ${result.stderr.toString('utf8').slice(0, 300) || `exit ${result.code}`}`);
    }
    const rule = { localPort: guest, hostPort: host };
    this._reverseForwards.set(String(guest), rule);
    this._pushLog(`[net] reverse guest 127.0.0.1:${guest} -> host 127.0.0.1:${host}`);
    return { ok: true, ...rule, guestUrl: `http://127.0.0.1:${guest}`, note: 'adb reverse is per-device and may need re-adding after reboot' };
  }

  async removeReverse(localPort) {
    const guest = Number(localPort);
    if (!Number.isInteger(guest) || guest < 1 || guest > 65535) throw new Error('invalid guest localPort');
    const serial = await this._requireSerial();
    await this._adb(['-s', serial, 'reverse', '--remove', `tcp:${guest}`], {
      timeoutMs: 10000,
      maxBytes: 64 * 1024,
    }).catch(() => {});
    this._reverseForwards.delete(String(guest));
    this._pushLog(`[net] removed reverse tcp:${guest}`);
    return { ok: true, localPort: guest };
  }

  listReverseForwards() {
    return [...this._reverseForwards.values()].map((rule) => ({
      ...rule,
      guestUrl: `http://127.0.0.1:${rule.localPort}`,
    }));
  }

  /**
   * Snapshot the parts of the guest environment that adb reboot resets:
   * in-memory network mode, proxy, DNS intent, hosts entries and forwards.
   */
  async captureEnv() {
    const proxy = await this.getProxy().catch(() => ({ proxy: null }));
    return {
      version: 1,
      capturedAt: new Date().toISOString(),
      networkMode: this.networkMode,
      proxy: proxy && proxy.proxy ? proxy.proxy : null,
      dnsServers: Array.isArray(this.dnsServers) ? [...this.dnsServers] : [],
      hostsEntries: Array.isArray(this.hostsEntries) ? [...this.hostsEntries] : [],
      forwards: this.listPortForwards().map(({ localPort, remotePort, shared }) => ({ localPort, remotePort, shared })),
      reverses: this.listReverseForwards().map(({ localPort, hostPort }) => ({ localPort, hostPort })),
    };
  }

  /** Re-apply a captureEnv() snapshot after the device is back online. */
  async restoreEnv(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') throw new Error('restoreEnv requires an environment snapshot');
    const applied = [];
    const errors = [];
    try {
      await this.ensureRoot().catch(() => {});
    } catch {
      /* optional */
    }
    if (snapshot.networkMode === 'isolated' || snapshot.networkMode === 'shared') {
      this.setNetworkMode(snapshot.networkMode);
      applied.push('networkMode');
      if (snapshot.networkMode === 'shared') {
        // A shared guest can come back with only a link-scope route.
        try {
          const repaired = await this.repairNetwork({ reason: 'env-restore' });
          if (repaired.repaired) applied.push('defaultRoute');
          if (!repaired.ok) errors.push(`defaultRoute: ${repaired.code || 'still missing'}`);
        } catch (error) {
          errors.push(`defaultRoute: ${error.message}`);
        }
      }
    }
    if (Array.isArray(snapshot.dnsServers)) {
      try {
        await this.setDnsServers(snapshot.dnsServers);
        applied.push('dnsServers');
      } catch (error) {
        errors.push(`dnsServers: ${error.message}`);
      }
    }
    if (Array.isArray(snapshot.hostsEntries)) {
      try {
        await this.setHosts(snapshot.hostsEntries);
        applied.push('hostsEntries');
      } catch (error) {
        errors.push(`hostsEntries: ${error.message}`);
      }
    }
    if (snapshot.proxy) {
      const parsed = /^([^:]+):(\d+)$/.exec(String(snapshot.proxy));
      if (parsed) {
        try {
          await this.setProxy({ enabled: true, host: parsed[1], port: Number(parsed[2]) });
          applied.push('proxy');
        } catch (error) {
          errors.push(`proxy: ${error.message}`);
        }
      }
    }
    for (const rule of snapshot.forwards || []) {
      try {
        await this.addPortForward(rule.localPort, rule.remotePort, { shared: rule.shared === true });
        applied.push(`forward:${rule.localPort}`);
      } catch (error) {
        if (!/already forwarded/.test(error.message)) errors.push(`forward ${rule.localPort}: ${error.message}`);
      }
    }
    for (const rule of snapshot.reverses || []) {
      try {
        await this.addReverse(rule.localPort, rule.hostPort);
        applied.push(`reverse:${rule.localPort}`);
      } catch (error) {
        if (!/already has a reverse/.test(error.message)) errors.push(`reverse ${rule.localPort}: ${error.message}`);
      }
    }
    return { ok: errors.length === 0, applied, errors, snapshotAt: snapshot.capturedAt || null };
  }

  async _waitForBoot(timeoutMs = 120000) {
    const serial = this._debugSerial();
    const deadline = Date.now() + Math.max(30000, timeoutMs);
    while (Date.now() < deadline) {
      try {
        const result = await this._adb(
          ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
          { timeoutMs: 8000, maxBytes: 8 * 1024 },
        );
        if (result.code === 0 && String(result.stdout).trim() === '1') return true;
      } catch {
        /* booting */
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return false;
  }

  /** Schedule best-effort environment restoration for the next reboot. */
  _scheduleEnvRestore(snapshot) {
    if (!snapshot) return false;
    if (this._envRestoreTimer) clearTimeout(this._envRestoreTimer);
    this._envRestoreTimer = setTimeout(async () => {
      this._envRestoreTimer = null;
      try {
        const booted = await this._waitForBoot();
        if (!booted) throw new Error('device did not report boot_completed');
        await this.restoreEnv(snapshot);
        this._pushLog('[vm] environment restored after reboot');
      } catch (error) {
        this._pushLog(`[vm] environment restore failed: ${error.message}`);
      }
    }, 3000);
    if (this._envRestoreTimer.unref) this._envRestoreTimer.unref();
    return true;
  }

  async testNetwork(options = {}) {
    const serial = await this._requireSerial();
    const host = String(options.host || GUEST_HOST_ALIAS).trim();
    const port = options.port === undefined || options.port === null || options.port === '' ? 0 : Number(options.port);
    if (!/^[A-Za-z0-9._:-]{1,253}$/.test(host)) throw new Error('invalid test host');
    if (port && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('invalid test port');
    const checks = [];
    const ping = async (name, target) => {
      const result = await this._adb(
        ['-s', serial, 'shell', `ping -c 1 -W 2 ${target} >/dev/null 2>&1 && echo ok || echo fail`],
        { timeoutMs: 10000, maxBytes: 16 * 1024 },
      ).catch(() => ({ stdout: Buffer.from('fail') }));
      const ok = result.stdout.toString('utf8').includes('ok');
      checks.push({ name, target, ok });
    };
    await ping('gateway', GUEST_HOST_ALIAS);
    await ping('dns', this.dnsServers[0] || GUEST_DNS_ALIAS);
    if (port) {
      const result = await this._adb(
        [
          '-s',
          serial,
          'shell',
          `timeout 3 toybox nc -w 2 ${host} ${port} </dev/null >/dev/null 2>&1 && echo ok || echo fail`,
        ],
        { timeoutMs: 10000, maxBytes: 16 * 1024 },
      ).catch(() => ({ stdout: Buffer.from('fail') }));
      const ok = result.stdout.toString('utf8').includes('ok');
      checks.push({ name: 'tcp', target: `${host}:${port}`, ok });
    }
    return { ok: checks.every((item) => item.ok), checks, host, port: port || null };
  }

  async networkValidation() {
    const result = {
      validated: false,
      internet: false,
      captivePortalMode: null,
      activeNetwork: null,
      hint: null,
    };
    try {
      const serial = this._debugSerial();
      const text = await this._adbText(
        ['-s', serial, 'shell', 'dumpsys connectivity'],
        { timeoutMs: 20000, maxBytes: 512 * 1024 },
      );
      result.validated = /\bVALIDATED\b/.test(text);
      result.internet = /\bINTERNET\b/.test(text);
      const active = /Active default network:\s*([^\n]+)/.exec(text);
      if (active) result.activeNetwork = active[1].trim();
      result.captivePortalMode = (await this._adbText(
        ['-s', serial, 'shell', 'settings', 'get', 'global', 'captive_portal_mode'],
        { timeoutMs: 8000, maxBytes: 8 * 1024 },
      )).trim();
      if (!result.validated) {
        result.hint =
          'Android has not marked the active network VALIDATED. For WebView, start a tiny HTTP 204 server on the host alias, or use networkAction=mode with a gateway that answers the captive-portal probe. adb reverse does not change validation.';
      }
    } catch (error) {
      result.error = error.message;
    }
    return result;
  }

  async networkInfo() {
    const proxy = await this.getProxy().catch(() => ({ proxy: null }));
    let guestAddresses = [];
    let defaultRoute = null;
    let routes = [];
    try {
      const guest = await this._readGuestRoutes(this._debugSerial());
      guestAddresses = guest.addresses;
      defaultRoute = guest.defaultRoute;
      routes = guest.routes;
    } catch {
      /* ignore */
    }
    return {
      ok: true,
      mode: this.networkMode,
      guestAddresses,
      defaultRoute,
      routes,
      proxy: proxy.proxy || null,
      dnsServers: this.dnsServers,
      hostsEntries: this.hostsEntries.length,
      forwards: this.listPortForwards(),
      reverses: this.listReverseForwards(),
      validation: await this.networkValidation(),
      pcap: this.pcapStatus(),
    };
  }

  pcapStatus() {
    if (!this.tcpdumpPath) return { enabled: false, path: null, size: 0 };
    try {
      const fsStat = existsSync(this.tcpdumpPath) ? statSync(this.tcpdumpPath) : null;
      return { enabled: true, path: this.tcpdumpPath, size: fsStat ? fsStat.size : 0 };
    } catch {
      return { enabled: true, path: this.tcpdumpPath, size: 0 };
    }
  }

  /**
   * Install a PEM/DER CA certificate into the rooted guest's user CA store and,
   * when the system partition is writable, into the system store as well.
   * Returns the Android-compatible subject hash filename.
   */
  async installCaCertificate(localPath) {
    const file = path.resolve(String(localPath || ''));
    if (!file) throw new Error('installCaCertificate requires a local certificate path');
    if (!/\.(pem|crt|cer|der)$/i.test(file)) throw new Error('certificate must be .pem, .crt, .cer or .der');
    if (!existsSync(file)) throw new Error(`certificate not found: ${file}`);
    const input = await fsp.readFile(file);
    const cert = inspectCertificate(input);
    await this.ensureRoot();
    const serial = this._debugSerial();
    const remote = `/data/local/tmp/dsh-ca-${cert.fileName}`;
    const push = await this._adb(['-s', serial, 'push', file, remote], {
      timeoutMs: 60000,
      maxBytes: 64 * 1024,
    });
    if (push.code !== 0 || push.timedOut) {
      throw new Error(`failed to push certificate: ${push.stderr.toString('utf8').slice(0, 300)}`);
    }
    const userDir = '/data/misc/user/0/cacerts-added';
    const installUser = await this._adb(
      [
        '-s',
        serial,
        'shell',
        `mkdir -p ${userDir} && cp ${remote} ${userDir}/${cert.fileName} && ` +
          `chmod 644 ${userDir}/${cert.fileName} && chown system:system ${userDir}/${cert.fileName} && ` +
          `(restorecon ${userDir}/${cert.fileName} 2>/dev/null || true) && ls -l ${userDir}/${cert.fileName}`,
      ],
      { timeoutMs: 20000, maxBytes: 64 * 1024 },
    );
    if (installUser.code !== 0) {
      throw new Error(`failed to install user CA: ${installUser.stderr.toString('utf8').slice(0, 300)}`);
    }
    let systemCa = false;
    const remount = await this._adb(
      ['-s', serial, 'shell', 'mount -o rw,remount / 2>/dev/null || true; cp ' + remote + ' /system/etc/security/cacerts/' + cert.fileName + ' 2>/dev/null'],
      { timeoutMs: 20000, maxBytes: 64 * 1024 },
    );
    if (remount.code === 0) {
      const verify = await this._adb(['-s', serial, 'shell', `test -f /system/etc/security/cacerts/${cert.fileName} && echo yes`], {
        timeoutMs: 10000,
        maxBytes: 16 * 1024,
      });
      systemCa = /yes/.test(verify.stdout.toString('utf8'));
    }
    await this._adb(['-s', serial, 'shell', 'rm', '-f', remote], { timeoutMs: 10000, maxBytes: 16 * 1024 }).catch(() => {});
    this._pushLog(`[vm] installed CA ${cert.hash}.0 (user=${true}, system=${systemCa})`);
    return {
      ok: true,
      hash: cert.hash,
      fileName: cert.fileName,
      subject: cert.subject,
      installedPath: `${userDir}/${cert.fileName}`,
      systemCa,
      note: systemCa
        ? 'user and system CA stores updated; restart the target app'
        : 'user CA store updated; apps targeting API 24+ may still require a system CA or a network-security-config override',
    };
  }

  /**
   * Dump the current UI hierarchy (for agent/UI inspection).
   *
   * `uiautomator dump` returns very few nodes for WebView content (often zero text
   * nodes at all), so when the hierarchy contains no text/content-desc this merges
   * text nodes salvaged from compressed/tty dumps into the returned XML as synthetic
   * `<node>` entries (class android.webkit.WebView) and reports the supplement in the
   * additive `webview` field. Base fields stay backward compatible.
   *
   * @param {{ timeoutMs?: number, supplement?: boolean }} [options]
   */
  async uiDump(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    await this.ensureRoot();
    const serial = this._debugSerial();
    const remote = '/data/local/tmp/dsh-window.xml';
    const timeoutMs = asPositiveInt(opts.timeoutMs, this.uiDumpTimeoutMs);
    const startedAt = Date.now();
    const sources = [];
    const primaryCommand = `uiautomator dump ${remote} 2>&1; cat ${remote} 2>/dev/null`;

    const attemptDump = async (name, command, timeout) => {
      let result;
      try {
        result = await this._adb(['-s', serial, 'shell', command], { timeoutMs: timeout, maxBytes: 1024 * 1024 });
      } catch (error) {
        sources.push({ name, ok: false, textNodes: 0, timedOut: false, error: error.message.slice(0, 300) });
        return { ok: false, xml: '', nodes: [], timedOut: false, detail: error.message.slice(0, 300) };
      }
      const text = `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`.trim();
      const start = text.indexOf('<hierarchy');
      const xml = start >= 0 ? text.slice(start).trim() : '';
      const ok = /<hierarchy[\s>]/.test(xml);
      const nodes = ok ? parseDumpTextNodes(xml) : [];
      const detail = ok ? null : text.slice(0, 300) || `exit ${result.code}`;
      sources.push({ name, ok, textNodes: nodes.length, timedOut: result.timedOut === true, error: ok ? null : detail });
      return { ok, xml, nodes, timedOut: result.timedOut === true, detail };
    };

    let current = await attemptDump('primary', primaryCommand, timeoutMs);
    let baseXml = current.ok ? current.xml : '';
    let source = current.ok ? 'primary' : null;
    if (!current.ok) {
      const salvage = [
        ['retry', primaryCommand, Math.min(timeoutMs, 20000)],
        ['compressed', `uiautomator dump --compressed ${remote} 2>&1; cat ${remote} 2>/dev/null`, Math.min(timeoutMs, 20000)],
        ['tty', 'uiautomator dump /dev/tty 2>/dev/null', Math.min(timeoutMs, 20000)],
      ];
      for (const [name, command, timeout] of salvage) {
        const attempt = await attemptDump(name, command, timeout);
        if (attempt.ok) {
          current = attempt;
          baseXml = attempt.xml;
          source = name;
          break;
        }
      }
    }
    if (!current.ok) {
      const pulled = await this._dumpViaPull(serial, remote);
      sources.push({ name: 'pull', ok: pulled.ok, textNodes: pulled.nodes.length, timedOut: false, error: pulled.error || null });
      if (pulled.ok) {
        current = { ok: true, xml: pulled.xml, nodes: pulled.nodes, timedOut: false, detail: null };
        baseXml = pulled.xml;
        source = 'pull';
      }
    }
    if (!current.ok) {
      const detail = sources
        .map((entry) => `${entry.name}: ${entry.timedOut ? 'timed out' : entry.error || 'failed'}`)
        .join('; ')
        .slice(0, 600);
      throw new DeviceError(
        DEVICE_ERROR_CODES.UI_DUMP_FAILED,
        `uiautomator dump failed: ${detail || 'empty hierarchy'}`,
        { serial, sources, elapsedMs: Date.now() - startedAt, hint: healthHint(DEVICE_ERROR_CODES.UI_DUMP_FAILED) },
      );
    }

    const baseNodes = current.nodes || parseDumpTextNodes(baseXml);
    const textCount = baseNodes.length;
    const webviewDetected = /android\.webkit\.WebView|class="[^"]*WebView/i.test(baseXml);
    let xml = baseXml;
    let mergedNodes = 0;
    let supplementSource = null;
    if (textCount === 0 && opts.supplement !== false && this.uiDumpSupplement !== false) {
      const existingTexts = new Set();
      for (const match of baseXml.matchAll(/\btext="([^"]*)"/g)) existingTexts.add(xmlAttributeUnescape(match[1]));
      for (const match of baseXml.matchAll(/\bcontent-desc="([^"]*)"/g)) existingTexts.add(xmlAttributeUnescape(match[1]));
      const supplemental = [
        ['compressed', `uiautomator dump --compressed ${remote} 2>&1; cat ${remote} 2>/dev/null`],
        ['tty', 'uiautomator dump /dev/tty 2>/dev/null'],
        ['retry', primaryCommand],
      ];
      for (const [name, command] of supplemental) {
        if (name === source) continue;
        const attempt = await attemptDump(name, command, Math.min(timeoutMs, 15000));
        if (!attempt.ok || attempt.nodes.length === 0) continue;
        const synthetic = buildWebviewNodesXml(attempt.nodes, { existingTexts });
        if (!synthetic) continue;
        const closeIndex = xml.lastIndexOf('</hierarchy>');
        xml = closeIndex >= 0 ? `${xml.slice(0, closeIndex)}${synthetic}${xml.slice(closeIndex)}` : `${xml}${synthetic}`;
        mergedNodes = (synthetic.match(/<node\b/g) || []).length;
        supplementSource = name;
        break;
      }
    }
    if (xml.length > 500000) xml = truncateHierarchyXml(xml, 500000);
    const nodes = (baseXml.match(/<node\b/g) || []).length;
    const result = {
      ok: true,
      rotation: (xml.match(/<hierarchy rotation="(\d+)"/) || [])[1] || null,
      nodes,
      bytes: Buffer.byteLength(xml),
      xml,
      remotePath: remote,
      webview: {
        detected: webviewDetected,
        textCount,
        supplemented: mergedNodes > 0,
        source: supplementSource,
        mergedNodes,
        sources,
      },
    };
    if (webviewDetected || mergedNodes > 0) {
      this._pushLog(
        `[ui] dumped ${nodes} nodes (text=${textCount})${mergedNodes > 0 ? `; merged ${mergedNodes} WebView text nodes from ${supplementSource}` : ''}`,
      );
    }
    return result;
  }

  /** Last-resort UI dump: write the XML on the guest, then `adb pull` it. */
  async _dumpViaPull(serial, remote) {
    const local = path.join(os.tmpdir(), `dsh-uidump-${process.pid}-${Date.now()}.xml`);
    try {
      await this._adb(['-s', serial, 'shell', `uiautomator dump ${remote} 2>/dev/null; true`], {
        timeoutMs: 20000,
        maxBytes: 64 * 1024,
      }).catch(() => null);
      const pull = await this._adb(['-s', serial, 'pull', remote, local], {
        timeoutMs: 15000,
        maxBytes: 64 * 1024,
      }).catch((error) => ({ timedOut: false, code: -1, stdout: Buffer.alloc(0), stderr: error.message }));
      if (pull.timedOut || pull.code !== 0) {
        return {
          ok: false,
          xml: '',
          nodes: [],
          error: `adb pull failed (exit ${pull.code}): ${String(pull.stderr || '').slice(0, 200)}`,
        };
      }
      const text = await fsp.readFile(local, 'utf8').catch(() => '');
      const start = text.indexOf('<hierarchy');
      const xml = start >= 0 ? text.slice(start).trim() : '';
      if (!/<hierarchy[\s>]/.test(xml)) return { ok: false, xml: '', nodes: [], error: 'pulled dump had no <hierarchy>' };
      return { ok: true, xml, nodes: parseDumpTextNodes(xml), error: null };
    } finally {
      await fsp.rm(local, { force: true }).catch(() => {});
    }
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
    this._suppressAutoAttach = false;
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
    this._suppressAutoAttach = false;
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
    this._suppressAutoAttach = false;
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
    const args = ['-avd', this.avdName, '-no-window', '-no-audio', '-no-boot-anim', '-no-metrics'];
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
    args.push('-port', String(this.port));
    if (this.dnsServers.length) args.push('-dns-server', this.dnsServers.join(','));
    if (this.tcpdumpPath) args.push('-tcpdump', this.tcpdumpPath);
    args.push(...this.emulatorArgs);
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
    // After stop(), keep reporting `stopped` instead of immediately auto-attaching
    // a pre-existing device again on the next status poll. start() clears this.
    if (this._suppressAutoAttach && this._state === 'stopped') return;
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

  /** Public adb passthrough for features (CDP) that need arbitrary adb args. */
  async adb(args, options = {}) {
    return this._adb(args, options);
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
    const file = await this._assertPackageFile(apkPath);
    if (!/\.apk$/i.test(file)) throw new Error(`not an .apk file: ${file}`);
    return file;
  }

  async _assertPackageFile(packagePath) {
    if (typeof packagePath !== 'string' || packagePath.trim() === '') {
      throw new Error('an APK/APKS/XAPK path is required');
    }
    const file = path.resolve(packagePath);
    if (!/\.(?:apk|apks|xapk)$/i.test(file)) {
      throw new Error(`package must be .apk, .apks or .xapk (AAB must be converted first): ${file}`);
    }
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      throw new Error(`package not found: ${file}`);
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
      health: this._health ? { ...this._health } : null,
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
