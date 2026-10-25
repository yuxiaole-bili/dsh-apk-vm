/**
 * lib/setup.js — dependency-free Android SDK / emulator / AVD environment
 * detection and safe one-click setup actions for the APK VM preview panel.
 *
 * Scope
 * -----
 * The rest of the plugin (`lib/android.js`) assumes a bootable AVD already
 * exists. This module answers the "can this machine boot an Android VM at
 * all?" question from pure Node.js built-ins and exposes the three repair
 * actions a user needs when the answer is "not yet":
 *
 *   detectEnvironment()  -> report: SDK, adb, emulator, command-line tools,
 *                           system image, AVD, CPU acceleration, missing items
 *                           and the currently available repair actions.
 *   createAvd()          -> `avdmanager create avd -n <name> -k <image> -d pixel_5 --force`
 *   installSystemImage() -> `sdkmanager --install <image>` (licenses optional)
 *   setupReport()        -> plain-text diagnostics summary for UI/logs.
 *
 * Hard constraints honored here:
 *   - No npm dependencies; only `node:` built-in modules.
 *   - No shell: every external program is launched with
 *     `child_process.spawn(exe, argvArray)`; no command string is ever built
 *     from user data. The single documented exception is Windows batch shims
 *     (`sdkmanager.bat` / `avdmanager.bat`), which the OS cannot execute
 *     without a `cmd.exe` trampoline: the batch path and every argument are
 *     still passed as separate argv entries (never concatenated/quoted into a
 *     shell string), so no user-controlled text is interpreted by a shell.
 *   - Every command is timeout-bounded and its output is byte-bounded.
 *   - `detectEnvironment()` never downloads anything and never mutates the
 *     machine: it only reads the filesystem and runs tiny read-only probes
 *     (`emulator -version`, `emulator-check accel`, `sysctl`, `sc query`).
 *   - Cross-platform: Windows, macOS and Linux layouts are discovered;
 *     `.exe` suffixes are resolved on Windows.
 *
 * Discovery/verification notes
 * ----------------------------
 *   - SDK roots, in order: explicit `options.sdkRoot` -> `ANDROID_SDK_ROOT`
 *     -> `ANDROID_HOME` -> common per-OS install locations. When a caller
 *     supplies an `options.env` map, discovery is *isolated* to the explicit
 *     options plus that map (no host common locations, no host fallbacks);
 *     this is what makes the hermetic smoke test deterministic on CI.
 *   - A system image is considered installed when the payload directory
 *     `<sdk>/system-images/<api>/<tag>/<abi>/` exists.
 *   - An AVD is considered present when `<avdHome>/<name>.avd/` or
 *     `<avdHome>/<name>.ini` exists, honoring ANDROID_AVD_HOME,
 *     ANDROID_EMULATOR_HOME, ANDROID_USER_HOME and ~/.android/avd.
 *   - Acceleration is authoritative when `emulator-check accel` yields a
 *     parseable answer; otherwise OS-level fallbacks are used (Linux
 *     `/dev/kvm`, macOS `sysctl -n kern.hv_support`, Windows `sc query`
 *     AEHD/HAXM service hints).
 *   - `avdmanager`/`sdkmanager` are Java programs. `createAvd()` and
 *     `installSystemImage()` perform a bounded read-only JDK search
 *     (JAVA_HOME, siblings of the SDK root such as `D:\Android\jdk-17.0.2`,
 *     Android Studio's bundled JBR, common per-OS JDK locations) and inject
 *     the result as JAVA_HOME into that child process's environment only.
 *     The public return shapes are unchanged; without a JDK the tools report
 *     their own "JAVA_HOME is not set" failure through `ok:false`.
 *
 * Export contract (stable; the Lead integrates routes/UI against it)
 * -------------------------------------------------------------------
 *   DEFAULT_SYSTEM_IMAGE = 'system-images;android-34;default;x86_64'
 *   DEFAULT_AVD_NAME     = 'dsh_apk'
 *   detectEnvironment(options) -> report object (see JSDoc below)
 *   createAvd(options)         -> { ok, avdName, command, output, error? }
 *   installSystemImage(options) -> { ok, image, command, output, error? }
 *   setupReport(options)       -> string
 *
 * `options` for every function: `sdkRoot`, `avdName`, `systemImage`,
 * `adbPath`, `emulatorPath`, `exec`, `timeoutMs`. Additional advanced/test
 * hooks: `env` (complete environment map; isolates discovery), `platform`
 * (OS override used by the smoke test), `avdHome` (explicit AVD directory).
 * `installSystemImage()` additionally accepts `acceptLicenses: true`.
 *
 * An injectable `exec` has the shape
 *   `(file: string, args: string[], opts: {timeoutMs, maxBytes, stdin?, env?})
 *      => Promise<{code, stdout, stderr, timedOut?, truncated?, error?}>`
 * where stdout/stderr may be strings or Buffers. It must never throw for
 * ordinary command failures (a throw is treated as a spawn error).
 *
 * Expected environment failures are reported as `ok: false` with an `error`
 * message instead of throwing. Only programmer errors (wrong option types,
 * invalid avdName/systemImage) throw `TypeError`.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** AOSP/Google x86_64 API 34 image used by the verified local setup. */
export const DEFAULT_SYSTEM_IMAGE = 'system-images;android-34;default;x86_64';

/** Default AVD name expected by `lib/android.js` when spawning the emulator. */
export const DEFAULT_AVD_NAME = 'dsh_apk';

// Bounds: slow enough for cold Java/Python shims, never unbounded.
const DEFAULT_DETECT_TIMEOUT_MS = 15 * 1000;
const DEFAULT_CREATE_TIMEOUT_MS = 120 * 1000;
const DEFAULT_INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_ERROR_OUTPUT_CHARS = 4000;
const MAX_REPORT_CHARS = 12 * 1024;

const AVD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SYSTEM_IMAGE_RE = /^system-images;[^;\s]+;[^;\s]+;[^;\s]+$/;

// ---------------------------------------------------------------------------
// Tiny shared helpers
// ---------------------------------------------------------------------------

function toText(value) {
  if (value === undefined || value === null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value);
}

function boundedText(text, limit) {
  const value = toText(text);
  return value.length > limit ? value.slice(0, limit) : value;
}

function statSafe(target) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

function isFile(target) {
  const stats = statSafe(target);
  return Boolean(stats && stats.isFile());
}

function isDirectory(target) {
  const stats = statSafe(target);
  return Boolean(stats && stats.isDirectory());
}

/** Join path fragments using the separator of `platform` (test override safe). */
function joinFor(platform, ...parts) {
  const filtered = parts.filter((part) => part !== undefined && part !== null && part !== '');
  if (filtered.length === 0) return '';
  if (platform === process.platform) return path.join(...filtered);
  return filtered.map((part) => String(part)).join(platform === 'win32' ? '\\' : '/');
}

/** `path.dirname` for the requested platform (test override safe). */
function dirnameFor(platform, value) {
  const text = String(value || '');
  if (platform === process.platform) return path.dirname(text);
  const index = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
  return index <= 0 ? '.' : text.slice(0, index);
}

function pathKey(value, platform) {
  const text = path.resolve(String(value));
  return platform === 'win32' ? text.toLowerCase() : text;
}

function pathsEqual(left, right, platform) {
  return Boolean(left) && Boolean(right) && pathKey(left, platform) === pathKey(right, platform);
}

function dedupePaths(values, platform) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const key = pathKey(value, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(String(value));
  }
  return result;
}

function compareVersionsDesc(left, right) {
  const split = (value) => String(value).match(/\d+|[^\d]+/g) || [];
  const leftParts = split(left);
  const rightParts = split(right);
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    const aNumber = Number(a);
    const bNumber = Number(b);
    if (!Number.isNaN(aNumber) && !Number.isNaN(bNumber)) {
      if (aNumber !== bNumber) return bNumber - aNumber;
    } else if (a !== b) {
      return b.localeCompare(a);
    }
  }
  return 0;
}

/** Directory names inside `dir`, newest-looking first; never throws. */
function listSubdirectories(dir, platform = process.platform) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = [];
  for (const entry of entries) {
    const fullPath = joinFor(platform, dir, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(fullPath))) {
      names.push(entry.name);
    }
  }
  names.sort(compareVersionsDesc);
  return names;
}

/** Bounded, deduplicated human-readable list for verbose "checked ..." hints. */
function summarizeCandidates(values, limit = 4) {
  const shown = values.slice(0, limit);
  const suffix = values.length > shown.length ? `, +${values.length - shown.length} more` : '';
  return `${shown.join(', ')}${suffix}`;
}

// ---------------------------------------------------------------------------
// Option/env normalization (programmer errors throw TypeError here)
// ---------------------------------------------------------------------------

function normalizeOptions(options, functionName) {
  if (options === undefined || options === null) options = {};
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError(`${functionName}(options): options must be a plain object`);
  }

  const readPath = (name) => {
    const value = options[name];
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') {
      throw new TypeError(`${functionName}(options): options.${name} must be a non-empty string`);
    }
    return path.resolve(value);
  };

  const envProvided = options.env !== undefined;
  if (envProvided && (typeof options.env !== 'object' || options.env === null || Array.isArray(options.env))) {
    throw new TypeError(`${functionName}(options): options.env must be an environment map`);
  }
  const env = envProvided ? options.env : process.env;

  const platform =
    options.platform === undefined || options.platform === null || options.platform === ''
      ? process.platform
      : String(options.platform);

  let timeoutMs = null;
  if (options.timeoutMs !== undefined && options.timeoutMs !== null) {
    const value = Number(options.timeoutMs);
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${functionName}(options): options.timeoutMs must be a positive number`);
    }
    timeoutMs = Math.floor(value);
  }

  let exec = null;
  if (options.exec !== undefined && options.exec !== null) {
    if (typeof options.exec !== 'function') {
      throw new TypeError(`${functionName}(options): options.exec must be a function`);
    }
    exec = options.exec;
  }

  let avdName = options.avdName;
  if (avdName === undefined || avdName === null || avdName === '') {
    avdName = DEFAULT_AVD_NAME;
  } else if (typeof avdName !== 'string' || !AVD_NAME_RE.test(avdName)) {
    throw new TypeError(
      `${functionName}(options): options.avdName ${JSON.stringify(
        options.avdName,
      )} is not a valid AVD name (letters/digits/._-, no path separators)`,
    );
  }

  let systemImage = options.systemImage;
  if (systemImage === undefined || systemImage === null || systemImage === '') {
    systemImage = DEFAULT_SYSTEM_IMAGE;
  } else if (typeof systemImage !== 'string' || !SYSTEM_IMAGE_RE.test(systemImage)) {
    throw new TypeError(
      `${functionName}(options): options.systemImage must look like ` +
        `"system-images;<api>;<tag>;<abi>" (received ${JSON.stringify(options.systemImage)})`,
    );
  }

  const avdHome = readPath('avdHome');

  return {
    functionName,
    sdkRoot: readPath('sdkRoot'),
    adbPath: readPath('adbPath'),
    emulatorPath: readPath('emulatorPath'),
    avdHome,
    avdName,
    systemImage,
    exec,
    timeoutMs,
    env,
    envProvided,
    platform,
    acceptLicenses: options.acceptLicenses === true,
  };
}

function envPathValue(env) {
  if (!env) return '';
  return toText(env.PATH || env.Path || env.path || '');
}

function homeDirFor(opts) {
  if (opts.envProvided) {
    return (
      (opts.env.HOME && String(opts.env.HOME)) ||
      (opts.env.USERPROFILE && String(opts.env.USERPROFILE)) ||
      null
    );
  }
  return os.homedir();
}

/** First existing executable named `binaryName` in the environment's PATH. */
function findOnPath(binaryName, env, platform) {
  const dirs = envPathValue(env).split(platform === 'win32' ? ';' : ':');
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = joinFor(platform, dir, binaryName);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** SDK roots, most explicit first (see module header for the isolation rule). */
function candidateSdkRoots(opts) {
  const roots = [];
  const add = (value) => {
    if (value === undefined || value === null) return;
    const text = String(value).trim();
    if (text) roots.push(text);
  };

  add(opts.sdkRoot);
  add(opts.env.ANDROID_SDK_ROOT);
  add(opts.env.ANDROID_HOME);

  // An explicit `env` means "isolated discovery environment": explicit options
  // plus that map only. Host common locations are used only for real runs.
  if (!opts.envProvided) {
    const home = homeDirFor(opts);
    if (opts.platform === 'win32') {
      add(opts.env.LOCALAPPDATA && joinFor(opts.platform, opts.env.LOCALAPPDATA, 'Android', 'Sdk'));
      add(
        opts.env.USERPROFILE &&
          joinFor(opts.platform, opts.env.USERPROFILE, 'AppData', 'Local', 'Android', 'Sdk'),
      );
      add(home && joinFor(opts.platform, home, 'AppData', 'Local', 'Android', 'Sdk'));
      add('C:\\Android\\Sdk');
      add('C:\\Android\\sdk');
      // Verified location on the development host; still validated by stat().
      add('D:\\Android\\sdk');
    } else if (opts.platform === 'darwin') {
      add(home && joinFor(opts.platform, home, 'Library', 'Android', 'sdk'));
      add('/usr/local/share/android-sdk');
      add('/opt/homebrew/share/android-sdk');
      add('/opt/android-sdk');
    } else {
      add(home && joinFor(opts.platform, home, 'Android', 'Sdk'));
      add(home && joinFor(opts.platform, home, 'Android', 'sdk'));
      add(home && joinFor(opts.platform, home, 'android-sdk'));
      add('/usr/local/share/android-sdk');
      add('/usr/lib/android-sdk');
      add('/usr/local/lib/android/sdk');
      add('/opt/android-sdk');
      add('/opt/android-sdk-linux');
      add('/snap/android-sdk/current');
    }
  }

  return dedupePaths(roots, opts.platform);
}

/** AVD location honoring the same env vars as lib/android.js, plus `avdHome`. */
function resolveAvdLocation(opts) {
  let avdHome = opts.avdHome || null;
  if (!avdHome) {
    if (opts.env.ANDROID_AVD_HOME) avdHome = path.resolve(String(opts.env.ANDROID_AVD_HOME));
    else if (opts.env.ANDROID_EMULATOR_HOME) {
      avdHome = joinFor(opts.platform, path.resolve(String(opts.env.ANDROID_EMULATOR_HOME)), 'avd');
    } else if (opts.env.ANDROID_USER_HOME) {
      avdHome = joinFor(opts.platform, path.resolve(String(opts.env.ANDROID_USER_HOME)), 'avd');
    } else {
      const home = homeDirFor(opts);
      avdHome = home ? joinFor(opts.platform, home, '.android', 'avd') : null;
    }
  }

  if (!avdHome) return { avdHome: null, avdPath: null, iniPath: null };
  return {
    avdHome,
    avdPath: joinFor(opts.platform, avdHome, `${opts.avdName}.avd`),
    iniPath: joinFor(opts.platform, avdHome, `${opts.avdName}.ini`),
  };
}

// ---------------------------------------------------------------------------
// Bounded argv-only process execution (no shell, injectable)
// ---------------------------------------------------------------------------

function spawnTarget(file, args, env) {
  // Windows cannot CreateProcess() a .bat/.cmd directly (spawn throws EINVAL).
  // The OS itself requires the cmd.exe interpreter for batch shims, so launch
  // it with a *fixed argv array*: the shim path and every argument stay
  // separate argv entries — nothing is ever concatenated or re-quoted into a
  // shell command string, so user-controlled data is not shell-interpreted.
  if (process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(file)) {
    const comspec = (env && (env.ComSpec || env.COMSPEC)) || process.env.ComSpec || 'cmd.exe';
    return { file: comspec, args: ['/d', '/s', '/c', file, ...args] };
  }
  return { file, args };
}

function runProcess(file, args, options = {}) {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_DETECT_TIMEOUT_MS;
  const maxBytes =
    Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : DEFAULT_MAX_OUTPUT_BYTES;
  const stdin = options.stdin;
  const envOption = options.env && typeof options.env === 'object' ? options.env : null;

  return new Promise((resolve) => {
    if (typeof file !== 'string' || file.trim() === '') {
      resolve({
        code: null,
        signal: null,
        timedOut: false,
        truncated: false,
        stdout: '',
        stderr: '',
        error: 'missing executable path',
      });
      return;
    }

    const spawnEnv = envOption ? { ...process.env, ...envOption } : process.env;
    const target = spawnTarget(file, args, spawnEnv);
    let child;
    try {
      child = spawn(target.file, target.args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spawnEnv,
        cwd: options.cwd,
      });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        timedOut: false,
        truncated: false,
        stdout: '',
        stderr: '',
        error: error && error.message ? error.message : String(error),
      });
      return;
    }

    const collectors = {
      stdout: { chunks: [], bytes: 0 },
      stderr: { chunks: [], bytes: 0 },
    };
    let truncated = false;
    let settled = false;
    let timer = null;

    const collect = (collector, chunk) => {
      if (!chunk || chunk.length === 0) return;
      if (collector.bytes >= maxBytes) {
        truncated = true;
        return;
      }
      const remaining = maxBytes - collector.bytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      collector.chunks.push(Buffer.from(slice));
      collector.bytes += slice.length;
      if (slice.length < chunk.length) truncated = true;
    };

    const snapshot = (extra) => ({
      code: null,
      signal: null,
      timedOut: false,
      truncated,
      stdout: Buffer.concat(collectors.stdout.chunks).toString('utf8'),
      stderr: Buffer.concat(collectors.stderr.chunks).toString('utf8'),
      ...extra,
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on('data', (chunk) => collect(collectors.stdout, chunk));
    child.stderr.on('data', (chunk) => collect(collectors.stderr, chunk));

    child.on('error', (error) => {
      finish(
        snapshot({
          error: error && error.message ? error.message : String(error),
        }),
      );
    });

    child.on('close', (code, signal) => {
      finish(snapshot({ code: typeof code === 'number' ? code : null, signal: signal || null }));
    });

    if (child.stdin) {
      child.stdin.on('error', () => {});
      try {
        child.stdin.end(stdin === undefined || stdin === null ? '' : String(stdin));
      } catch {
        /* stdin may already be gone; the exit result still carries the failure */
      }
    }

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(snapshot({ timedOut: true, signal: 'SIGKILL' }));
    }, timeoutMs);
  });
}

/** Default exec runner: argv-only, timeout-bounded, output-bounded. */
function defaultExec(file, args, options = {}) {
  return runProcess(file, Array.isArray(args) ? args.map(String) : [], options);
}

function normalizeResult(raw, maxBytes = DEFAULT_MAX_OUTPUT_BYTES) {
  const result = raw && typeof raw === 'object' ? raw : {};
  let stdout = toText(result.stdout);
  let stderr = toText(result.stderr);
  let truncated = result.truncated === true;
  if (stdout.length > maxBytes) {
    stdout = stdout.slice(0, maxBytes);
    truncated = true;
  }
  if (stderr.length > maxBytes) {
    stderr = stderr.slice(0, maxBytes);
    truncated = true;
  }
  let code = null;
  if (Number.isFinite(result.code)) code = Number(result.code);
  else if (result.ok === true) code = 0;
  else if (result.ok === false) code = 1;
  return {
    code,
    signal: result.signal === undefined || result.signal === null ? null : String(result.signal),
    timedOut: result.timedOut === true,
    truncated,
    stdout,
    stderr,
    error:
      result.error === undefined || result.error === null
        ? null
        : String(result.error && result.error.message ? result.error.message : result.error),
  };
}

/** Run one external command through the (possibly injected) exec runner. */
async function runExec(exec, file, args, options = {}) {
  const maxBytes =
    Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : DEFAULT_MAX_OUTPUT_BYTES;
  try {
    const raw = await exec(file, Array.isArray(args) ? args.map(String) : [], options);
    return normalizeResult(raw, maxBytes);
  } catch (error) {
    return normalizeResult(
      {
        code: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        error: error && error.message ? error.message : String(error),
      },
      maxBytes,
    );
  }
}

// ---------------------------------------------------------------------------
// From-zero SDK bootstrap (command-line tools download + extraction)
// ---------------------------------------------------------------------------

const CMDLINE_TOOLS_VERSION = '11076708';
const CMDLINE_TOOLS_URLS = Object.freeze({
  win32: `https://dl.google.com/android/repository/commandlinetools-win-${CMDLINE_TOOLS_VERSION}_latest.zip`,
  darwin: `https://dl.google.com/android/repository/commandlinetools-mac-${CMDLINE_TOOLS_VERSION}_latest.zip`,
  linux: `https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip`,
});
const MAX_CMDLINE_TOOLS_BYTES = 512 * 1024 * 1024;

/** Standard SDK location used when nothing is configured/discovered. */
export function defaultSdkRoot(platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    return localAppData ? path.join(localAppData, 'Android', 'Sdk') : path.join(home, 'AppData', 'Local', 'Android', 'Sdk');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Android', 'sdk');
  return path.join(home, 'Android', 'Sdk');
}

async function downloadFileDefault(url, destination, options = {}) {
  if (!/^https:\/\//i.test(String(url))) throw new Error('command-line tools URL must use https');
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
  const maxBytes = options.maxBytes || MAX_CMDLINE_TOOLS_BYTES;
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`download too large: ${declared} bytes`);
  let bytes = 0;
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) body.destroy(new Error(`download exceeded ${maxBytes} bytes`));
  });
  await pipeline(body, createWriteStream(destination));
  return { bytes };
}

async function extractZipDefault(opts, archive, destination) {
  const exec = opts.exec || defaultExec;
  let result;
  if (opts.platform === 'win32') {
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const script = `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destination)} -Force`;
    result = await runExec(exec, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeoutMs: 5 * 60 * 1000,
      maxBytes: 2 * 1024 * 1024,
    });
  } else {
    result = await runExec(exec, 'unzip', ['-q', '-o', archive, '-d', destination], {
      timeoutMs: 5 * 60 * 1000,
      maxBytes: 2 * 1024 * 1024,
    });
  }
  if (result.timedOut) throw new Error('extracting command-line tools timed out');
  if (result.error) throw new Error(`extracting command-line tools failed: ${result.error}`);
  if (result.code !== 0) {
    throw new Error(`extracting command-line tools failed (exit ${result.code}): ${(result.stderr || result.stdout || '').slice(0, 400)}`);
  }
}

/**
 * Bootstrap a completely empty host: download Android command-line tools, extract
 * them into `<sdkRoot>/cmdline-tools/latest`, accept licenses, then install the
 * requested SDK packages. Network access only when explicitly called.
 */
export async function bootstrapSdk(options = {}) {
  const raw = options && typeof options === 'object' ? options : {};
  const opts = normalizeOptions(options, 'bootstrapSdk');
  const platform = opts.platform;
  const sdkRoot = opts.sdkRoot || defaultSdkRoot(platform, homeDirFor(opts) || os.homedir());
  const bootstrapApiLevel = String((opts.systemImage || DEFAULT_SYSTEM_IMAGE).split(';')[1] || 'android-34').replace(/^android-/, '');
  const packages = Array.isArray(raw.packages)
    ? [...new Set(raw.packages.map((value) => String(value).trim()).filter(Boolean))]
    : ['platform-tools', 'emulator', `build-tools;${bootstrapApiLevel}.0.0`, `platforms;android-${bootstrapApiLevel}`];
  const timeoutMs = opts.timeoutMs || 20 * 60 * 1000;
  const download = typeof raw.download === 'function' ? raw.download : downloadFileDefault;
  const extract = typeof raw.extract === 'function' ? raw.extract : null;

  const result = {
    ok: false,
    sdkRoot,
    platform,
    packages,
    downloaded: null,
    extracted: false,
    licenses: false,
    installed: false,
    command: '',
    output: '',
    error: null,
  };
  const fail = (message) => ({ ...result, ok: false, error: String(message).slice(0, MAX_ERROR_OUTPUT_CHARS) });

  if (packages.length === 0) return fail('bootstrapSdk requires at least one package');
  if (packages.length > 20) return fail('too many SDK packages (max 20)');
  for (const name of packages) {
    if (!/^[A-Za-z0-9._;:-]{1,120}$/.test(name)) return fail(`invalid SDK package name: ${name}`);
  }
  const url = CMDLINE_TOOLS_URLS[platform];
  if (!url) return fail(`unsupported platform for bootstrapSdk: ${platform}`);
  if (!findJavaHome(opts, sdkRoot)) {
    return fail('Java (JDK 17+) is required for sdkmanager; install a JDK and set JAVA_HOME, then retry');
  }

  try {
    await fsp.mkdir(path.join(sdkRoot, 'cmdline-tools'), { recursive: true });
    let sdkmanager = findSdkTool('sdkmanager', opts, [sdkRoot]);
    if (!sdkmanager) {
      const workDir = path.join(sdkRoot, '.dsh-bootstrap');
      await fsp.mkdir(workDir, { recursive: true });
      const archive = path.join(workDir, 'commandlinetools.zip');
      const extractDir = path.join(workDir, 'extract');
      await fsp.rm(extractDir, { recursive: true, force: true });
      await fsp.mkdir(extractDir, { recursive: true });
      result.downloaded = { url, archive };
      await download(url, archive, { maxBytes: MAX_CMDLINE_TOOLS_BYTES });
      if (!existsSync(archive)) throw new Error('command-line tools download did not create a file');
      if (extract) await extract(archive, extractDir);
      else await extractZipDefault({ ...opts, exec: opts.exec || defaultExec }, archive, extractDir);
      result.extracted = true;
      const extractedTools = path.join(extractDir, 'cmdline-tools');
      const latest = path.join(sdkRoot, 'cmdline-tools', 'latest');
      if (!existsSync(path.join(extractedTools, 'bin'))) {
        throw new Error('command-line tools archive did not contain cmdline-tools/bin');
      }
      await fsp.rm(latest, { recursive: true, force: true });
      await fsp.rename(extractedTools, latest);
      sdkmanager = findSdkTool('sdkmanager', opts, [sdkRoot]);
      if (!sdkmanager) throw new Error('sdkmanager not found after extracting command-line tools');
      await fsp.rm(archive, { force: true }).catch(() => {});
      await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }

    const env = opts.exec ? null : toolEnv(opts, sdkRoot);
    const licenseArgs = [`--sdk_root=${sdkRoot}`, '--licenses'];
    const licenseExec = { timeoutMs: Math.min(timeoutMs, 5 * 60 * 1000), maxBytes: 2 * 1024 * 1024, stdin: 'y\n'.repeat(60) };
    if (env) licenseExec.env = env;
    const licenseResult = await runExec(opts.exec || defaultExec, sdkmanager, licenseArgs, licenseExec);
    result.licenses = licenseResult.code === 0 && !licenseResult.timedOut;
    if (!result.licenses) {
      return fail(`sdkmanager --licenses failed (exit ${licenseResult.code}): ${(licenseResult.stderr || licenseResult.stdout || '').slice(0, 500)}`);
    }

    const installArgs = [`--sdk_root=${sdkRoot}`, '--install', ...packages];
    result.command = `${sdkmanager} --install ${packages.join(' ')}`;
    const installExec = { timeoutMs, maxBytes: 8 * 1024 * 1024, stdin: 'y\n'.repeat(60) };
    if (env) installExec.env = env;
    const installResult = await runExec(opts.exec || defaultExec, sdkmanager, installArgs, installExec);
    result.output = boundedText(`${installResult.stdout}${installResult.stderr ? `\n${installResult.stderr}` : ''}`, MAX_ERROR_OUTPUT_CHARS);
    if (installResult.timedOut) return fail(`sdkmanager --install timed out after ${timeoutMs} ms`);
    if (installResult.error) return fail(`sdkmanager could not run: ${installResult.error}`);
    if (installResult.code !== 0) return fail(`sdkmanager --install failed (exit ${installResult.code}): ${result.output || 'no output'}`);
    result.installed = true;
    result.ok = true;
    return result;
  } catch (error) {
    return fail(error && error.message ? error.message : error);
  }
}


function toolNamesFor(platform, baseName) {
  if (platform === 'win32') return [`${baseName}.bat`, `${baseName}.cmd`, `${baseName}.exe`, baseName];
  return [baseName];
}

function findSdkTool(baseName, opts, roots) {
  const names = toolNamesFor(opts.platform, baseName);
  const tryDir = (dir) => {
    for (const name of names) {
      const candidate = joinFor(opts.platform, dir, name);
      if (isFile(candidate)) return candidate;
    }
    return null;
  };

  for (const root of roots) {
    for (const name of names) {
      const candidate = joinFor(opts.platform, root, 'cmdline-tools', 'latest', 'bin', name);
      if (isFile(candidate)) return candidate;
    }

    const cmdlineTools = joinFor(opts.platform, root, 'cmdline-tools');
    for (const version of listSubdirectories(cmdlineTools, opts.platform)) {
      const found = tryDir(joinFor(opts.platform, cmdlineTools, version, 'bin'));
      if (found) return found;
    }

    const foundDirect = tryDir(joinFor(opts.platform, root, 'cmdline-tools', 'bin'));
    if (foundDirect) return foundDirect;

    const foundTools = tryDir(joinFor(opts.platform, root, 'tools', 'bin'));
    if (foundTools) return foundTools;
  }

  for (const name of names) {
    const found = findOnPath(name, opts.env, opts.platform);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// JDK discovery (avdmanager / sdkmanager are Java programs)
// ---------------------------------------------------------------------------

/**
 * Return the JAVA_HOME-style directory of the first usable JDK, or null.
 * `sdkmanager`/`avdmanager` are Java programs: when JAVA_HOME is unset and
 * `java` is not on PATH they fail with "JAVA_HOME is not set". Rather than
 * leaving the one-click actions broken on such machines (the verified host
 * keeps its JDK at D:\Android\jdk-17.0.2, a sibling of the SDK root), a
 * bounded read-only search of JAVA_HOME, the SDK's sibling directories and
 * common per-OS JDK locations is performed and the result is injected as
 * JAVA_HOME into the child environment only. The public API is unchanged.
 */
function findJavaHome(opts, sdkRoot) {
  const homes = [];
  const add = (value) => {
    if (value && typeof value === 'string') homes.push(value);
  };
  const addVersionedBase = (base) => {
    for (const name of listSubdirectories(base, opts.platform)) {
      if (/jdk|jbr|openjdk|java/i.test(name)) add(joinFor(opts.platform, base, name));
    }
  };

  add(opts.env.JAVA_HOME);
  add(opts.env.ANDROID_JAVA_HOME);

  if (sdkRoot) {
    const parent = dirnameFor(opts.platform, sdkRoot);
    for (const name of listSubdirectories(parent, opts.platform)) {
      if (/^(?:jdk|jbr|openjdk|java)/i.test(name)) {
        add(joinFor(opts.platform, parent, name));
      }
    }
  }

  // Host-specific search only for real runs (keeps test discovery isolated).
  if (!opts.envProvided) {
    if (opts.platform === 'win32') {
      add('C:\\Program Files\\Android\\Android Studio\\jbr');
      addVersionedBase('C:\\Program Files\\Java');
      addVersionedBase('C:\\Program Files\\Eclipse Adoptium');
      addVersionedBase('C:\\Program Files\\Microsoft');
    } else if (opts.platform === 'darwin') {
      addVersionedBase('/Library/Java/JavaVirtualMachines');
      addVersionedBase('/opt/homebrew/opt');
      addVersionedBase('/usr/local/opt');
    } else {
      addVersionedBase('/usr/lib/jvm');
      addVersionedBase('/opt/java');
      addVersionedBase('/opt/jdk');
      add('/opt/android-studio/jbr');
    }
  }

  for (const home of dedupePaths(homes, opts.platform)) {
    const javaExe = opts.platform === 'win32' ? 'java.exe' : 'java';
    if (isFile(joinFor(opts.platform, home, 'bin', javaExe))) return home;
    // macOS JDK bundles store the home under Contents/Home.
    const bundleHome = joinFor(opts.platform, home, 'Contents', 'Home');
    if (isFile(joinFor(opts.platform, bundleHome, 'bin', javaExe))) return bundleHome;
  }
  return null;
}

/**
 * Environment for the Java-based SDK tools: the caller's environment plus the
 * discovered JAVA_HOME (if any). Returns null to mean "inherit unchanged".
 */
function toolEnv(opts, sdkRoot) {
  const javaHome = findJavaHome(opts, sdkRoot);
  if (opts.envProvided) {
    return javaHome ? { ...opts.env, JAVA_HOME: javaHome } : opts.env;
  }
  return javaHome ? { JAVA_HOME: javaHome } : null;
}

// ---------------------------------------------------------------------------
// CPU acceleration detection
// ---------------------------------------------------------------------------

function canonicalBackend(value) {
  const text = String(value || '');
  if (/hypervisor\.?framework/i.test(text)) return 'HVF';
  const upper = text.toUpperCase();
  if (upper.includes('AEHD')) return 'AEHD';
  if (upper.includes('WHPX')) return 'WHPX';
  if (upper.includes('KVM')) return 'KVM';
  if (upper.includes('HAXM')) return 'HAXM';
  if (upper.includes('HVF')) return 'HVF';
  return null;
}

/**
 * Parse `emulator-check accel` output. Real format:
 *
 *   accel:
 *   0
 *   AEHD (version 2.1) is installed and usable.
 *   accel
 *
 * The numeric line is the check status (0 = usable); a non-zero status or
 * "not installed"/"disabled" text means no hardware acceleration. A parse is
 * only `confident` when a status line or explicit usable/negative text backs
 * a recognized backend; otherwise OS fallbacks decide.
 */
function parseAccelCheck(result) {
  const text = boundedText(`${result.stdout}\n${result.stderr}`.trim(), 4096);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const backendMatch = /(AEHD|WHPX|KVM|HAXM|HVF|Hypervisor\.?Framework)/i.exec(text);
  const rawBackend = backendMatch ? backendMatch[1] : null;
  const backend = canonicalBackend(rawBackend);

  const numericLine = lines.find((line) => /^\d+$/.test(line));
  const numeric = numericLine === undefined ? null : Number(numericLine);
  const negative = /not installed|not supported|not available|not usable|no hardware|disabled|failed|error|unable/i.test(
    text,
  );
  const usable = /usable|installed and usable|is installed|working|enabled/i.test(text);

  let available = false;
  let confident = false;
  if (backend && numeric !== null) {
    available = numeric === 0 && !negative;
    confident = true;
  } else if (backend && (usable || negative)) {
    available = usable && !negative;
    confident = true;
  } else if (!backend && numeric !== null && numeric !== 0) {
    // A non-zero status without any recognizable backend can only mean "no".
    available = false;
    confident = true;
  }

  const backendLine = rawBackend
    ? lines.find((line) => line.toLowerCase().includes(String(rawBackend).toLowerCase())) || null
    : null;
  const detailSource = backendLine || lines.slice(0, 2).join(' | ') || text;
  const detail = boundedText(detailSource, 300);

  return {
    available,
    backend: available ? backend : 'none',
    detail,
    confident,
  };
}

/**
 * OS-level acceleration fallbacks. Only used when `emulator-check accel` is
 * missing, failed, or gave an unparseable answer. Returns
 * `{available, backend, detail}` or null when nothing could be probed.
 */
async function probeAccelerationFallback({ opts, exec, timeoutMs, notes }) {
  if (opts.platform === 'darwin') {
    const result = await runExec(exec, 'sysctl', ['-n', 'kern.hv_support'], {
      timeoutMs: Math.min(timeoutMs, 10 * 1000),
      maxBytes: 8 * 1024,
    });
    const value = result.stdout.trim();
    if (value === '1') {
      notes.push('macOS reports Hypervisor.Framework support (kern.hv_support = 1).');
      return {
        available: true,
        backend: 'HVF',
        detail: 'sysctl kern.hv_support = 1 (Hypervisor.Framework)',
      };
    }
    if (value === '0') {
      notes.push(
        'macOS reports kern.hv_support = 0; hardware virtualization is unavailable on this machine.',
      );
      return {
        available: false,
        backend: 'none',
        detail: 'sysctl kern.hv_support = 0',
      };
    }
    notes.push(
      `macOS hypervisor probe was inconclusive${
        result.error ? ` (${result.error})` : value ? ` (got "${boundedText(value, 80)}")` : ''
      }.`,
    );
    return null;
  }

  if (opts.platform === 'win32') {
    notes.push(
      'Windows acceleration is provided by AEHD (Android Emulator Hypervisor Driver) or WHPX ' +
        '(Windows Hypervisor Platform); install one and reboot once.',
    );
    const services = [
      ['aehd', 'AEHD'],
      ['gvm', 'AEHD'],
      ['intelhaxm', 'HAXM'],
    ];
    for (const [service, backend] of services) {
      const result = await runExec(exec, 'sc.exe', ['query', service], {
        timeoutMs: Math.min(timeoutMs, 5000),
        maxBytes: 16 * 1024,
      });
      const text = `${result.stdout}\n${result.stderr}`;
      if (/STATE\s*:\s*4\s+RUNNING/i.test(text)) {
        notes.push(`Windows service "${service}" is running (${backend}).`);
        return {
          available: true,
          backend,
          detail: `Windows service "${service}" is running`,
        };
      }
    }
    notes.push(
      'Windows: no running AEHD/HAXM service was detected; enable Windows Hypervisor Platform ' +
        '(WHPX) or install AEHD, then reboot.',
    );
    return {
      available: false,
      backend: 'none',
      detail: 'No running AEHD/HAXM service detected',
    };
  }

  // Linux and other POSIX hosts: KVM exposes /dev/kvm.
  if (existsSync('/dev/kvm')) {
    notes.push('Linux: /dev/kvm is present.');
    return { available: true, backend: 'KVM', detail: '/dev/kvm is present' };
  }
  notes.push(
    'Linux: /dev/kvm is not present; enable VT-x/AMD-V in firmware, load the KVM module and ' +
      'ensure this user may access /dev/kvm.',
  );
  return { available: false, backend: 'none', detail: '/dev/kvm not found' };
}

// ---------------------------------------------------------------------------
// Environment resolution (shared by detect/create/install)
// ---------------------------------------------------------------------------

async function resolveEnvironment(opts, features = {}) {
  const probeAcceleration = features.probeAcceleration === true;
  const probeVersion = features.probeVersion === true;
  const exec = opts.exec || defaultExec;
  const platform = opts.platform;
  const exe = platform === 'win32' ? '.exe' : '';
  const probeTimeoutMs = opts.timeoutMs || DEFAULT_DETECT_TIMEOUT_MS;

  const missing = [];
  const hypervisorNotes = [];
  const addMissing = (message) => {
    if (!missing.includes(message)) missing.push(message);
  };

  // --- SDK root -----------------------------------------------------------
  const roots = candidateSdkRoots(opts);
  let sdkRoot = null;
  for (const candidate of roots) {
    if (isDirectory(candidate)) {
      sdkRoot = candidate;
      break;
    }
  }
  if (opts.sdkRoot && sdkRoot && !pathsEqual(opts.sdkRoot, sdkRoot, platform)) {
    hypervisorNotes.push(
      `Configured SDK root ${opts.sdkRoot} was not found; using discovered root ${sdkRoot}.`,
    );
  }
  if (!sdkRoot) {
    addMissing(
      `Android SDK not found (set options.sdkRoot or ANDROID_SDK_ROOT; checked ` +
        `${roots.length ? summarizeCandidates(roots) : 'no candidate locations'})`,
    );
  }

  // --- adb ----------------------------------------------------------------
  let adbPath = null;
  if (opts.adbPath) {
    adbPath = isFile(opts.adbPath) ? opts.adbPath : null;
    if (!adbPath) addMissing(`adb not found at configured path: ${opts.adbPath}`);
  }
  if (!adbPath) {
    for (const root of roots) {
      const candidate = joinFor(platform, root, 'platform-tools', `adb${exe}`);
      if (isFile(candidate)) {
        adbPath = candidate;
        break;
      }
    }
  }
  if (!adbPath) adbPath = findOnPath(`adb${exe}`, opts.env, platform);
  if (!adbPath) addMissing('adb not found (install Android SDK platform-tools or add adb to PATH)');

  // --- emulator -----------------------------------------------------------
  let emulatorPath = null;
  if (opts.emulatorPath) {
    emulatorPath = isFile(opts.emulatorPath) ? opts.emulatorPath : null;
    if (!emulatorPath) addMissing(`Android emulator not found at configured path: ${opts.emulatorPath}`);
  }
  if (!emulatorPath) {
    for (const root of roots) {
      const candidate = joinFor(platform, root, 'emulator', `emulator${exe}`);
      if (isFile(candidate)) {
        emulatorPath = candidate;
        break;
      }
    }
  }
  if (!emulatorPath) emulatorPath = findOnPath(`emulator${exe}`, opts.env, platform);
  if (!emulatorPath) {
    addMissing('Android emulator not found (install the "emulator" SDK package or add it to PATH)');
  }

  // --- command-line tools -------------------------------------------------
  const avdmanagerPath = findSdkTool('avdmanager', opts, roots);
  const sdkmanagerPath = findSdkTool('sdkmanager', opts, roots);
  if (sdkRoot && !avdmanagerPath && !sdkmanagerPath) {
    addMissing(
      'Android command-line tools not found (install the "cmdline-tools;latest" SDK package; ' +
        'needed to create an AVD or install a system image)',
    );
  }

  // --- system image -------------------------------------------------------
  const imageParts = opts.systemImage.split(';');
  const imageDir = sdkRoot
    ? joinFor(platform, sdkRoot, 'system-images', imageParts[1], imageParts[2], imageParts[3])
    : null;
  const systemImagePresent = Boolean(imageDir && isDirectory(imageDir));
  if (!systemImagePresent) {
    addMissing(
      `System image not installed: ${opts.systemImage}${
        imageDir ? ` (expected payload directory ${imageDir})` : ''
      }`,
    );
  }

  // --- AVD ----------------------------------------------------------------
  const avdLocation = resolveAvdLocation(opts);
  const avdPresent = Boolean(
    (avdLocation.avdPath && existsSync(avdLocation.avdPath)) ||
      (avdLocation.iniPath && existsSync(avdLocation.iniPath)),
  );
  if (!avdPresent) {
    addMissing(
      `AVD "${opts.avdName}" not created${
        avdLocation.avdPath ? ` (expected ${avdLocation.avdPath})` : ''
      }`,
    );
  }

  // --- emulator version (read-only probe) ---------------------------------
  let emulatorVersion = null;
  if (probeVersion && emulatorPath) {
    const result = await runExec(exec, emulatorPath, ['-version'], {
      timeoutMs: probeTimeoutMs,
      maxBytes: 64 * 1024,
    });
    const text = `${result.stdout}\n${result.stderr}`.trim();
    const match = /Android emulator version\s+([0-9][0-9A-Za-z._-]*)/i.exec(text);
    if (match) {
      emulatorVersion = match[1];
    } else {
      const firstLine = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (firstLine) emulatorVersion = boundedText(firstLine, 120);
    }
  }

  // --- CPU acceleration ---------------------------------------------------
  let accel = { available: false, backend: 'none', detail: '' };
  if (probeAcceleration) {
    let parsed = null;
    if (emulatorPath) {
      const checkerPath = joinFor(platform, dirnameFor(platform, emulatorPath), `emulator-check${exe}`);
      if (isFile(checkerPath)) {
        const result = await runExec(exec, checkerPath, ['accel'], {
          timeoutMs: probeTimeoutMs,
          maxBytes: 64 * 1024,
        });
        parsed = parseAccelCheck(result);
        if (result.error) {
          hypervisorNotes.push(`emulator-check could not run: ${boundedText(result.error, 200)}`);
        } else if (result.timedOut) {
          hypervisorNotes.push(`emulator-check timed out after ${probeTimeoutMs} ms.`);
        }
      } else {
        hypervisorNotes.push(
          `emulator-check not found next to ${emulatorPath}; falling back to OS acceleration probes.`,
        );
      }
    }

    if (parsed && parsed.confident) {
      accel = { available: parsed.available, backend: parsed.backend, detail: parsed.detail };
    } else {
      const fallback = await probeAccelerationFallback({
        opts,
        exec,
        timeoutMs: probeTimeoutMs,
        notes: hypervisorNotes,
      });
      if (fallback) {
        accel = fallback;
      } else if (parsed) {
        accel = { available: parsed.available, backend: parsed.backend, detail: parsed.detail };
      } else {
        accel = {
          available: false,
          backend: 'none',
          detail: 'CPU acceleration could not be determined',
        };
      }
    }

    if (accel.available) {
      hypervisorNotes.unshift(`Hardware acceleration available via ${accel.backend}.`);
    } else {
      addMissing(
        'No usable CPU acceleration (install/enable AEHD or WHPX on Windows, KVM on Linux, ' +
          'Hypervisor.Framework on macOS)',
      );
      hypervisorNotes.push(
        'No hardware acceleration detected: an x86_64 Android system image cannot boot under ' +
          'pure software emulation (TCG) in a usable time budget.',
      );
    }
  }

  const ok = Boolean(
    sdkRoot && adbPath && emulatorPath && systemImagePresent && avdPresent && accel.available,
  );

  const apiLevel = String(imageParts[1] || 'android-34').replace(/^android-/, '');
  const platformPackage = `platforms;android-${apiLevel}`;
  const buildToolsPackage = `build-tools;${apiLevel}.0.0`;

  const actions = [
    {
      id: 'create-avd',
      label: `Create AVD "${opts.avdName}"`,
      available: Boolean(systemImagePresent && !avdPresent && avdmanagerPath),
      reason: !systemImagePresent
        ? `system image ${opts.systemImage} is not installed`
        : avdPresent
          ? `AVD "${opts.avdName}" already exists`
          : !avdmanagerPath
            ? 'avdmanager (Android SDK command-line tools) not found'
            : `avdmanager create avd -n ${opts.avdName} -k ${opts.systemImage} -d pixel_5 --force`,
    },
    {
      id: 'install-image',
      label: `Install system image ${opts.systemImage}`,
      available: Boolean(!systemImagePresent && sdkmanagerPath),
      reason: systemImagePresent
        ? `system image ${opts.systemImage} is already installed`
        : !sdkmanagerPath
          ? 'sdkmanager (Android SDK command-line tools) not found'
          : `sdkmanager --install ${opts.systemImage}`,
    },
    {
      id: 'install-tools',
      label: 'Install missing Android SDK components (platform-tools, emulator, build-tools, platform)',
      available: Boolean(
        sdkmanagerPath &&
          sdkRoot &&
          missing.some((message) => /\badb\b|\bemulator\b/i.test(message)),
      ),
      reason: !sdkmanagerPath
        ? 'sdkmanager (Android SDK command-line tools) not found'
        : missing.some((message) => /\badb\b|\bemulator\b/i.test(message))
          ? `sdkmanager --install platform-tools emulator ${buildToolsPackage} ${platformPackage}`
          : 'adb/emulator already present',
    },
    {
      id: 'bootstrap-sdk',
      label: 'Bootstrap Android SDK from zero (download command-line tools, accept licenses, install packages)',
      available: !sdkmanagerPath,
      reason: sdkmanagerPath
        ? 'sdkmanager already present'
        : `download ${CMDLINE_TOOLS_URLS[platform] || '(unsupported platform)'} into the standard SDK root`,
    },
    {
      id: 'repair-accel',
      label: 'Fix CPU acceleration',
      available: !accel.available,
      reason: accel.available
        ? `hardware acceleration already available (${accel.backend})`
        : accel.detail
          ? `no usable hypervisor: ${accel.detail}`
          : 'no usable hypervisor detected',
    },
  ];

  return {
    ok,
    platform,
    sdkRoot,
    adbPath,
    emulatorPath,
    avdmanagerPath,
    sdkmanagerPath,
    emulatorVersion,
    systemImage: opts.systemImage,
    systemImagePresent,
    avdName: opts.avdName,
    avdPresent,
    avdPath: avdLocation.avdPath,
    accel,
    hypervisorNotes,
    missing,
    actions,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the host Android environment. Read-only: never installs, downloads or
 * launches an emulator. Expected problems are reported through `ok:false`,
 * `missing` and `actions` rather than thrown.
 *
 * @param {object} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   platform: string,
 *   sdkRoot: string|null,
 *   adbPath: string|null,
 *   emulatorPath: string|null,
 *   avdmanagerPath: string|null,
 *   sdkmanagerPath: string|null,
 *   emulatorVersion: string|null,
 *   systemImage: string,
 *   systemImagePresent: boolean,
 *   avdName: string,
 *   avdPresent: boolean,
 *   avdPath: string|null,
 *   accel: { available: boolean, backend: string, detail: string },
 *   hypervisorNotes: string[],
 *   missing: string[],
 *   actions: Array<{ id: string, label: string, available: boolean, reason?: string }>,
 * }>}
 */
export async function detectEnvironment(options = {}) {
  const opts = normalizeOptions(options, 'detectEnvironment');
  return resolveEnvironment(opts, { probeAcceleration: true, probeVersion: true });
}

/**
 * Create the configured AVD from an already-installed system image with
 * `avdmanager create avd -n <name> -k <image> -d pixel_5 --force`.
 * Returns `ok:false` for environment problems (missing image, missing
 * avdmanager, non-zero exit, timeout); throws only for programmer errors.
 */
export async function createAvd(options = {}) {
  const opts = normalizeOptions(options, 'createAvd');
  const exec = opts.exec || defaultExec;
  const timeoutMs = opts.timeoutMs || DEFAULT_CREATE_TIMEOUT_MS;
  const envState = await resolveEnvironment(opts, {
    probeAcceleration: false,
    probeVersion: false,
  });

  const command = `${envState.avdmanagerPath || 'avdmanager'} create avd -n ${opts.avdName} ` +
    `-k ${opts.systemImage} -d pixel_5 --force`;
  const fail = (error, output = '') => ({
    ok: false,
    avdName: opts.avdName,
    command,
    output: boundedText(output, MAX_ERROR_OUTPUT_CHARS),
    error,
  });

  if (!envState.avdmanagerPath) {
    return fail(
      envState.sdkRoot
        ? 'avdmanager not found: install the Android SDK command-line tools ("cmdline-tools;latest")'
        : 'Android SDK not found: set options.sdkRoot or ANDROID_SDK_ROOT before creating an AVD',
    );
  }
  if (!envState.systemImagePresent) {
    return fail(
      `system image ${opts.systemImage} is not installed; run installSystemImage() first`,
    );
  }

  const argv = [
    'create',
    'avd',
    '-n',
    opts.avdName,
    '-k',
    opts.systemImage,
    '-d',
    'pixel_5',
    '--force',
  ];
  const execOptions = {
    timeoutMs,
    maxBytes: DEFAULT_MAX_OUTPUT_BYTES,
    // avdmanager may ask "Do you wish to create a custom hardware profile?".
    stdin: 'no\n',
  };
  const spawnEnv = toolEnv(opts, envState.sdkRoot);
  if (spawnEnv) execOptions.env = spawnEnv;

  const result = await runExec(exec, envState.avdmanagerPath, argv, execOptions);
  const output = boundedText(
    `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim(),
    MAX_ERROR_OUTPUT_CHARS,
  );

  if (result.timedOut) {
    return fail(`avdmanager create avd timed out after ${timeoutMs} ms`, output);
  }
  if (result.error) {
    return fail(`avdmanager create avd could not run: ${boundedText(result.error, 400)}`, output);
  }
  if (result.code !== 0) {
    return fail(
      `avdmanager create avd failed (exit ${result.code}): ${output || 'no output'}`.slice(
        0,
        MAX_ERROR_OUTPUT_CHARS,
      ),
      output,
    );
  }
  return { ok: true, avdName: opts.avdName, command, output };
}

/**
 * Install a system image with `sdkmanager --install <image>`.
 * This is the only function that may touch the network, so it is never called
 * by detectEnvironment() and must be invoked explicitly by the caller/UI.
 * Set `acceptLicenses: true` to answer license prompts with `y` on stdin.
 */
export async function installSystemImage(options = {}) {
  const opts = normalizeOptions(options, 'installSystemImage');
  const exec = opts.exec || defaultExec;
  const timeoutMs = opts.timeoutMs || DEFAULT_INSTALL_TIMEOUT_MS;
  const envState = await resolveEnvironment(opts, {
    probeAcceleration: false,
    probeVersion: false,
  });

  const command = `${envState.sdkmanagerPath || 'sdkmanager'} --install ${opts.systemImage}`;
  const fail = (error, output = '') => ({
    ok: false,
    image: opts.systemImage,
    command,
    output: boundedText(output, MAX_ERROR_OUTPUT_CHARS),
    error,
  });

  if (!envState.sdkmanagerPath) {
    return fail(
      envState.sdkRoot
        ? 'sdkmanager not found: install the Android SDK command-line tools ("cmdline-tools;latest")'
        : 'Android SDK not found: set options.sdkRoot or ANDROID_SDK_ROOT before installing an image',
    );
  }

  const argv = ['--install', opts.systemImage];
  const execOptions = { timeoutMs, maxBytes: DEFAULT_MAX_OUTPUT_BYTES };
  if (opts.acceptLicenses) execOptions.stdin = 'y\n'.repeat(20);
  const spawnEnv = toolEnv(opts, envState.sdkRoot);
  if (spawnEnv) execOptions.env = spawnEnv;

  const result = await runExec(exec, envState.sdkmanagerPath, argv, execOptions);
  const output = boundedText(
    `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim(),
    MAX_ERROR_OUTPUT_CHARS,
  );

  if (result.timedOut) {
    return fail(`sdkmanager --install timed out after ${timeoutMs} ms`, output);
  }
  if (result.error) {
    return fail(`sdkmanager could not run: ${boundedText(result.error, 400)}`, output);
  }
  if (result.code !== 0) {
    return fail(
      `sdkmanager --install failed (exit ${result.code}): ${output || 'no output'}`.slice(
        0,
        MAX_ERROR_OUTPUT_CHARS,
      ),
      output,
    );
  }
  return { ok: true, image: opts.systemImage, command, output };
}

/**
 * Install arbitrary SDK packages with `sdkmanager --install <pkg...>`
 * (platform-tools / emulator / build-tools / platforms / system images).
 * Network access only when explicitly called; gated by allowSetupDownloads in
 * the host route.
 */
export async function installSdkPackages(options = {}) {
  const opts = normalizeOptions(options, 'installSdkPackages');
  const exec = opts.exec || defaultExec;
  const timeoutMs = opts.timeoutMs || DEFAULT_INSTALL_TIMEOUT_MS;
  const packages = Array.isArray(options.packages)
    ? [...new Set(options.packages.map((value) => String(value).trim()).filter(Boolean))]
    : [];
  const envState = await resolveEnvironment(opts, {
    probeAcceleration: false,
    probeVersion: false,
  });
  const command = `${envState.sdkmanagerPath || 'sdkmanager'} --install ${packages.join(' ')}`;
  const fail = (error, output = '') => ({
    ok: false,
    packages,
    command,
    output: boundedText(output, MAX_ERROR_OUTPUT_CHARS),
    error,
  });

  if (packages.length === 0) return fail('installSdkPackages requires a non-empty packages array');
  if (packages.length > 20) return fail('too many SDK packages (max 20)');
  for (const name of packages) {
    if (!/^[A-Za-z0-9._;:-]{1,120}$/.test(name)) return fail(`invalid SDK package name: ${name}`);
  }
  if (!envState.sdkmanagerPath) {
    return fail(
      envState.sdkRoot
        ? 'sdkmanager not found: install the Android SDK command-line tools ("cmdline-tools;latest")'
        : 'Android SDK not found: set options.sdkRoot or ANDROID_SDK_ROOT before installing tools',
    );
  }

  const argv = ['--install', ...packages];
  const execOptions = { timeoutMs, maxBytes: DEFAULT_MAX_OUTPUT_BYTES };
  if (opts.acceptLicenses) execOptions.stdin = 'y\n'.repeat(40);
  const spawnEnv = toolEnv(opts, envState.sdkRoot);
  if (spawnEnv) execOptions.env = spawnEnv;
  const result = await runExec(exec, envState.sdkmanagerPath, argv, execOptions);
  const output = boundedText(
    `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim(),
    MAX_ERROR_OUTPUT_CHARS,
  );
  if (result.timedOut) return fail(`sdkmanager --install timed out after ${timeoutMs} ms`, output);
  if (result.error) return fail(`sdkmanager could not run: ${boundedText(result.error, 400)}`, output);
  if (result.code !== 0) {
    return fail(`sdkmanager --install failed (exit ${result.code}): ${output || 'no output'}`.slice(0, MAX_ERROR_OUTPUT_CHARS), output);
  }
  return { ok: true, packages, command, output };
}

/**
 * Plain-text diagnostics summary (for UI panels / logs). Includes every
 * detected path, the AVD/image/acceleration verdict, available repair actions
 * and the final READY / NOT READY line.
 */
export async function setupReport(options = {}) {
  const report = await detectEnvironment(options);
  const lines = [];
  lines.push('DSH APK VM environment report');
  lines.push(`Platform: ${report.platform}`);
  lines.push(`SDK root: ${report.sdkRoot || '(not found)'}`);
  lines.push(`adb: ${report.adbPath || '(not found)'}`);
  lines.push(
    `emulator: ${report.emulatorPath || '(not found)'}${
      report.emulatorVersion ? ` (version ${report.emulatorVersion})` : ''
    }`,
  );
  lines.push(`avdmanager: ${report.avdmanagerPath || '(not found)'}`);
  lines.push(`sdkmanager: ${report.sdkmanagerPath || '(not found)'}`);
  lines.push(
    `system image: ${report.systemImage} [${report.systemImagePresent ? 'installed' : 'missing'}]`,
  );
  lines.push(
    `AVD: ${report.avdName} [${report.avdPresent ? 'present' : 'missing'}]${
      report.avdPath ? ` (${report.avdPath})` : ''
    }`,
  );
  lines.push(
    `Acceleration: ${
      report.accel.available ? report.accel.backend : 'unavailable'
    }${report.accel.detail ? ` - ${boundedText(report.accel.detail, 240)}` : ''}`,
  );
  if (report.hypervisorNotes.length > 0) {
    lines.push('Hypervisor notes:');
    for (const note of report.hypervisorNotes) lines.push(`  - ${boundedText(note, 300)}`);
  }
  lines.push('Actions:');
  for (const action of report.actions) {
    lines.push(
      `  - ${action.id}: ${action.available ? 'available' : 'blocked'}${
        action.reason ? ` (${boundedText(action.reason, 240)})` : ''
      }`,
    );
  }
  if (report.missing.length > 0) {
    lines.push('Missing:');
    for (const item of report.missing) lines.push(`  - ${boundedText(item, 300)}`);
  } else {
    lines.push('Missing: none');
  }
  lines.push(`Overall: ${report.ok ? 'READY' : 'NOT READY'}`);
  return boundedText(lines.join('\n'), MAX_REPORT_CHARS);
}
