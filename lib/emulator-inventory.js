/**
 * Unified emulator inventory: Android emulators/AVDs/devices available on this
 * host *and* on saved remote SSH hosts, in one stable JSON document.
 *
 * Wiring example (the panel exposes this as `GET /apk-vm/emulators`):
 *
 *   import {
 *     collectLocalInventory,
 *     collectRemoteInventory,
 *     buildEmulatorInventory,
 *   } from './lib/emulator-inventory.js';
 *
 *   const local = await collectLocalInventory({
 *     emulatorPath,            // optional; derived from sdkRoot when omitted
 *     adbPath,                 // optional; derived from sdkRoot when omitted
 *     avdHome,                 // default: ANDROID_AVD_HOME || ~/.android/avd
 *     sdkRoot,
 *     runningInstances: instanceManager.list(), // {id, avdName, serial, kind, state}
 *   });
 *   const remotes = await Promise.all(profiles.map((profile) =>
 *     collectRemoteInventory({ profile, timeoutMs: 8000 })));
 *   sendJson(res, 200, buildEmulatorInventory({ local, remotes }));
 *
 * Design rules (all functions in this module follow them):
 *   - zero dependencies, pure ESM, works on Node >= 20;
 *   - every filesystem and child_process access is injectable (`fs`, `exec`)
 *     so spikes are hermetic and fast; a missing tool never throws;
 *   - `collectLocalInventory`/`collectRemoteInventory`/`buildEmulatorInventory`
 *     never throw for expected failures — they return `{ok:false, error}` plus
 *     empty/default data instead. Parse helpers are total: garbage in, empty
 *     list/object out;
 *   - remote collection uses exactly ONE non-interactive ssh invocation with
 *     section markers to avoid several slow round trips; profile values are
 *     validated and single-quote escaped before they reach a shell, and the
 *     resulting inventory only exposes `{host, user, sshPort, sdkRoot}` from a
 *     profile (never key paths, key material or the ssh executable path).
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Bounded timeout for each local `emulator`/`adb` probe. */
export const DEFAULT_LOCAL_TIMEOUT_MS = 5000;
/** Bounded timeout for the single remote ssh inventory invocation. */
export const DEFAULT_REMOTE_TIMEOUT_MS = 8000;
/** Per-stream output cap for injected/child_process exec calls. */
export const DEFAULT_EXEC_MAX_BYTES = 512 * 1024;
/** Section markers printed by the remote inventory command. */
export const REMOTE_SECTION = Object.freeze({
  avds: '@@SECTION:AVDS',
  devices: '@@SECTION:DEVICES',
  host: '@@SECTION:HOST',
});

const ARCH_RE = /^(?:x86_64|amd64|aarch64|arm64|armv[5-8]l?|i[3-6]86|ppc64le?|s390x|riscv64|mips64?)$/i;
const HOSTNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const SERIAL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ADB_DEVICE_STATES = new Set([
  'device',
  'offline',
  'unauthorized',
  'no permissions',
  'recovery',
  'sideload',
  'bootloader',
  'fastboot',
  'host',
  'connecting',
  'authorizing',
  'disconnected',
]);
const AVD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REMOTE_HOST_RE = /^[A-Za-z0-9._:-]{1,253}$/;
const REMOTE_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const SSH_PATH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/\\:-]{0,499}$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

// ---------------------------------------------------------------------------
// Small tolerant primitives
// ---------------------------------------------------------------------------

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toText(value) {
  if (value === undefined || value === null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value);
}

/** Trim and cap free-form text; strips non-printable control characters. */
function cleanText(value, max = 500) {
  const text = toText(value).replace(CONTROL_CHARS_RE, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function nullableText(value, max = 500) {
  const text = cleanText(value, max);
  return text ? text : null;
}

function shortError(error, max = 300) {
  if (error === undefined || error === null) return 'unknown error';
  const message = isRecord(error) && error.message !== undefined ? error.message : error;
  return cleanText(message, max) || 'unknown error';
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function positiveIntOrNull(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number);
}

function nonNegativeIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = toText(value).trim();
    if (text) return text;
  }
  return '';
}

function expandHome(value, home = os.homedir()) {
  const text = toText(value).trim();
  if (!text) return '';
  if (text === '~') return home;
  if (/^~[\\/]/.test(text)) return path.join(home, text.slice(2));
  return text;
}

/** True for Windows drive paths and POSIX/UNC absolute paths (both separators). */
function isAbsoluteAny(value) {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(toText(value));
}

function sortByName(a, b) {
  const left = String(a && a.name ? a.name : '').toLowerCase();
  const right = String(b && b.name ? b.name : '').toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  const rawLeft = String(a && a.name ? a.name : '');
  const rawRight = String(b && b.name ? b.name : '');
  return rawLeft < rawRight ? -1 : rawLeft > rawRight ? 1 : 0;
}

function uniqueStrings(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const text = cleanText(item, 400);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// AVD home + AVD config parsing
// ---------------------------------------------------------------------------

/**
 * Default AVD directory: `ANDROID_AVD_HOME` when set, else `<home>/.android/avd`.
 * `env`/`platform`/`home` are injectable for tests (defaults: process/os).
 */
export function defaultAvdHome(options = {}) {
  const opts = isRecord(options) ? options : {};
  const env = isRecord(opts.env) ? opts.env : process.env;
  const home = firstNonEmpty(opts.home) || os.homedir();
  const fromEnv = expandHome(env.ANDROID_AVD_HOME, home);
  if (fromEnv) return fromEnv;
  return path.join(home, '.android', 'avd');
}

/**
 * Parse one AVD `.ini`/`config.ini` file into a flat object.
 *
 * Tolerant by design: BOM, CRLF, `#`/`;` comments, `[section]` lines, spaces
 * around `=`, missing trailing newline and values containing `=` are handled.
 * Returns `{}` for non-string input; never throws.
 */
export function parseAvdIni(text) {
  const out = {};
  try {
    const clean = toText(text).replace(/^\uFEFF/, '');
    for (const rawLine of clean.split(/\r\n?|\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('#') || line.startsWith(';')) continue;
      if (line.startsWith('[') && line.endsWith(']')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!key) continue;
      let value = line.slice(eq + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch {
    /* total parser: garbage in, {} out */
  }
  return out;
}

function configValue(config, ...keys) {
  for (const key of keys) {
    const value = config[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function toIntOrNull(value) {
  const text = toText(value).trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

/** Parse `1536M`, `2G`, `512 MB`, `6442450944` into a number. */
function parseSizeNumber(value) {
  const text = toText(value).trim();
  if (!text) return null;
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:I?B)?$/i.exec(text);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  const unit = match[2].toUpperCase();
  const multiplier =
    unit === 'K' ? 1024 : unit === 'M' ? 1024 ** 2 : unit === 'G' ? 1024 ** 3 : unit === 'T' ? 1024 ** 4 : 1;
  return Math.round(number * multiplier);
}

/** `hw.ramSize` is MB by convention (`1536M` or a bare `1536`). */
function parseRamMb(value) {
  const text = toText(value).trim();
  if (!text) return null;
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:I?B)?$/i.exec(text);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  const unit = match[2].toUpperCase();
  if (unit === 'G') return Math.round(number * 1024);
  if (unit === 'K') return Math.round(number / 1024);
  if (unit === 'T') return Math.round(number * 1024 * 1024);
  return Math.round(number);
}

function parseHwLcd(config) {
  const width = toIntOrNull(config['hw.lcd.width']);
  const height = toIntOrNull(config['hw.lcd.height']);
  if (width === null || height === null || width <= 0 || height <= 0) return null;
  return {
    width,
    height,
    density: toIntOrNull(config['hw.lcd.density']),
  };
}

function sysdirSegments(value) {
  return toText(value)
    .trim()
    .split(/[\\/]+/)
    .filter(Boolean);
}

/** Resolve `image.sysdir.1` against an optional local SDK root. */
function resolveSysdir(sdkRoot, relative) {
  const raw = toText(relative).trim();
  if (!raw) return null;
  if (!sdkRoot) return raw;
  const segments = sysdirSegments(raw);
  if (!segments.length) return sdkRoot;
  return path.join(sdkRoot, ...segments);
}

function deriveTarget(ini, config) {
  const explicit = configValue(ini, 'target') || configValue(config, 'target');
  if (explicit) return explicit;
  const sysdir = configValue(config, 'image.sysdir.1', 'image.sysdir.2');
  const match = /(?:^|[\\/])android-(\d+)(?:[\\/]|$)/.exec(sysdir);
  if (match) return `android-${match[1]}`;
  return null;
}

function deriveAbi(config) {
  const explicit = configValue(config, 'abi.type', 'hw.cpu.arch').toLowerCase();
  if (explicit) return explicit;
  const segments = sysdirSegments(configValue(config, 'image.sysdir.1'));
  const last = segments.length ? segments[segments.length - 1].toLowerCase() : '';
  return /^(?:x86_64|x86|arm64-v8a|armeabi-v7a|mips|mips64)$/.test(last) ? last : null;
}

/** Resolve the `.avd` directory from `path`/`path.rel`, defaulting to `<avdHome>/<name>.avd`. */
function resolveAvdPath(ini, avdHome, name) {
  const declared = toText(ini.path).trim();
  if (declared) {
    return isAbsoluteAny(declared) ? declared : path.resolve(avdHome, declared);
  }
  const relative = toText(ini['path.rel']).trim();
  if (relative) return path.resolve(avdHome, relative);
  return path.join(avdHome, `${name}.avd`);
}

function fileSystemFor(override) {
  if (!isRecord(override)) return fsp;
  return {
    readdir: typeof override.readdir === 'function' ? override.readdir : fsp.readdir,
    readFile: typeof override.readFile === 'function' ? override.readFile : fsp.readFile,
    stat: typeof override.stat === 'function' ? override.stat : fsp.stat,
  };
}

function direntInfo(entry) {
  if (typeof entry === 'string') return { name: entry, file: true };
  if (!isRecord(entry)) return null;
  const name = toText(entry.name);
  if (!name) return null;
  let file = true;
  if (typeof entry.isFile === 'function') {
    try {
      file = entry.isFile() === true;
    } catch {
      file = true;
    }
  }
  return { name, file };
}

function makeAvd(name, fields = {}) {
  return {
    name,
    path: fields.path === undefined ? null : fields.path,
    target: fields.target === undefined ? null : fields.target,
    abi: fields.abi === undefined ? null : fields.abi,
    sysdir: fields.sysdir === undefined ? null : fields.sysdir,
    hwLcd: fields.hwLcd === undefined ? null : fields.hwLcd,
    hwRamMb: fields.hwRamMb === undefined ? null : fields.hwRamMb,
    diskBytes: fields.diskBytes === undefined ? null : fields.diskBytes,
    snapshotCount: fields.snapshotCount === undefined ? null : fields.snapshotCount,
    ...(fields.error ? { error: fields.error } : {}),
  };
}

async function scanOneAvd(io, avdHome, name, sdkRoot) {
  const iniPath = path.join(avdHome, `${name}.ini`);
  let ini;
  try {
    ini = parseAvdIni(await io.readFile(iniPath, 'utf8'));
  } catch (error) {
    return makeAvd(name, {
      path: path.join(avdHome, `${name}.avd`),
      error:
        error && error.code === 'ENOENT'
          ? 'missing AVD ini'
          : `unreadable AVD ini (${shortError(error, 120)})`,
    });
  }
  const avdPath = resolveAvdPath(ini, avdHome, name);
  let config = {};
  let error;
  try {
    config = parseAvdIni(await io.readFile(path.join(avdPath, 'config.ini'), 'utf8'));
  } catch (cause) {
    error =
      cause && cause.code === 'ENOENT'
        ? 'missing config.ini'
        : `unreadable config.ini (${shortError(cause, 120)})`;
  }
  let snapshotCount = null;
  try {
    const snapshots = await io.readdir(path.join(avdPath, 'snapshots'), { withFileTypes: true });
    snapshotCount = Array.isArray(snapshots) ? snapshots.length : null;
  } catch (cause) {
    snapshotCount = cause && cause.code === 'ENOENT' ? 0 : null;
  }
  const sysdir = resolveSysdir(sdkRoot, configValue(config, 'image.sysdir.1'));
  return makeAvd(name, {
    path: avdPath,
    target: deriveTarget(ini, config),
    abi: deriveAbi(config),
    sysdir,
    hwLcd: parseHwLcd(config),
    hwRamMb: parseRamMb(configValue(config, 'hw.ramSize')),
    diskBytes: parseSizeNumber(configValue(config, 'disk.dataPartition.size')),
    snapshotCount,
    ...(error ? { error } : {}),
  });
}

function resolveAvdHome(options, env) {
  const explicit = expandHome(options.avdHome, options.home || os.homedir());
  if (explicit) return explicit;
  return defaultAvdHome({
    env,
    platform: options.platform || process.platform,
    home: options.home || os.homedir(),
  });
}

/**
 * Scan `avdHome` and report diagnostics: `{ok, avdHome, avds, error?}`.
 * Never throws for unreadable directories or broken AVD configs.
 */
export async function scanLocalAvdsReport(options = {}) {
  const opts = isRecord(options) ? options : {};
  const env = isRecord(opts.env) ? opts.env : process.env;
  let avdHome;
  try {
    avdHome = resolveAvdHome(opts, env);
  } catch (error) {
    return { ok: false, avdHome: null, avds: [], error: shortError(error) };
  }
  const io = fileSystemFor(opts.fs);
  const sdkRoot = firstNonEmpty(opts.sdkRoot);
  let entries;
  try {
    entries = await io.readdir(avdHome, { withFileTypes: true });
  } catch (error) {
    return {
      ok: true,
      avdHome,
      avds: [],
      error: `AVD home is not readable (${shortError(error, 200)})`,
    };
  }
  const names = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const info = direntInfo(entry);
    if (!info || !info.file) continue;
    if (!/\.ini$/i.test(info.name)) continue;
    const name = info.name.slice(0, -4);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || (a < b ? -1 : a > b ? 1 : 0));
  const avds = [];
  try {
    for (const name of names) {
      avds.push(await scanOneAvd(io, avdHome, name, sdkRoot));
    }
  } catch (error) {
    return { ok: false, avdHome, avds, error: shortError(error) };
  }
  return { ok: true, avdHome, avds };
}

/**
 * List locally installed AVDs from the AVD home (filesystem only; no tools are
 * spawned). Always returns an array; broken entries carry an `error` field.
 */
export async function scanLocalAvds(options = {}) {
  const report = await scanLocalAvdsReport(options);
  return report.avds;
}

// ---------------------------------------------------------------------------
// Text parsers for tool output (`emulator -list-avds`, `adb devices -l`, host)
// ---------------------------------------------------------------------------

/**
 * Parse `adb devices -l` output.
 * Returns `[{serial, state, product?, model?, device?, transportId?}]`.
 * Handles CRLF, network serials, offline/unauthorized/no-permissions states and
 * skips adb daemon/header/error lines. Never throws.
 */
export function parseAdbDevices(text) {
  const out = [];
  const seen = new Set();
  try {
    const clean = toText(text).replace(/\r\n?/g, '\n');
    for (const rawLine of clean.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^list of devices attached\b/i.test(line)) continue;
      if (/^[*-]/.test(line)) continue;
      if (/^(?:adb|error|warning|failed|unknown|cannot|unable)\b/i.test(line)) continue;
      const tokens = line.split(/\s+/);
      if (tokens.length < 2) continue;
      const serial = tokens[0];
      if (!SERIAL_RE.test(serial)) continue;
      let state = tokens[1].toLowerCase();
      let index = 2;
      if (state === 'no' && (tokens[2] || '').toLowerCase() === 'permissions') {
        state = 'no permissions';
        index = 3;
      } else if (!ADB_DEVICE_STATES.has(state)) {
        continue;
      }
      const device = { serial, state };
      for (; index < tokens.length; index += 1) {
        const field = /^([A-Za-z][A-Za-z0-9_]*):(.*)$/.exec(tokens[index]);
        if (!field) continue;
        const key = field[1];
        const value = field[2];
        if (key === 'product' || key === 'model' || key === 'device') {
          device[key] = cleanText(value, 128);
        } else if (key === 'transport_id') {
          const transportId = Number(value);
          device.transportId = Number.isFinite(transportId) ? transportId : cleanText(value, 64);
        }
      }
      if (seen.has(serial)) continue;
      seen.add(serial);
      out.push(device);
    }
  } catch {
    /* total parser: garbage in, [] out */
  }
  return out;
}

/**
 * Parse `emulator -list-avds` stdout into AVD names. Trims CRLF/blank lines,
 * ignores INFO/WARNING/ERROR/PANIC chatter and shell "not found" noise, and
 * dedupes while preserving order. Never throws.
 */
export function parseEmulatorList(text) {
  const out = [];
  const seen = new Set();
  try {
    const clean = toText(text).replace(/\r\n?/g, '\n');
    for (const rawLine of clean.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^(?:INFO|WARNING|WARN|ERROR|ERR|FATAL|PANIC|DEBUG|TRACE)\b/i.test(line)) continue;
      if (/^(?:[>*#$]|sh:|bash:|emulator:|adb:|zsh:)/i.test(line)) continue;
      if (/command not found|no such file|permission denied|missing emulator engine|could not launch|failed to (?:load|start|launch)/i.test(line)) {
        continue;
      }
      // AVD names are shell/path friendly and never contain whitespace; this
      // also filters multi-word error messages that slipped past the prefixes.
      if (/\s/.test(line)) continue;
      if (line.length > 128) continue;
      if (!AVD_NAME_RE.test(line)) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
  } catch {
    /* total parser: garbage in, [] out */
  }
  return out;
}

/**
 * Parse Linux `uptime` output into
 * `{text, up, upSeconds, users, loadAverage}`. Returns null-ish fields for
 * unparseable input; never throws.
 */
export function parseUptime(text) {
  const raw = cleanText(text, 300);
  const out = { text: raw, up: null, upSeconds: null, users: null, loadAverage: [] };
  if (!raw) return out;
  try {
    const loadMatch = /load averages?:\s*([0-9][0-9.,\s]*)/i.exec(raw);
    if (loadMatch) {
      const values = loadMatch[1]
        .replace(/,/g, ' ')
        .trim()
        .split(/\s+/)
        .slice(0, 3)
        .map(Number)
        .filter((value) => Number.isFinite(value));
      if (values.length) out.loadAverage = values;
    }
    const usersMatch = /(\d+)\s+users?\b/i.exec(raw);
    if (usersMatch) out.users = Number(usersMatch[1]);
    const upMatch = /\bup\s+(.+?)(?=,\s*\d+\s+users?\b|,\s*load averages?:|$)/i.exec(raw);
    if (upMatch) {
      const span = upMatch[1].replace(/\s+/g, ' ').replace(/,\s*$/, '').trim();
      if (span) {
        out.up = `up ${span}`;
        let seconds = 0;
        let matched = false;
        const days = /(\d+)\s+days?\b/i.exec(span);
        if (days) {
          seconds += Number(days[1]) * 86400;
          matched = true;
        }
        const hoursMinutes = /(\d+):(\d{2})/.exec(span);
        if (hoursMinutes) {
          seconds += Number(hoursMinutes[1]) * 3600 + Number(hoursMinutes[2]) * 60;
          matched = true;
        }
        const minutes = /(\d+)\s+min(?:ute)?s?/i.exec(span);
        if (minutes) {
          seconds += Number(minutes[1]) * 60;
          matched = true;
        }
        if (matched) out.upSeconds = seconds;
      }
    }
  } catch {
    /* total parser */
  }
  return out;
}

/**
 * Parse the remote host section (`hostname; uname -m; uptime`) into
 * `{hostname, arch, uptime}`. Missing/garbled commands leave `null` fields;
 * never throws.
 */
export function parseHostInfo(text) {
  const out = { hostname: null, arch: null, uptime: null };
  try {
    const lines = toText(text)
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (!out.arch && ARCH_RE.test(line)) {
        out.arch = line;
        continue;
      }
      if (
        !out.uptime &&
        (/load averages?:/i.test(line) || /(?:^|\s)up\s+\d/i.test(line))
      ) {
        const parsed = parseUptime(line);
        out.uptime = parsed.up || cleanText(line, 200) || null;
        continue;
      }
      if (!out.hostname && HOSTNAME_RE.test(line) && !ARCH_RE.test(line)) {
        out.hostname = line;
      }
    }
  } catch {
    /* total parser */
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bounded exec (default child_process runner + injected runner support)
// ---------------------------------------------------------------------------

/**
 * Default exec runner with the injected-exec contract:
 * `(file, args, {timeoutMs, maxBytes, env}) => Promise<{code, stdout, stderr,
 * error, timedOut}>`. argv-only (no shell), output-bounded, timeout-bounded,
 * never rejects.
 */
export function defaultExec(file, args, options = {}) {
  const opts = isRecord(options) ? options : {};
  const timeoutMs = clampInt(opts.timeoutMs, DEFAULT_LOCAL_TIMEOUT_MS, 250, 120000);
  const maxBytes = clampInt(opts.maxBytes, DEFAULT_EXEC_MAX_BYTES, 1024, 16 * 1024 * 1024);
  const env = isRecord(opts.env) ? { ...process.env, ...opts.env } : process.env;
  return new Promise((resolve) => {
    if (typeof file !== 'string' || !file.trim()) {
      resolve({ code: null, stdout: '', stderr: '', error: 'missing executable path', timedOut: false });
      return;
    }
    let child;
    try {
      child = spawn(file, Array.isArray(args) ? args.map(String) : [], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', error: shortError(error), timedOut: false });
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let settled = false;
    let timer = null;
    const append = (chunks, state, chunk) => {
      if (settled || !chunk || chunk.length === 0 || state.bytes >= maxBytes) return;
      const remaining = maxBytes - state.bytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(Buffer.from(slice));
      state.bytes += slice.length;
    };
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        error: null,
        timedOut: false,
        ...extra,
      });
    };
    if (child.stdout) child.stdout.on('data', (chunk) => append(stdoutChunks, stdoutState, chunk));
    if (child.stderr) child.stderr.on('data', (chunk) => append(stderrChunks, stderrState, chunk));
    child.once('error', (error) => finish({ error: shortError(error) }));
    child.once('close', (code) => finish({ code: typeof code === 'number' ? code : null }));
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ timedOut: true, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
  });
}

function normalizeExecResult(raw, maxBytes) {
  if (!isRecord(raw)) {
    return { code: null, stdout: '', stderr: '', error: 'exec returned no result object', timedOut: false };
  }
  let stdout = toText(raw.stdout);
  let stderr = toText(raw.stderr);
  if (stdout.length > maxBytes) stdout = stdout.slice(0, maxBytes);
  if (stderr.length > maxBytes) stderr = stderr.slice(0, maxBytes);
  let code = null;
  if (raw.code !== undefined && raw.code !== null && raw.code !== '') {
    const number = Number(raw.code);
    if (Number.isFinite(number)) code = number;
  }
  return {
    code,
    stdout,
    stderr,
    error: raw.error === undefined || raw.error === null ? null : shortError(raw.error),
    timedOut: raw.timedOut === true,
  };
}

/** Race a promise against a hard deadline so a broken injected exec cannot hang us. */
function raceHardTimeout(promise, timeoutMs) {
  let timer = null;
  const guarded = Promise.resolve(promise).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ hardTimeout: true }), Math.max(50, timeoutMs));
  });
  return Promise.race([guarded, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Run one exec call through the (possibly injected) runner. Never rejects:
 * thrown errors and hard timeouts become `{code:null, error, timedOut}`.
 */
async function runExecBounded(exec, file, args, options = {}) {
  const timeoutMs = clampInt(options.timeoutMs, DEFAULT_LOCAL_TIMEOUT_MS, 250, 120000);
  const maxBytes = clampInt(options.maxBytes, DEFAULT_EXEC_MAX_BYTES, 1024, 16 * 1024 * 1024);
  const callOptions = { timeoutMs, maxBytes, ...(options.env ? { env: options.env } : {}) };
  const raced = await raceHardTimeout(
    Promise.resolve().then(() => exec(file, args, callOptions)),
    timeoutMs + 1500,
  );
  if (raced.hardTimeout) {
    return {
      code: null,
      stdout: '',
      stderr: '',
      error: `exec timed out after ${timeoutMs}ms`,
      timedOut: true,
    };
  }
  if (raced.error !== undefined) {
    return { code: null, stdout: '', stderr: '', error: shortError(raced.error), timedOut: false };
  }
  return normalizeExecResult(raced.value, maxBytes);
}

// ---------------------------------------------------------------------------
// Running-instance merge helpers
// ---------------------------------------------------------------------------

/**
 * Normalize instance summaries (`{id, avdName, serial, kind, state}`) into a
 * JSON-safe array; drops malformed entries and optionally remote instances.
 */
export function normalizeRunningInstances(list, options = {}) {
  const out = [];
  if (!Array.isArray(list)) return out;
  const excludeRemote = options.excludeRemote === true;
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = item.id === undefined || item.id === null ? null : cleanText(item.id, 120) || null;
    const avdName = item.avdName === undefined || item.avdName === null ? null : cleanText(item.avdName, 128) || null;
    const kind = item.kind === undefined || item.kind === null ? null : cleanText(item.kind, 32) || null;
    if (excludeRemote && kind === 'remote') continue;
    if (id === null && avdName === null) continue;
    out.push({
      id,
      avdName,
      serial: item.serial === undefined || item.serial === null ? null : cleanText(item.serial, 128) || null,
      kind,
      state: item.state === undefined || item.state === null ? 'unknown' : cleanText(item.state, 32) || 'unknown',
    });
  }
  return out;
}

function runningRef(instance) {
  return {
    instanceId: instance.id === undefined ? null : instance.id,
    serial: instance.serial === undefined ? null : instance.serial,
    state: instance.state === undefined ? 'unknown' : instance.state,
  };
}

/**
 * Attach `running` references to AVDs (case-insensitive fallback for Windows)
 * and append AVDs that are only known from a running instance. Mutates and
 * returns the given array.
 */
function attachRunningInstances(avds, runningInstances) {
  const byExact = new Map();
  const byLower = new Map();
  for (const avd of avds) {
    if (!byExact.has(avd.name)) byExact.set(avd.name, avd);
    const lower = avd.name.toLowerCase();
    if (!byLower.has(lower)) byLower.set(lower, avd);
  }
  const append = [];
  for (const instance of runningInstances) {
    if (!instance.avdName) continue;
    const target = byExact.get(instance.avdName) || byLower.get(instance.avdName.toLowerCase());
    if (target) {
      if (!target.running) target.running = runningRef(instance);
      continue;
    }
    const placeholder = makeAvd(instance.avdName, {});
    placeholder.source = 'running';
    placeholder.running = runningRef(instance);
    append.push(placeholder);
    byExact.set(placeholder.name, placeholder);
    byLower.set(placeholder.name.toLowerCase(), placeholder);
  }
  for (const avd of append) avds.push(avd);
  return avds;
}

// ---------------------------------------------------------------------------
// Local collection
// ---------------------------------------------------------------------------

function toolExecNote(label, result, timeoutMs) {
  if (!result) return null;
  if (result.hardTimeout === true) return `${label} timed out after ${timeoutMs}ms`;
  if (result.timedOut) return `${label} timed out after ${timeoutMs}ms`;
  if (result.error) return `${label} failed: ${shortError(result.error, 200)}`;
  if (result.code !== null && result.code !== 0) {
    const detail = cleanText(result.stderr || result.stdout, 200);
    return `${label} exited with code ${result.code}${detail ? `: ${detail}` : ''}`;
  }
  return null;
}

function normalizeScannedAvd(avd) {
  if (!isRecord(avd)) return null;
  const name = cleanText(avd.name, 128);
  if (!name) return null;
  return makeAvd(name, {
    path: nullableText(avd.path, 4096),
    target: nullableText(avd.target, 128),
    abi: nullableText(avd.abi, 64),
    sysdir: nullableText(avd.sysdir, 4096),
    hwLcd: isRecord(avd.hwLcd)
      ? {
          width: positiveIntOrNull(avd.hwLcd.width),
          height: positiveIntOrNull(avd.hwLcd.height),
          density: nonNegativeIntOrNull(avd.hwLcd.density),
        }
      : null,
    hwRamMb: positiveIntOrNull(avd.hwRamMb),
    diskBytes: positiveIntOrNull(avd.diskBytes),
    snapshotCount: nonNegativeIntOrNull(avd.snapshotCount),
    ...(avd.error ? { error: cleanText(avd.error, 300) } : {}),
  });
}

function mergeLocalAvds(scanned, emulatorNames, runningInstances) {
  const byName = new Map();
  const byLower = new Map();
  const lookup = (name) => byName.get(name) || byLower.get(name.toLowerCase());
  const remember = (avd) => {
    byName.set(avd.name, avd);
    if (!byLower.has(avd.name.toLowerCase())) byLower.set(avd.name.toLowerCase(), avd);
    return avd;
  };
  for (const raw of scanned) {
    const avd = normalizeScannedAvd(raw);
    if (!avd) continue;
    if (lookup(avd.name)) continue;
    avd.source = 'filesystem';
    avd.running = null;
    remember(avd);
  }
  for (const rawName of Array.isArray(emulatorNames) ? emulatorNames : []) {
    const name = cleanText(rawName, 128);
    if (!name) continue;
    const existing = lookup(name);
    if (existing) {
      if (existing.source === 'filesystem') existing.source = 'both';
      continue;
    }
    const placeholder = makeAvd(name, {});
    placeholder.source = 'emulator';
    placeholder.running = null;
    remember(placeholder);
  }
  const avds = [...byName.values()];
  attachRunningInstances(avds, runningInstances);
  return avds.sort(sortByName);
}

/**
 * Collect the local emulator inventory.
 *
 * Runs `emulator -list-avds` and `adb devices -l` when binaries are configured
 * (or derivable from `sdkRoot`), concurrently with a filesystem AVD scan, then
 * merges everything. Bounded timeouts; missing tools/thrown execs/timeouts are
 * reported in `notes` instead of throwing.
 *
 * Returns `{ok, avdHome, emulatorPath, adbPath, avds, devices,
 * runningInstances, notes}`; catastrophic failures return `ok:false, error`.
 * Every AVD has `running: {instanceId, serial, state} | null` and a `source`
 * (`filesystem` | `emulator` | `both` | `running`).
 */
export async function collectLocalInventory(options = {}) {
  const opts = isRecord(options) ? options : {};
  const env = isRecord(opts.env) ? opts.env : process.env;
  const timeoutMs = clampInt(opts.timeoutMs, DEFAULT_LOCAL_TIMEOUT_MS, 500, 30000);
  const exec = typeof opts.exec === 'function' ? opts.exec : defaultExec;
  const platform = opts.platform || process.platform;
  let avdHome;
  try {
    avdHome = resolveAvdHome(opts, env);
  } catch (error) {
    return {
      ok: false,
      avdHome: null,
      emulatorPath: null,
      adbPath: null,
      avds: [],
      devices: [],
      runningInstances: [],
      notes: [],
      error: shortError(error),
    };
  }
  const sdkRoot = firstNonEmpty(opts.sdkRoot, env.ANDROID_SDK_ROOT, env.ANDROID_HOME);
  const exeSuffix = platform === 'win32' ? '.exe' : '';
  const emulatorPath =
    firstNonEmpty(opts.emulatorPath) ||
    (sdkRoot ? path.join(sdkRoot, 'emulator', `emulator${exeSuffix}`) : null);
  const adbPath =
    firstNonEmpty(opts.adbPath) ||
    (sdkRoot ? path.join(sdkRoot, 'platform-tools', `adb${exeSuffix}`) : null);
  const runningInstances = normalizeRunningInstances(opts.runningInstances, { excludeRemote: true });
  const notes = [];

  const scanTask = scanLocalAvdsReport({
    avdHome,
    sdkRoot: sdkRoot || undefined,
    fs: opts.fs,
    env,
    platform,
    home: opts.home,
  }).catch((error) => ({ ok: false, avdHome, avds: [], error: shortError(error) }));
  const emulatorTask = emulatorPath
    ? runExecBounded(exec, emulatorPath, ['-list-avds'], {
        timeoutMs,
        maxBytes: DEFAULT_EXEC_MAX_BYTES,
        env: { ANDROID_AVD_HOME: avdHome, ...(isRecord(opts.env) ? opts.env : {}) },
      })
    : Promise.resolve(null);
  const adbTask = adbPath
    ? runExecBounded(exec, adbPath, ['devices', '-l'], {
        timeoutMs,
        maxBytes: DEFAULT_EXEC_MAX_BYTES,
      })
    : Promise.resolve(null);

  let scanReport;
  let emulatorResult;
  let adbResult;
  try {
    [scanReport, emulatorResult, adbResult] = await Promise.all([scanTask, emulatorTask, adbTask]);
  } catch (error) {
    return {
      ok: false,
      avdHome,
      emulatorPath,
      adbPath,
      avds: [],
      devices: [],
      runningInstances,
      notes,
      error: shortError(error),
    };
  }

  if (scanReport && scanReport.error) notes.push(`AVD scan: ${scanReport.error}`);
  const emulatorNames = emulatorResult ? parseEmulatorList(emulatorResult.stdout) : [];
  const emulatorNote = toolExecNote('emulator -list-avds', emulatorResult, timeoutMs);
  if (emulatorNote) notes.push(emulatorNote);
  const devices = adbResult ? parseAdbDevices(adbResult.stdout) : [];
  const adbNote = toolExecNote('adb devices', adbResult, timeoutMs);
  if (adbNote) notes.push(adbNote);
  if (!emulatorPath) {
    notes.push('emulator binary is not configured; AVDs were only read from the filesystem');
  }
  if (!adbPath) {
    notes.push('adb binary is not configured; connected devices are unavailable');
  }
  if (emulatorResult && emulatorResult.timedOut && emulatorNames.length === 0) {
    notes.push('emulator -list-avds timed out before printing any AVD');
  }
  if (adbResult && adbResult.timedOut && devices.length === 0) {
    notes.push('adb devices timed out before printing any device');
  }

  const avds = mergeLocalAvds(scanReport && scanReport.avds, emulatorNames, runningInstances);
  return {
    ok: true,
    avdHome,
    emulatorPath: emulatorPath || null,
    adbPath: adbPath || null,
    avds,
    devices,
    runningInstances,
    notes: uniqueStrings(notes),
  };
}

// ---------------------------------------------------------------------------
// Remote collection (one ssh invocation, section markers)
// ---------------------------------------------------------------------------

/** Quote one string as a POSIX `sh` word (single quotes, `'` escaped). */
function quotePosix(value) {
  const text = toText(value);
  if (!text) throw new Error('remote command argument is empty');
  if (CONTROL_CHARS_RE.test(text)) throw new Error('remote command argument contains control characters');
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function normalizeSshPort(value, fallback = 22) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) return fallback;
  return number;
}

function requireRemoteHost(value) {
  const host = toText(value).trim();
  if (!host) throw new Error('remote inventory requires an SSH host');
  if (!REMOTE_HOST_RE.test(host)) {
    throw new Error(`invalid SSH host: ${JSON.stringify(host.slice(0, 80))}`);
  }
  return host;
}

function requireRemoteUser(value) {
  const user = toText(value).trim();
  if (!user) return 'root';
  if (!REMOTE_USER_RE.test(user)) {
    throw new Error(`invalid SSH user: ${JSON.stringify(user.slice(0, 80))}`);
  }
  return user;
}

function optionalRemotePath(value, label) {
  const text = toText(value).trim();
  if (!text) return '';
  if (text.length > 500) throw new Error(`${label} is too long`);
  if (CONTROL_CHARS_RE.test(text)) throw new Error(`${label} contains control characters`);
  return text;
}

function optionalSshFile(value, label) {
  const text = toText(value).trim();
  if (!text) return '';
  if (text.length > 1000) throw new Error(`${label} is too long`);
  if (CONTROL_CHARS_RE.test(text)) throw new Error(`${label} contains control characters`);
  return text;
}

function trimRemoteSlash(value) {
  return String(value).replace(/[\\/]+$/, '');
}

/**
 * Build the single remote inventory command + ssh argv.
 *
 * Returns `{host, user, sshPort, sshPath, sdkRoot, emulatorPath, adbPath,
 * timeoutMs, maxBytes, command, args}` where `args` is the full ssh argv
 * (everything after the ssh executable). Throws on invalid/injection-shaped
 * profile values; the caller (`collectRemoteInventory`) catches and reports it.
 */
export function buildRemoteInventoryCommand(profile = {}, options = {}) {
  const src = isRecord(profile) ? profile : {};
  const opts = isRecord(options) ? options : {};
  const host = requireRemoteHost(src.host);
  const user = requireRemoteUser(src.user);
  const sshPort = normalizeSshPort(src.sshPort, 22);
  const timeoutMs = clampInt(opts.timeoutMs, DEFAULT_REMOTE_TIMEOUT_MS, 1000, 120000);
  const maxBytes = clampInt(opts.maxBytes, DEFAULT_EXEC_MAX_BYTES, 4096, 4 * 1024 * 1024);
  const sdkRoot = optionalRemotePath(src.sdkRoot, 'remote SDK root');
  const emulatorPath =
    optionalRemotePath(src.emulatorPath, 'remote emulator path') ||
    (sdkRoot ? `${trimRemoteSlash(sdkRoot)}/emulator/emulator` : 'emulator');
  const adbPath =
    optionalRemotePath(src.adbPath, 'remote adb path') ||
    (sdkRoot ? `${trimRemoteSlash(sdkRoot)}/platform-tools/adb` : 'adb');
  const keyPath = optionalSshFile(src.keyPath, 'remote SSH key path');
  const sshPath = optionalSshFile(src.sshPath, 'ssh executable') || 'ssh';
  if (!SSH_PATH_RE.test(sshPath)) throw new Error(`invalid ssh executable: ${JSON.stringify(sshPath.slice(0, 80))}`);

  const command = [
    `echo ${REMOTE_SECTION.avds}`,
    `${quotePosix(emulatorPath)} -list-avds 2>&1`,
    `echo ${REMOTE_SECTION.devices}`,
    `${quotePosix(adbPath)} devices -l 2>&1`,
    `echo ${REMOTE_SECTION.host}`,
    'hostname 2>&1',
    'uname -m 2>&1',
    'uptime 2>&1',
  ].join('; ');

  const connectTimeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
  const args = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${connectTimeoutSec}`];
  if (keyPath) args.push('-i', keyPath);
  args.push('-p', String(sshPort), `${user}@${host}`, command);

  return {
    host,
    user,
    sshPort,
    sshPath,
    sdkRoot: sdkRoot || null,
    emulatorPath,
    adbPath,
    timeoutMs,
    maxBytes,
    command,
    args,
  };
}

function splitMarkerSections(stdout) {
  const text = toText(stdout);
  const sections = { avds: null, devices: null, host: null };
  const found = [];
  const markerRe = /@@SECTION:(AVDS|DEVICES|HOST)\r?\n?/g;
  const marks = [];
  let match;
  while ((match = markerRe.exec(text))) {
    marks.push({ key: match[1].toLowerCase(), start: match.index, contentStart: markerRe.lastIndex });
  }
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    const end = index + 1 < marks.length ? marks[index + 1].start : text.length;
    sections[mark.key] = text.slice(mark.contentStart, end);
    found.push(mark.key);
  }
  return { sections, found, sawMarker: marks.length > 0 };
}

function firstMeaningfulLine(text) {
  for (const rawLine of toText(text).replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (line) return cleanText(line, 200);
  }
  return '';
}

/**
 * Parse the marker-delimited remote output into `{avds, devices, host, notes}`.
 * Tolerant of missing markers/sections, shell "not found" noise and garbage.
 */
export function parseRemoteInventoryOutput(stdout) {
  const { sections, found } = splitMarkerSections(stdout);
  const notes = [];
  const avds = [];
  const devices = [];
  let host = { hostname: null, arch: null, uptime: null };
  if (!found.length) {
    notes.push('remote output could not be parsed (no section markers)');
    return { avds, devices, host, notes };
  }
  for (const key of ['avds', 'devices', 'host']) {
    if (sections[key] === null) notes.push(`remote output is missing the ${key} section`);
  }
  if (sections.avds !== null) {
    const names = parseEmulatorList(sections.avds);
    for (const name of names) avds.push({ name, target: null, path: null });
    if (!names.length) {
      if (/command not found|not found|no such file|permission denied|panic|could not launch/i.test(sections.avds)) {
        notes.push('remote emulator is not available');
      } else if (firstMeaningfulLine(sections.avds)) {
        notes.push('remote emulator output could not be parsed');
      }
    }
  }
  if (sections.devices !== null) {
    devices.push(...parseAdbDevices(sections.devices));
    if (!devices.length) {
      if (/command not found|not found|no such file|permission denied/i.test(sections.devices)) {
        notes.push('remote adb is not available');
      } else if (/error:/i.test(sections.devices)) {
        notes.push(`remote adb reported an error: ${firstMeaningfulLine(sections.devices)}`);
      }
    }
  }
  if (sections.host !== null) {
    host = parseHostInfo(sections.host);
    if (!host.hostname && !host.arch && !host.uptime && sections.host.trim()) {
      notes.push('remote host information could not be parsed');
    }
  }
  return { avds, devices, host, notes: uniqueStrings(notes) };
}

/** Public, secret-free view of a remote profile. */
function publicRemoteProfile(profile) {
  const src = isRecord(profile) ? profile : {};
  return {
    host: nullableText(src.host, 253),
    user: nullableText(src.user, 64),
    sshPort: normalizeSshPort(src.sshPort, 22),
    sdkRoot: nullableText(src.sdkRoot, 500),
  };
}

function emptyRemoteHost(reachable) {
  return { reachable, hostname: null, arch: null, uptime: null, note: null };
}

/**
 * Collect the inventory of one remote SSH host using exactly ONE ssh
 * invocation. Never throws: invalid profiles, ssh failures, timeouts and
 * partial/garbage output become `{ok:false, error}` or `note` fields.
 *
 * Returns `{ok, profile:{host,user,sshPort,sdkRoot}, host:{reachable, hostname,
 * arch, uptime, note}, avds:[{name,target,path}], devices:[...], error?}`.
 */
export async function collectRemoteInventory(options = {}) {
  const opts = isRecord(options) ? options : {};
  const exec = typeof opts.exec === 'function' ? opts.exec : defaultExec;
  const timeoutMs = clampInt(opts.timeoutMs, DEFAULT_REMOTE_TIMEOUT_MS, 1000, 120000);
  const publicProfile = publicRemoteProfile(opts.profile);
  const fail = (error) => ({
    ok: false,
    profile: publicProfile,
    host: emptyRemoteHost(false),
    avds: [],
    devices: [],
    error: shortError(error, 400),
  });

  let built;
  try {
    built = buildRemoteInventoryCommand(opts.profile, { timeoutMs, maxBytes: opts.maxBytes });
  } catch (error) {
    return fail(error);
  }
  const result = await runExecBounded(exec, built.sshPath, built.args, {
    timeoutMs,
    maxBytes: built.maxBytes,
    env: isRecord(opts.env) ? opts.env : undefined,
  });
  if (result.timedOut) return fail(`remote inventory timed out after ${timeoutMs}ms`);
  if (result.error) return fail(`ssh failed: ${shortError(result.error, 300)}`);
  if (result.code !== null && result.code !== 0) {
    const detail = cleanText(result.stderr || result.stdout, 300);
    return fail(`ssh exited with code ${result.code}${detail ? `: ${detail}` : ''}`);
  }
  const parsed = parseRemoteInventoryOutput(result.stdout);
  const note = parsed.notes.length ? parsed.notes.join('; ') : null;
  return {
    ok: true,
    profile: {
      host: built.host,
      user: built.user,
      sshPort: built.sshPort,
      sdkRoot: built.sdkRoot,
    },
    host: {
      reachable: true,
      hostname: hostField(parsed.host.hostname),
      arch: hostField(parsed.host.arch),
      uptime: hostField(parsed.host.uptime),
      note,
    },
    avds: parsed.avds,
    devices: parsed.devices,
  };
}

function hostField(value) {
  const text = cleanText(value, 500);
  return text ? text : null;
}

// ---------------------------------------------------------------------------
// Inventory assembly
// ---------------------------------------------------------------------------

function normalizeUpdatedAt(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text && Number.isFinite(Date.parse(text))) return text;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return new Date(number).toISOString();
  return new Date().toISOString();
}

function normalizeHwLcd(value) {
  if (!isRecord(value)) return null;
  const width = positiveIntOrNull(value.width);
  const height = positiveIntOrNull(value.height);
  if (width === null || height === null) return null;
  return { width, height, density: nonNegativeIntOrNull(value.density) };
}

function normalizeAvdEntry(avd) {
  if (!isRecord(avd)) return null;
  const name = cleanText(avd.name, 128);
  if (!name) return null;
  const source = cleanText(avd.source, 32) || 'filesystem';
  return {
    name,
    path: nullableText(avd.path, 4096),
    target: nullableText(avd.target, 128),
    abi: nullableText(avd.abi, 64),
    sysdir: nullableText(avd.sysdir, 4096),
    hwLcd: normalizeHwLcd(avd.hwLcd),
    hwRamMb: positiveIntOrNull(avd.hwRamMb),
    diskBytes: positiveIntOrNull(avd.diskBytes),
    snapshotCount: nonNegativeIntOrNull(avd.snapshotCount),
    source,
    running: normalizeRunningRef(avd.running),
    ...(avd.error ? { error: cleanText(avd.error, 300) } : {}),
  };
}

function normalizeRunningRef(value) {
  if (!isRecord(value)) return null;
  return {
    instanceId: value.instanceId === undefined ? null : nullableText(value.instanceId, 120),
    serial: value.serial === undefined ? null : nullableText(value.serial, 128),
    state: nullableText(value.state, 32) || 'unknown',
  };
}

function dedupeAvds(avlList) {
  const byName = new Map();
  const byLower = new Map();
  const lookup = (name) => byName.get(name) || byLower.get(name.toLowerCase());
  for (const avd of avlList) {
    const existing = lookup(avd.name);
    if (!existing) {
      byName.set(avd.name, avd);
      if (!byLower.has(avd.name.toLowerCase())) byLower.set(avd.name.toLowerCase(), avd);
      continue;
    }
    // Merge missing facts from later duplicates (never throw information away).
    for (const key of ['path', 'target', 'abi', 'sysdir', 'hwLcd', 'hwRamMb', 'diskBytes', 'snapshotCount', 'error']) {
      if (existing[key] === null || existing[key] === undefined) {
        if (avd[key] !== null && avd[key] !== undefined) existing[key] = avd[key];
      }
    }
    if (!existing.running && avd.running) existing.running = avd.running;
    if (existing.source !== avd.source) existing.source = 'both';
  }
  return [...byName.values()].sort(sortByName);
}

function dedupeDevices(deviceList) {
  const out = [];
  const seen = new Set();
  for (const device of deviceList) {
    if (!isRecord(device)) continue;
    const serial = cleanText(device.serial, 256);
    if (!serial || seen.has(serial)) continue;
    seen.add(serial);
    const entry = { serial, state: cleanText(device.state, 32) || 'unknown' };
    for (const key of ['product', 'model', 'device']) {
      const value = nullableText(device[key], 128);
      if (value) entry[key] = value;
    }
    const transportId = Number(device.transportId);
    if (Number.isFinite(transportId)) entry.transportId = transportId;
    out.push(entry);
  }
  return out;
}

function normalizeLocalInventory(local) {
  const src = isRecord(local) ? local : {};
  const runningInstances = normalizeRunningInstances(src.runningInstances, { excludeRemote: true });
  const avds = [];
  for (const raw of Array.isArray(src.avds) ? src.avds : []) {
    const avd = normalizeAvdEntry(raw);
    if (avd) avds.push(avd);
  }
  const normalized = dedupeAvds(avds);
  attachRunningInstances(normalized, runningInstances);
  normalized.sort(sortByName);
  const out = {
    avds: normalized,
    devices: dedupeDevices(Array.isArray(src.devices) ? src.devices : []),
    runningInstances,
  };
  if (src.error) out.error = cleanText(src.error, 500);
  const notes = Array.isArray(src.notes) ? uniqueStrings(src.notes) : [];
  if (notes.length) out.notes = notes;
  return out;
}

function normalizeRemoteEntry(remote) {
  const src = isRecord(remote) ? remote : {};
  const hostSrc = isRecord(src.host) ? src.host : {};
  const avds = [];
  for (const raw of Array.isArray(src.avds) ? src.avds : []) {
    if (!isRecord(raw)) continue;
    const name = cleanText(raw.name, 128);
    if (!name) continue;
    avds.push({
      name,
      target: nullableText(raw.target, 128),
      path: nullableText(raw.path, 4096),
    });
  }
  const dedupedAvds = [];
  const seenAvds = new Set();
  for (const avd of avds) {
    const key = avd.name.toLowerCase();
    if (seenAvds.has(key)) continue;
    seenAvds.add(key);
    dedupedAvds.push(avd);
  }
  dedupedAvds.sort(sortByName);
  const entry = {
    ok: src.ok !== false,
    profile: publicRemoteProfile(src.profile),
    host: {
      reachable: hostSrc.reachable === true,
      hostname: nullableText(hostSrc.hostname, 253),
      arch: nullableText(hostSrc.arch, 64),
      uptime: nullableText(hostSrc.uptime, 200),
      note: nullableText(hostSrc.note, 500),
    },
    avds: dedupedAvds,
    devices: dedupeDevices(Array.isArray(src.devices) ? src.devices : []),
  };
  if (src.error) entry.error = cleanText(src.error, 500);
  return entry;
}

function normalizeRemotes(remotes) {
  if (!Array.isArray(remotes)) return [];
  const out = [];
  for (const remote of remotes) {
    if (!isRecord(remote)) continue;
    out.push(normalizeRemoteEntry(remote));
  }
  return out;
}

/**
 * Assemble the final stable, JSON-safe inventory document:
 * `{ok, updatedAt, local:{avds, devices, runningInstances, error?}, remotes:[...]}`.
 *
 * Dedupes devices by serial and AVDs by name within each host, attaches
 * running-instance references, sorts AVDs by name, and strips every remote
 * profile down to `{host, user, sshPort, sdkRoot}`. Never throws: bad input
 * becomes empty/default collections with `ok:true`, except unexpected internal
 * failures which return `ok:false`.
 */
export function buildEmulatorInventory(options = {}) {
  const opts = isRecord(options) ? options : {};
  const updatedAt = normalizeUpdatedAt(opts.updatedAt);
  try {
    return {
      ok: true,
      updatedAt,
      local: normalizeLocalInventory(opts.local),
      remotes: normalizeRemotes(opts.remotes),
    };
  } catch (error) {
    return {
      ok: false,
      updatedAt,
      local: { avds: [], devices: [], runningInstances: [] },
      remotes: [],
      error: shortError(error),
    };
  }
}
