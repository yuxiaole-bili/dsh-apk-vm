/**
 * lib/aab.js — Android App Bundle (.aab) support for the APK VM preview panel.
 *
 * Bundletool is the supported way to turn an Android App Bundle into a
 * device-installable `.apks` archive. This module is self-contained and
 * dependency-free (only `node:` built-ins):
 *
 *   detectBundletool(options)  find a bundletool jar/executable and Java
 *   buildApksFromAab(options)  run `build-apks --mode=<mode>` with argv only
 *   aabInfo(aabPath)           stat-only metadata for one .aab
 *
 * Tool discovery order:
 *   1. explicit `options.bundletoolPath` / `options.jarPath`
 *   2. `BUNDLETOOL_JAR` / `BUNDLETOOL_PATH` from the environment
 *   3. a `bundletool` executable on PATH
 *   4. common `bundletool*.jar` names in the repository/tools directory
 *
 * Safety: every external program is launched as
 * `child_process.spawn(file, argvArray)`; no command string is assembled, so
 * paths and passwords cannot inject a shell. Passwords only ever travel in
 * argv and are redacted from the returned `output` text. Windows `.bat`/`.cmd`
 * shims are the one OS-mandated exception: cmd.exe receives a fixed argv
 * array (the shim path and every argument stay separate entries), never a
 * concatenated command string. An AAB is a ZIP container, but metadata
 * collection here is intentionally stat-only: this module never extracts or
 * parses the archive.
 *
 * Export contract:
 *   detectBundletool(options = {}) -> { available, kind, path, javaPath }
 *     `kind` is 'jar' | 'exe' | 'missing'; `path` is null when missing.
 *     Synchronous and read-only: it only inspects the filesystem/PATH.
 *
 *   buildApksFromAab(options) -> Promise<{ ok, apksPath, output, error? }>
 *     Invalid input (missing/wrong extension, unsupported mode, bad signing
 *     options) rejects with TypeError/Error. Expected tool/runtime failures
 *     resolve with `ok: false`, `apksPath: null` and an `error` message.
 *
 *   aabInfo(aabPath) -> Promise<{ ok, path, name, size, available, tool }>
 *     `tool` is `{ kind, path, javaPath }` from `detectBundletool()`.
 *
 * `buildApksFromAab()` extras (not required by the minimal contract):
 *   `timeoutMs`, `env` (environment map), and `exec` (injectable runner used
 *   by tests; same shape as lib/setup.js: `(file, args, options) => result`).
 */
import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, readdirSync, statSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';
// Deterministic repo/tools lookup without node:url; fall back to cwd on Node
// versions that predate import.meta.dirname.
const MODULE_ROOT = path.resolve(import.meta.dirname ? path.join(import.meta.dirname, '..') : process.cwd());

// AAB -> .apks builds are CPU/IO heavy; allow a cold JVM and large bundles.
const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_RETURN_OUTPUT_CHARS = 64 * 1024;

const BUNDLETOOL_MODES = new Set([
  'default',
  'system',
  'universal',
  'system-compressed',
  'instant',
  'archive',
  'persistent',
]);

const COMMON_JAR_NAMES = ['bundletool.jar', 'bundletool-all.jar'];
// bundletool.jar, bundletool-all.jar, bundletool-all-1.17.2.jar, ...
const JAR_NAME_RE = /^bundletool(?:-all)?(?:[-.][0-9][A-Za-z0-9._-]*)?\.jar$/i;

// ---------------------------------------------------------------------------
// Small filesystem/path helpers
// ---------------------------------------------------------------------------

function toText(value) {
  if (value === undefined || value === null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value);
}

/** Trim surrounding whitespace/quotes; reject empty and NUL-containing values. */
function cleanPath(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (!text || text.includes('\0')) return null;
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text || null;
}

function requirePath(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a non-empty path string`);
  const text = cleanPath(value);
  if (!text) throw new TypeError(`${name} must be a non-empty path string`);
  return path.resolve(text);
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

function isExecutable(file, platform) {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== 'win32') accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function exeSuffix(platform) {
  return platform === 'win32' ? '.exe' : '';
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function envValue(env, name, platform) {
  if (!env || typeof env !== 'object') return undefined;
  if (platform !== 'win32') return env[name];
  const wanted = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === wanted) return env[key];
  }
  return undefined;
}

function pathEntries(env, platform) {
  const raw = envValue(env, 'PATH', platform);
  if (!raw) return [];
  const entries = [];
  for (const part of String(raw).split(path.delimiter)) {
    const cleaned = cleanPath(part);
    if (cleaned) entries.push(path.resolve(cleaned));
  }
  return entries;
}

function executableNames(name, env, platform) {
  if (platform !== 'win32') return [name];
  const raw = envValue(env, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD';
  const suffixes = [];
  for (const part of String(raw).split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const suffix = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
    // Windows filenames are case-insensitive; probing both spellings keeps
    // tests and unusual PATHEXT values predictable.
    for (const variant of [suffix.toLowerCase(), suffix.toUpperCase()]) {
      if (!suffixes.includes(variant)) suffixes.push(variant);
    }
  }
  return suffixes.map((suffix) => `${name}${suffix}`);
}

function findExecutableOnPath(name, env, platform) {
  const names = executableNames(name, env, platform);
  for (const dir of pathEntries(env, platform)) {
    for (const candidateName of names) {
      const candidate = path.join(dir, candidateName);
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bundletool / Java discovery
// ---------------------------------------------------------------------------

function inspectToolCandidate(value, kindHint, { platform }) {
  const text = cleanPath(value);
  if (!text) return null;
  const file = path.resolve(text);
  const kind = kindHint === 'jar' || /\.jar$/i.test(file) ? 'jar' : 'exe';
  if (kind === 'jar') {
    return isFile(file) ? { kind, path: file } : null;
  }
  return isExecutable(file, platform) ? { kind, path: file } : null;
}

function toolSearchRoots(options) {
  const roots = [];
  const add = (value) => {
    const text = cleanPath(value);
    if (text) roots.push(path.resolve(text));
  };
  const explicitTools = cleanPath(options.toolsDir);
  const explicitRepo = cleanPath(options.repoRoot);

  if (explicitTools) add(explicitTools);
  if (explicitRepo) {
    const repo = path.resolve(explicitRepo);
    roots.push(repo, path.join(repo, 'tools'));
  } else if (!explicitTools) {
    roots.push(MODULE_ROOT, path.join(MODULE_ROOT, 'tools'));
    const cwd = path.resolve(process.cwd());
    if (!samePath(cwd, MODULE_ROOT)) roots.push(cwd, path.join(cwd, 'tools'));
  }

  const unique = [];
  for (const root of roots) {
    if (!unique.some((existing) => samePath(existing, root))) unique.push(root);
  }
  return unique;
}

function findRepoJar(options) {
  for (const root of toolSearchRoots(options)) {
    if (!isDirectory(root)) continue;
    for (const name of COMMON_JAR_NAMES) {
      const candidate = path.join(root, name);
      if (isFile(candidate)) return candidate;
    }
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const versioned = entries
      .filter((entry) => entry.isFile() && JAR_NAME_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const name of versioned) {
      const candidate = path.join(root, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function resolveJavaPath(options, env, platform) {
  const explicit = cleanPath(options.javaPath);
  if (explicit) {
    return /[\\/]/.test(explicit) ? path.resolve(explicit) : explicit;
  }

  for (const key of ['JAVA_HOME', 'ANDROID_JAVA_HOME', 'JDK_HOME']) {
    const home = cleanPath(envValue(env, key, platform));
    if (!home) continue;
    const base = path.resolve(home);
    const candidates = [
      path.join(base, 'bin', `java${exeSuffix(platform)}`),
      path.join(base, 'Contents', 'Home', 'bin', `java${exeSuffix(platform)}`),
    ];
    if (platform === 'win32') {
      candidates.push(path.join(base, 'bin', 'java'), path.join(base, 'bin', 'java.cmd'));
    }
    for (const candidate of candidates) {
      if (isFile(candidate)) return candidate;
    }
  }

  const onPath = findExecutableOnPath('java', env, platform);
  if (onPath) return onPath;
  // Last resort: rely on PATH inside spawn; a missing JDK surfaces as ok:false.
  return `java${exeSuffix(platform)}`;
}

/**
 * Find bundletool without downloading or executing anything.
 *
 * @param {object} [options]
 * @param {string} [options.bundletoolPath] explicit jar or executable
 * @param {string} [options.jarPath] explicit jar (forces jar mode)
 * @param {string} [options.javaPath] explicit Java executable
 * @param {string} [options.repoRoot] repository root to search (tests)
 * @param {string} [options.toolsDir] tools directory to search (tests)
 * @param {object} [options.env] complete environment map (defaults process.env)
 * @param {string} [options.platform] OS override used by tests
 * @returns {{ available: boolean, kind: 'jar'|'exe'|'missing', path: string|null, javaPath: string }}
 */
export function detectBundletool(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const platform = typeof opts.platform === 'string' && opts.platform ? opts.platform : process.platform;
  const env = opts.env && typeof opts.env === 'object' ? opts.env : process.env;
  const javaPath = resolveJavaPath(opts, env, platform);

  let match = null;

  for (const candidate of [
    { value: opts.bundletoolPath, hint: null },
    { value: opts.jarPath, hint: 'jar' },
  ]) {
    if (match) break;
    match = inspectToolCandidate(candidate.value, candidate.hint, { platform });
  }

  if (!match) {
    match = inspectToolCandidate(envValue(env, 'BUNDLETOOL_JAR', platform), 'jar', { platform });
  }
  if (!match) {
    match = inspectToolCandidate(envValue(env, 'BUNDLETOOL_PATH', platform), null, { platform });
  }
  if (!match) {
    const exe = findExecutableOnPath('bundletool', env, platform);
    if (exe) match = { kind: 'exe', path: exe };
  }
  if (!match) {
    const jar = findRepoJar(opts);
    if (jar) match = { kind: 'jar', path: jar };
  }

  return {
    available: Boolean(match),
    kind: match ? match.kind : 'missing',
    path: match ? match.path : null,
    javaPath,
  };
}

// ---------------------------------------------------------------------------
// Bounded argv-only process execution (no shell)
// ---------------------------------------------------------------------------

function spawnTarget(file, args, env) {
  // Windows cannot CreateProcess() a .bat/.cmd directly (spawn throws EINVAL).
  // The OS requires cmd.exe for batch shims; keep the shim path and every
  // argument as separate argv entries so nothing is concatenated into a shell
  // command string. The default shell remains disabled.
  if (process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(file)) {
    const comspec = (env && (env.ComSpec || env.COMSPEC)) || process.env.ComSpec || 'cmd.exe';
    return { file: comspec, args: ['/d', '/s', '/c', file, ...args] };
  }
  return { file, args };
}

function errorText(error) {
  if (!error) return null;
  return error.message ? String(error.message) : String(error);
}

function runProcess(file, args, options = {}) {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_BUILD_TIMEOUT_MS;
  const maxBytes =
    Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : DEFAULT_MAX_OUTPUT_BYTES;
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;

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

    const target = spawnTarget(file, args, env);
    let child;
    try {
      child = spawn(target.file, target.args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
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
        error: errorText(error) || 'spawn failed',
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
    child.on('error', (error) => finish(snapshot({ error: errorText(error) || 'spawn failed' })));
    child.on('close', (code, signal) => {
      finish(snapshot({ code: typeof code === 'number' ? code : null, signal: signal || null }));
    });

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

function normalizeExecResult(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  let code = null;
  if (Number.isFinite(value.code)) code = Number(value.code);
  else if (value.ok === true) code = 0;
  else if (value.ok === false) code = 1;

  const timedOut = value.timedOut === true;
  const error = value.error === undefined || value.error === null ? null : toText(value.error);
  return {
    code,
    signal: value.signal === undefined || value.signal === null ? null : String(value.signal),
    timedOut,
    truncated: value.truncated === true,
    stdout: toText(value.stdout),
    stderr: toText(value.stderr),
    error,
    ok: code === 0 && !timedOut && !error,
  };
}

async function runExec(exec, file, args, options) {
  try {
    const raw = await exec(file, args, options);
    return normalizeExecResult(raw);
  } catch (error) {
    return normalizeExecResult({ code: null, error: errorText(error) || 'exec failed' });
  }
}

function combineOutput(result, secrets) {
  const parts = [];
  if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
  if (result.stderr.trim()) parts.push(result.stderr.trimEnd());
  let output = parts.join('\n');
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join('<redacted>');
  }
  if (output.length > MAX_RETURN_OUTPUT_CHARS) {
    output = output.slice(-MAX_RETURN_OUTPUT_CHARS);
  }
  return output;
}

// ---------------------------------------------------------------------------
// Validation and .apks building
// ---------------------------------------------------------------------------

async function requireAabFile(aabPath) {
  const file = requirePath(aabPath, 'aabPath');
  if (path.extname(file).toLowerCase() !== '.aab') {
    throw new TypeError(`aabPath must point to a .aab file: ${file}`);
  }
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error(`AAB file not found: ${file}`);
    throw new Error(`cannot stat AAB file ${file}: ${(error && (error.code || error.message)) || 'unknown error'}`);
  }
  if (!stat.isFile()) throw new Error(`AAB path is not a regular file: ${file}`);
  return file;
}

function normalizeMode(value) {
  const mode = value === undefined || value === null ? 'universal' : String(value).trim().toLowerCase();
  if (!BUNDLETOOL_MODES.has(mode)) {
    throw new TypeError(
      `unsupported mode: ${JSON.stringify(String(value))}; expected one of ${[...BUNDLETOOL_MODES].join(', ')}`,
    );
  }
  return mode;
}

async function ensureOutDir(outDirValue, aabPath) {
  const outDir = requirePath(outDirValue, 'outDir');
  if (samePath(outDir, aabPath)) throw new TypeError('outDir must be a directory, not the .aab file');
  let stat = null;
  try {
    stat = await fsp.stat(outDir);
  } catch {
    stat = null;
  }
  if (stat && !stat.isDirectory()) throw new Error(`outDir exists but is not a directory: ${outDir}`);
  if (!stat) {
    try {
      await fsp.mkdir(outDir, { recursive: true });
    } catch (error) {
      throw new Error(`cannot create outDir ${outDir}: ${(error && (error.code || error.message)) || 'unknown error'}`);
    }
  }
  return outDir;
}

function apksStem(aabPath) {
  const raw = path.basename(aabPath, path.extname(aabPath));
  const cleaned = raw
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '');
  return cleaned || 'app';
}

async function ensureOutputTarget(apksPath) {
  let stat = null;
  try {
    stat = await fsp.stat(apksPath);
  } catch {
    stat = null;
  }
  if (stat && stat.isDirectory()) throw new Error(`output path is a directory: ${apksPath}`);
}

function secretText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (text.includes('\0')) throw new TypeError('signing password contains a NUL byte');
  return text;
}

async function signingArguments(options) {
  const keystoreProvided =
    options.keystore !== undefined &&
    options.keystore !== null &&
    String(options.keystore).trim() !== '';
  const password = secretText(options.ksPassword);
  const keyPassword = secretText(options.ksKeyPassword);
  let alias = null;
  if (options.ksAlias !== undefined && options.ksAlias !== null) {
    alias = String(options.ksAlias).trim();
    if (alias.includes('\0')) throw new TypeError('ksAlias contains a NUL byte');
    if (!alias) throw new TypeError('ksAlias must not be empty when provided');
  }
  const hasExtraSigningOptions = password !== null || keyPassword !== null || alias !== null;

  if (!keystoreProvided) {
    if (hasExtraSigningOptions) {
      throw new TypeError('keystore is required when ksPassword, ksAlias or ksKeyPassword is provided');
    }
    return { args: [], secrets: [] };
  }

  const keystore = requirePath(options.keystore, 'keystore');
  let stat;
  try {
    stat = await fsp.stat(keystore);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error(`keystore not found: ${keystore}`);
    throw new Error(`cannot stat keystore ${keystore}: ${(error && (error.code || error.message)) || 'unknown error'}`);
  }
  if (!stat.isFile()) throw new Error(`keystore is not a regular file: ${keystore}`);

  const args = [`--ks=${keystore}`];
  if (password !== null) args.push(`--ks-pass=pass:${password}`);
  if (alias) args.push(`--ks-key-alias=${alias}`);
  if (keyPassword !== null) args.push(`--key-pass=pass:${keyPassword}`);
  return { args, secrets: [password, keyPassword].filter(Boolean) };
}

function failure(error, output = '') {
  return { ok: false, apksPath: null, output, error };
}

function buildFailureMessage(result, tool) {
  if (result.timedOut) return 'bundletool timed out while building the .apks';
  if (result.error) {
    const label = tool.kind === 'jar' ? 'Java/bundletool' : 'bundletool';
    return `failed to start ${label}: ${result.error}`;
  }
  if (result.code !== null && result.code !== 0) return `bundletool exited with code ${result.code}`;
  return 'bundletool build-apks failed';
}

/**
 * Build a device-installable `.apks` from an `.aab`.
 *
 * @param {object} options
 * @param {string} options.aabPath path to an existing `.aab` file
 * @param {string} options.outDir directory created if missing; output is
 *   `<aab stem>.apks` inside it
 * @param {string} [options.bundletoolPath] explicit tool jar/executable
 * @param {string} [options.javaPath] Java executable used for jar mode
 * @param {string} [options.keystore] signing keystore (optional)
 * @param {string} [options.ksPassword] keystore password
 * @param {string} [options.ksAlias] key alias
 * @param {string} [options.ksKeyPassword] key password
 * @param {string} [options.mode='universal'] bundletool --mode value
 * @param {number} [options.timeoutMs] build timeout
 * @param {object} [options.env] environment map used for discovery/spawn
 * @param {Function} [options.exec] injectable runner (tests)
 * @returns {Promise<{ ok: boolean, apksPath: string|null, output: string, error?: string }>}
 */
export async function buildApksFromAab(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('buildApksFromAab options must be an object');
  }

  const aabPath = await requireAabFile(options.aabPath);
  const mode = normalizeMode(options.mode);
  const outDir = await ensureOutDir(options.outDir, aabPath);
  const apksPath = path.join(outDir, `${apksStem(aabPath)}.apks`);
  await ensureOutputTarget(apksPath);

  const signing = await signingArguments(options);
  const tool = detectBundletool(options);
  if (!tool.available) {
    return failure(
      'bundletool not found: set bundletoolPath/jarPath, BUNDLETOOL_JAR/BUNDLETOOL_PATH, ' +
        'put a bundletool executable on PATH, or place bundletool*.jar in the repository/tools directory',
    );
  }

  const javaPath = tool.javaPath || `java${exeSuffix(process.platform)}`;
  const commonArgs = [
    `--bundle=${aabPath}`,
    `--output=${apksPath}`,
    `--mode=${mode}`,
    ...signing.args,
  ];
  const command = tool.kind === 'jar' ? javaPath : tool.path;
  const commandArgs =
    tool.kind === 'jar'
      ? ['-jar', tool.path, 'build-apks', ...commonArgs]
      : ['build-apks', ...commonArgs];

  const spawnEnv =
    options.env && typeof options.env === 'object' ? { ...process.env, ...options.env } : process.env;
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_BUILD_TIMEOUT_MS;
  const exec = typeof options.exec === 'function' ? options.exec : runProcess;
  const result = await runExec(exec, command, commandArgs, {
    timeoutMs,
    maxBytes: DEFAULT_MAX_OUTPUT_BYTES,
    env: spawnEnv,
    cwd: outDir,
  });
  const output = combineOutput(result, signing.secrets);

  if (!result.ok) {
    return failure(buildFailureMessage(result, tool), output);
  }

  let built = null;
  try {
    built = await fsp.stat(apksPath);
  } catch {
    built = null;
  }
  if (!built || !built.isFile()) {
    return failure(`bundletool reported success but did not create ${apksPath}`, output);
  }

  return { ok: true, apksPath, output };
}

/**
 * Lightweight `.aab` metadata: stat size and base name, plus tool availability.
 * Deliberately does not unzip or parse the App Bundle.
 *
 * @param {string} aabPath
 * @returns {Promise<{ ok: true, path: string, name: string, size: number,
 *   available: boolean, tool: { kind: string, path: string|null, javaPath: string } }>}
 */
export async function aabInfo(aabPath) {
  const file = await requireAabFile(aabPath);
  const stat = await fsp.stat(file);
  const tool = detectBundletool();
  return {
    ok: true,
    path: file,
    name: path.basename(file),
    size: stat.size,
    available: tool.available,
    tool: { kind: tool.kind, path: tool.path, javaPath: tool.javaPath },
  };
}
