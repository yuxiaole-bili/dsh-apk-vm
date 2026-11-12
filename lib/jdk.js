/**
 * lib/jdk.js — zero-dependency, cross-platform Temurin JDK 17 provisioning.
 *
 * Purpose
 * -------
 * The plugin's one-click setup needs a JDK 17 because `sdkmanager` and
 * `avdmanager` are Java programs. On a host with no JDK at all the bootstrap
 * flow previously stopped with "Java (JDK 17+) is required ...". This module
 * can obtain a portable Eclipse Temurin JDK 17 from the public Adoptium API and
 * unpack it into a plugin-owned directory (`~/.dsh/apk-vm/jdk` by default), so
 * `lib/setup.js` can discover it without touching the system JDK.
 *
 * Public API
 * ----------
 *   defaultJdkRoot(options)              -> string (directory)
 *   findManagedJdk(options)              -> string | null  (synchronous scan)
 *   ensureJdk(options)                   -> Promise<result> (never throws)
 *   adoptiumAssetUrl(osName, archName)   -> string
 *
 * `ensureJdk()` result:
 *   { ok: true, cached: boolean, javaHome: string, version: string|null,
 *     url: string|null, viaMirror: boolean, bytes: number|null, sha256: string|null }
 *   { ok: false, error: string }
 *
 * China fallback
 * --------------
 * The Adoptium API is normally reachable, but the package it links to is on
 * github.com, which can be blocked. When the primary link fails for ANY reason
 * (network error, HTTP error, size mismatch, checksum mismatch), `ensureJdk()`
 * retries the same asset name from Temurin mirrors in order and still verifies
 * every download against the API-provided SHA-256 and size. Mirrors come from
 * `options.jdkMirror` (a base URL or an array of base URLs), else
 * `$DSH_APK_VM_JDK_MIRROR` (comma/whitespace separated), else the Tsinghua
 * University TUNA mirror. An explicit empty array/string disables mirrors.
 * `<base>/<major>/jdk/<arch>/<os>/<assetName>` is the mirror URL template.
 *
 * Design constraints (shared with the rest of the plugin)
 * -------------------------------------------------------
 *   - ESM only, `node:` built-ins only, no npm dependencies.
 *   - Expected failures are returned as `{ ok:false, error }`, never thrown.
 *   - No shell strings: the Windows archive extraction is the documented
 *     exception (`powershell.exe -Command`, matching lib/setup.js), and its
 *     archive/destination paths are passed as single-quoted PowerShell literals
 *     with embedded quotes escaped.
 *   - Downloads are streamed to disk (never buffered with arrayBuffer()),
 *     bounded by a byte cap and a wall-clock timeout, and SHA-256 verified.
 *   - No top-level side effects: importing this module only reads constants.
 *   - Every network/exec/extract step is injectable for hermetic tests:
 *       fetchImpl(url, init)                       -> Response-like
 *       download(url, dest, opts)                  -> { ok, bytes?, error? }
 *       extract(archive, dest, { platform })       -> { ok, error? }
 *       log(message) / onProgress({ step, message, ... })
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ADOPTIUM_LATEST_17 = 'https://api.adoptium.net/v3/assets/latest/17/hotspot';
/** Temurin major version handled by this module (mirror URL template segment). */
const ADOPTIUM_MAJOR = 17;
/** Public Temurin mirror that works from mainland China (github.com blocked). */
const TUNA_ADOPTIUM_BASE = 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium';
const DEFAULT_JDK_MIRRORS = Object.freeze([TUNA_ADOPTIUM_BASE]);
const JDK_MIRROR_ENV = 'DSH_APK_VM_JDK_MIRROR';
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_EXTRACT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ARCHIVE_BYTES = 600 * 1024 * 1024;
const MAX_SCAN_DEPTH = 3;
const PROGRESS_STEP_BYTES = 16 * 1024 * 1024;
const MAX_EXTRACT_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Adoptium API `os` values for the platforms the plugin supports. */
const ADOPTIUM_OS = Object.freeze({ win32: 'windows', darwin: 'mac', linux: 'linux' });
/** Adoptium API `architecture` values for Node.js `process.arch` values. */
const ADOPTIUM_ARCH = Object.freeze({ x64: 'x64', arm64: 'aarch64', arm: 'aarch64' });

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function optionsObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function errorMessage(error) {
  if (!error) return 'unknown error';
  return error && error.message ? String(error.message) : String(error);
}

// ---------------------------------------------------------------------------
// China-mirror fallback (github.com is commonly blocked; Adoptium API is not)
// ---------------------------------------------------------------------------

/** Process environment, or the injected `options.env` map when one is given. */
function environmentFor(options) {
  const env = options.env;
  return env && typeof env === 'object' ? env : process.env;
}

/**
 * Normalize one mirror base URL. Returns the base without a trailing slash, ''
 * for an empty entry (ignored), or null when the URL is not https.
 */
function normalizeMirrorBase(value) {
  const base = nonEmptyString(value);
  if (!base) return '';
  if (!/^https:\/\//i.test(base)) return null;
  return base.replace(/\/+$/, '');
}

/** Parse a mirror option/env value (string separated by commas/space, or array). */
function parseMirrorList(value) {
  const pieces = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : null;
  if (!pieces) return { ok: false, error: 'options.jdkMirror must be a string or an array of strings' };
  const mirrors = [];
  for (const piece of pieces) {
    if (typeof piece !== 'string') {
      return { ok: false, error: 'options.jdkMirror entries must be strings' };
    }
    const base = normalizeMirrorBase(piece);
    if (base === null) return { ok: false, error: `invalid JDK mirror URL (https required): ${piece}` };
    if (base) mirrors.push(base);
  }
  return { ok: true, mirrors };
}

/**
 * Resolve the ordered mirror base URLs: `options.jdkMirror` (string or array;
 * empty disables mirrors) > `$DSH_APK_VM_JDK_MIRROR` > the TUNA default.
 */
function resolveJdkMirrors(options) {
  if (options.jdkMirror !== undefined && options.jdkMirror !== null) {
    return parseMirrorList(options.jdkMirror);
  }
  const env = environmentFor(options);
  const raw = env ? env[JDK_MIRROR_ENV] : undefined;
  if (raw !== undefined && raw !== null) return parseMirrorList(String(raw));
  return { ok: true, mirrors: [...DEFAULT_JDK_MIRRORS] };
}

/** Mirror URL for one Adoptium asset: `<base>/17/jdk/<arch>/<os>/<assetName>`. */
function mirrorAssetUrl(base, archName, osName, assetName) {
  return `${base}/${ADOPTIUM_MAJOR}/jdk/${archName}/${osName}/${assetName}`;
}

/** Build the ordered download candidates: the API link first, then each mirror. */
function downloadCandidates(asset, mirrors, archName, osName) {
  const candidates = [{ url: asset.link, viaMirror: false, label: 'Adoptium' }];
  for (const base of mirrors) {
    const url = mirrorAssetUrl(base, archName, osName, asset.name);
    if (candidates.some((candidate) => candidate.url === url)) continue;
    candidates.push({ url, viaMirror: true, mirrorBase: base, label: `mirror ${base}` });
  }
  return candidates;
}

/** Actionable aggregate error after every download source failed. */
function aggregateDownloadError(failures) {
  const detail = failures.length > 0 ? failures.join('; ') : 'no download source was attempted';
  return (
    `JDK download failed from all ${failures.length} source(s): ${detail}; ` +
    `set options.jdkMirror (or DSH_APK_VM_JDK_MIRROR) to another Temurin mirror`
  );
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

function fileSize(target) {
  const stats = statSafe(target);
  return stats && stats.isFile() ? stats.size : null;
}

function javaBinaryName(platform) {
  return platform === 'win32' ? 'java.exe' : 'java';
}

/** Newest-looking directory name first (numeric-aware, never throws). */
function compareNamesDesc(left, right) {
  return String(right).localeCompare(String(left), 'en', { numeric: true, sensitivity: 'base' });
}

/** True when `dir` looks like a JAVA_HOME (contains bin/java[.exe]). */
function isJavaHome(dir, platform) {
  return isFile(path.join(dir, 'bin', javaBinaryName(platform)));
}

/**
 * Breadth-first, depth-bounded scan for the first Java home under `root`.
 * Unreadable directories are skipped (each readdir is guarded) and symlinked
 * directories are not followed, so the scan can never loop.
 */
function scanForJavaHome(root, platform, maxDepth = MAX_SCAN_DEPTH) {
  if (!root || !isDirectory(root)) return null;
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (isJavaHome(current.dir, platform)) return current.dir;
    if (current.depth >= maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Playback/installation scratch directories never hold a usable JDK.
      if (entry.name === 'downloads' || entry.name.startsWith('.staging-')) continue;
      names.push(entry.name);
    }
    names.sort(compareNamesDesc);
    for (const name of names) {
      queue.push({ dir: path.join(current.dir, name), depth: current.depth + 1 });
    }
  }
  return null;
}

/** Parse a JDK version out of a java-home directory name (`jdk-17.0.9+9`). */
function jdkVersionFromHome(javaHome) {
  const base = path.basename(String(javaHome || ''));
  const versioned = /^(?:jdk|jre|java|openjdk)-?([0-9][0-9A-Za-z._+-]*)$/i.exec(base);
  if (versioned) return versioned[1];
  const loose = /(\d+(?:\.\d+){1,3}(?:[._+-]\d+)?)/.exec(base);
  return loose ? loose[1] : null;
}

function versionFromAssetName(name) {
  const match = /(\d+(?:\.\d+){1,3}(?:[._+-]\d+)?)/.exec(String(name || ''));
  return match ? match[1] : null;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Move a directory, falling back to copy+remove across filesystem devices. */
async function moveDirectory(source, target) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.rename(source, target);
    return;
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw error;
  }
  await fsp.cp(source, target, { recursive: true });
  await fsp.rm(source, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Public: directories and discovery
// ---------------------------------------------------------------------------

/**
 * Directory that owns every managed JDK: `options.jdkRoot`, else
 * `$DSH_APK_VM_JDK_DIR`, else `<home>/.dsh/apk-vm/jdk` (with `home` defaulting
 * to `os.homedir()`, i.e. `%USERPROFILE%\.dsh\apk-vm\jdk` on Windows).
 *
 * An injected `options.env` map is authoritative (the process environment is
 * then not consulted), which keeps hermetic tests deterministic.
 */
export function defaultJdkRoot(options = {}) {
  const opts = optionsObject(options);
  const explicit = nonEmptyString(opts.jdkRoot);
  if (explicit) return path.resolve(explicit);
  const envProvided = opts.env !== undefined && opts.env !== null && typeof opts.env === 'object';
  const envDir = envProvided
    ? nonEmptyString(opts.env.DSH_APK_VM_JDK_DIR)
    : nonEmptyString(process.env.DSH_APK_VM_JDK_DIR);
  if (envDir) return path.resolve(envDir);
  const home = nonEmptyString(opts.home) || os.homedir();
  return path.join(home, '.dsh', 'apk-vm', 'jdk');
}

/**
 * Synchronously find an already-provisioned managed JDK: a directory at
 * `jdkRoot` or at most three levels below it that contains `bin/java.exe`
 * (Windows) or `bin/java`. Returns the JAVA_HOME-style directory or null.
 * This function only reads the filesystem and never throws.
 */
export function findManagedJdk(options = {}) {
  const opts = optionsObject(options);
  try {
    const root = defaultJdkRoot(opts);
    if (!root) return null;
    const platform = nonEmptyString(opts.platform) || process.platform;
    return scanForJavaHome(root, platform);
  } catch {
    return null;
  }
}

/**
 * Build the Adoptium "latest Temurin 17" API URL for one OS/architecture pair.
 * `osName` is the Adoptium spelling (`windows` / `mac` / `linux`), `archName`
 * is `x64` or `aarch64`.
 */
export function adoptiumAssetUrl(osName, archName) {
  return (
    `${ADOPTIUM_LATEST_17}` +
    `?architecture=${encodeURIComponent(String(archName))}` +
    `&image_type=jdk&os=${encodeURIComponent(String(osName))}&vendor=eclipse`
  );
}

// ---------------------------------------------------------------------------
// Adoptium API
// ---------------------------------------------------------------------------

/** Validate one Adoptium asset entry, returning the download package or null. */
function parseAdoptiumPayload(payload) {
  if (!Array.isArray(payload) || payload.length === 0) return null;
  const first = payload[0];
  const pkg = first && typeof first === 'object' ? first.binary && first.binary.package : null;
  if (!pkg || typeof pkg !== 'object') return null;
  const link = nonEmptyString(pkg.link);
  const name = nonEmptyString(pkg.name);
  const checksum = nonEmptyString(pkg.checksum);
  if (!link || !name || !checksum) return null;
  if (!/^https:\/\//i.test(link)) return null;
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') return null;
  const size = Number(pkg.size);
  return {
    link,
    name,
    checksum: checksum.toLowerCase(),
    size: Number.isFinite(size) && size > 0 ? size : null,
  };
}

async function resolveAdoptiumAsset(options) {
  const fetchImpl =
    typeof options.fetchImpl === 'function'
      ? options.fetchImpl
      : typeof globalThis.fetch === 'function'
        ? globalThis.fetch
        : null;
  if (!fetchImpl) return { ok: false, error: 'fetch is unavailable in this Node.js runtime' };
  const url = adoptiumAssetUrl(options.os, options.arch);
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'follow', headers: { accept: 'application/json' } });
  } catch (error) {
    return { ok: false, error: `Adoptium API request failed: ${errorMessage(error)}` };
  }
  if (!response || typeof response !== 'object') {
    return { ok: false, error: 'Adoptium API returned no response' };
  }
  if (response.ok === false) {
    return { ok: false, error: `Adoptium API request failed (HTTP ${response.status || 'unknown'})` };
  }
  if (typeof response.json !== 'function') {
    return { ok: false, error: 'Adoptium API response is not readable JSON' };
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return { ok: false, error: `Adoptium API returned invalid JSON: ${errorMessage(error)}` };
  }
  const asset = parseAdoptiumPayload(payload);
  if (!asset) {
    return { ok: false, error: 'Adoptium API response did not contain a valid JDK 17 package' };
  }
  return { ok: true, ...asset, apiUrl: url };
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Default streaming downloader. Follows redirects, aborts after `timeoutMs`
 * and destroys the stream once `maxBytes` is exceeded. Returns
 * `{ ok, bytes?, error? }`; a partial file is removed on failure.
 */
async function downloadDefault(url, destination, options = {}) {
  const opts = optionsObject(options);
  const timeoutMs = positiveNumber(opts.timeoutMs, DEFAULT_DOWNLOAD_TIMEOUT_MS);
  const maxBytes = positiveNumber(opts.maxBytes, DEFAULT_MAX_ARCHIVE_BYTES);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  if (!/^https:\/\//i.test(String(url))) return { ok: false, error: 'JDK download URL must use https' };
  if (typeof globalThis.fetch !== 'function') {
    return { ok: false, error: 'fetch is unavailable in this Node.js runtime' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await globalThis.fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response || response.ok === false || !response.body) {
      return {
        ok: false,
        error: `JDK download failed: HTTP ${(response && response.status) || 'unknown'}`,
      };
    }
    const declared = Number(
      response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('content-length')
        : 0,
    );
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, error: `JDK download too large: ${declared} bytes (max ${maxBytes})` };
    }
    let bytes = 0;
    let nextReportAt = PROGRESS_STEP_BYTES;
    const body = Readable.fromWeb(response.body);
    body.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        body.destroy(new Error(`JDK download exceeded ${maxBytes} bytes`));
        return;
      }
      if (onProgress && bytes >= nextReportAt) {
        nextReportAt = bytes + PROGRESS_STEP_BYTES;
        try {
          onProgress({ received: bytes, total: declared > 0 ? declared : null });
        } catch {
          /* progress callbacks must not break the download */
        }
      }
    });
    await pipeline(body, createWriteStream(destination));
    return { ok: true, bytes };
  } catch (error) {
    const message = controller.signal.aborted
      ? `JDK download timed out after ${timeoutMs} ms`
      : errorMessage(error);
    await fsp.rm(destination, { force: true }).catch(() => {});
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Run one process with bounded output/time; resolves, never rejects. */
function runProcess(file, args, options = {}) {
  const opts = optionsObject(options);
  const timeoutMs = positiveNumber(opts.timeoutMs, DEFAULT_EXTRACT_TIMEOUT_MS);
  const maxBytes = positiveNumber(opts.maxBytes, MAX_EXTRACT_OUTPUT_BYTES);
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      return next.length > maxBytes ? next.slice(0, maxBytes) : next;
    };
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ code: null, timedOut: false, error: errorMessage(error), stdout, stderr });
      return;
    }
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) => {
      finish({ code: null, timedOut, error: errorMessage(error), stdout, stderr });
    });
    child.on('close', (code) => {
      finish({ code, timedOut, error: null, stdout, stderr });
    });
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Default extractor: `Expand-Archive` via powershell.exe on Windows (the OS
 * cannot unzip without a shell trampoline; argv are still separate entries),
 * `tar -xzf` on macOS/Linux.
 */
async function extractDefault(archive, destination, options = {}) {
  const opts = optionsObject(options);
  const platform = nonEmptyString(opts.platform) || process.platform;
  await fsp.mkdir(destination, { recursive: true });
  let result;
  if (platform === 'win32') {
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const script =
      `Expand-Archive -LiteralPath ${quote(archive)} ` +
      `-DestinationPath ${quote(destination)} -Force`;
    result = await runProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeoutMs: positiveNumber(opts.timeoutMs, DEFAULT_EXTRACT_TIMEOUT_MS) },
    );
  } else if (platform === 'darwin' || platform === 'linux') {
    result = await runProcess('tar', ['-xzf', archive, '-C', destination], {
      timeoutMs: positiveNumber(opts.timeoutMs, DEFAULT_EXTRACT_TIMEOUT_MS),
    });
  } else {
    return { ok: false, error: `unsupported platform for JDK extraction: ${platform}` };
  }
  if (result.error) return { ok: false, error: `JDK extraction failed: ${result.error}` };
  if (result.timedOut) return { ok: false, error: 'JDK extraction timed out' };
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').slice(0, 400);
    return { ok: false, error: `JDK extraction failed (exit ${result.code}): ${detail || 'no output'}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Public: ensureJdk
// ---------------------------------------------------------------------------

/**
 * Ensure a managed Temurin JDK 17 exists, downloading and extracting it when
 * needed. Never throws for expected failures; every step is injectable.
 *
 * Options: `jdkRoot`, `home`, `env`, `platform`, `arch`, `fetchImpl`,
 * `download`, `extract`, `log`, `onProgress`, `timeoutMs`, `maxBytes`,
 * `jdkMirror` (base URL or array of base URLs for the China fallback).
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   cached?: boolean,
 *   javaHome?: string,
 *   version?: string|null,
 *   url?: string|null,
 *   viaMirror?: boolean,
 *   bytes?: number|null,
 *   sha256?: string|null,
 *   error?: string,
 * }>}
 */
export async function ensureJdk(options = {}) {
  const opts = optionsObject(options);
  const platform = nonEmptyString(opts.platform) || process.platform;
  const progress = (step, message, extra) => {
    if (typeof opts.log === 'function') {
      try {
        opts.log(message);
      } catch {
        /* logging must not break provisioning */
      }
    }
    if (typeof opts.onProgress === 'function') {
      try {
        opts.onProgress({ step, message, ...(extra && typeof extra === 'object' ? extra : {}) });
      } catch {
        /* progress callbacks must not break provisioning */
      }
    }
  };

  try {
    const jdkRoot = defaultJdkRoot(opts);
    if (!jdkRoot) return { ok: false, error: 'could not determine the managed JDK directory' };

    const cached = findManagedJdk({ ...opts, jdkRoot });
    if (cached) {
      progress('cached', `Using existing managed JDK at ${cached}`);
      return {
        ok: true,
        cached: true,
        javaHome: cached,
        version: jdkVersionFromHome(cached),
        url: null,
        viaMirror: false,
        bytes: null,
        sha256: null,
      };
    }

    const osName = ADOPTIUM_OS[platform];
    if (!osName) return { ok: false, error: `unsupported platform for JDK download: ${platform}` };
    const archName = ADOPTIUM_ARCH[nonEmptyString(opts.arch) || process.arch];
    if (!archName) {
      return {
        ok: false,
        error: `unsupported architecture for JDK download: ${opts.arch || process.arch}`,
      };
    }
    const mirrorConfig = resolveJdkMirrors(opts);
    if (!mirrorConfig.ok) return { ok: false, error: mirrorConfig.error };

    progress('resolve', `Resolving Eclipse Temurin JDK 17 for ${osName}-${archName}`);
    const asset = await resolveAdoptiumAsset({ ...opts, os: osName, arch: archName });
    if (!asset.ok) return { ok: false, error: asset.error };

    const downloadsDir = path.join(jdkRoot, 'downloads');
    const archive = path.join(downloadsDir, asset.name);
    let bytes = null;
    let digest = null;
    let source = null;

    if (existsSync(archive)) {
      digest = await sha256File(archive);
      if (digest === asset.checksum) {
        bytes = fileSize(archive);
        source = { url: asset.link, viaMirror: false };
        progress('download', `Reusing verified archive ${asset.name}`);
      } else {
        await fsp.rm(archive, { force: true }).catch(() => {});
        digest = null;
      }
    }

    if (!digest) {
      await fsp.mkdir(downloadsDir, { recursive: true });
      const downloadFn = typeof opts.download === 'function' ? opts.download : downloadDefault;
      const candidates = downloadCandidates(asset, mirrorConfig.mirrors, archName, osName);
      const failures = [];
      const sizeHint = asset.size ? ` (~${Math.round(asset.size / (1024 * 1024))} MB)` : '';
      for (const candidate of candidates) {
        progress('download', `Downloading ${asset.name} from ${candidate.label}${sizeHint}`);
        let downloadResult;
        try {
          downloadResult = await downloadFn(candidate.url, archive, {
            timeoutMs: positiveNumber(opts.timeoutMs, DEFAULT_DOWNLOAD_TIMEOUT_MS),
            maxBytes: positiveNumber(opts.maxBytes, DEFAULT_MAX_ARCHIVE_BYTES),
            onProgress: (value) => progress('download', `Downloading ${asset.name}`, value),
          });
        } catch (error) {
          downloadResult = { ok: false, error: errorMessage(error) };
        }
        if (!downloadResult || downloadResult.ok !== true) {
          await fsp.rm(archive, { force: true }).catch(() => {});
          const detail = downloadResult && downloadResult.error ? downloadResult.error : 'unknown error';
          failures.push(`${candidate.label}: ${detail}`);
          continue;
        }
        if (!existsSync(archive)) {
          failures.push(`${candidate.label}: download did not create an archive file`);
          continue;
        }
        const size = fileSize(archive);
        if (asset.size !== null && size !== asset.size) {
          await fsp.rm(archive, { force: true }).catch(() => {});
          failures.push(`${candidate.label}: size mismatch (expected ${asset.size} bytes, got ${size})`);
          continue;
        }
        const hash = await sha256File(archive);
        if (hash !== asset.checksum) {
          await fsp.rm(archive, { force: true }).catch(() => {});
          failures.push(
            `${candidate.label}: checksum mismatch (expected ${asset.checksum}, got ${hash})`,
          );
          continue;
        }
        bytes = size;
        digest = hash;
        source = candidate;
        break;
      }
      if (!source) return { ok: false, error: aggregateDownloadError(failures) };
    }

    const sha256 = digest;
    progress(
      'download',
      `Verified ${asset.name} (${bytes === null ? 'unknown' : bytes} bytes, sha256 ${sha256.slice(0, 12)}...)`,
    );

    const extractFn = typeof opts.extract === 'function' ? opts.extract : extractDefault;
    const staging = path.join(jdkRoot, `.staging-${Date.now()}-${process.pid}`);
    try {
      await fsp.mkdir(staging, { recursive: true });
      progress('extract', `Extracting ${asset.name}`);
      let extractResult;
      try {
        extractResult = await extractFn(archive, staging, { platform });
      } catch (error) {
        return { ok: false, error: `JDK extraction failed: ${errorMessage(error)}` };
      }
      if (!extractResult || extractResult.ok !== true) {
        const detail = extractResult && extractResult.error ? extractResult.error : 'unknown error';
        return { ok: false, error: `JDK extraction failed: ${detail}` };
      }

      const stagedHome = scanForJavaHome(staging, platform);
      if (!stagedHome) {
        return { ok: false, error: 'JDK archive did not contain a usable bin/java' };
      }
      const fallbackName = `jdk-${versionFromAssetName(asset.name) || '17'}`;
      const targetName = stagedHome === staging ? fallbackName : path.basename(stagedHome);
      const target = path.join(jdkRoot, targetName);
      await fsp.rm(target, { recursive: true, force: true });
      progress('install', `Installing JDK into ${target}`);
      await moveDirectory(stagedHome, target);
    } finally {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }

    const installed = findManagedJdk({ ...opts, jdkRoot });
    if (!installed) {
      return { ok: false, error: 'JDK was extracted but no bin/java was found afterwards' };
    }
    const version = jdkVersionFromHome(installed) || versionFromAssetName(asset.name);
    const viaMirror = Boolean(source && source.viaMirror);
    progress('done', `JDK 17 ready at ${installed}${viaMirror ? ' (via mirror)' : ''}`);
    return {
      ok: true,
      cached: false,
      javaHome: installed,
      version,
      url: source ? source.url : asset.link,
      viaMirror,
      bytes,
      sha256,
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
