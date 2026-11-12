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
 *   defaultJdkRoot(options)                      -> string (directory)
 *   findManagedJdk(options)                      -> string | null  (sync scan)
 *   ensureJdk(options)                           -> Promise<result> (never throws)
 *   adoptiumAssetUrl(osName, archName, version?) -> string
 *   knownGoodJdkAsset(version, osName, archName) -> { ok, link, name, ... }
 *   KNOWN_GOOD_JDK_RELEASES                      -> frozen asset table
 *
 * `ensureJdk()` success result (all fields always present):
 *   { ok: true, cached: boolean, javaHome: string, version: string|null,
 *     url: string|null, viaMirror: boolean, bytes: number|null,
 *     sha256: string|null, source: 'api'|'known-good'|null, jdkVersion: number }
 *   { ok: false, error: string, jdkVersion?: number }
 *
 * `options.jdkVersion` pins the Temurin major version (default 17, accepted
 * range 8..99). An existing managed JDK with a different major version is
 * bypassed, and the freshly extracted version is checked against the pin.
 *
 * Known-good fallback
 * -------------------
 * The Adoptium API (api.adoptium.net) is normally reachable, but it can be
 * blocked by a corporate proxy/firewall independently of github.com. If the
 * API cannot resolve an asset, `ensureJdk()` falls back to the bundled
 * `KNOWN_GOOD_JDK_RELEASES` table (same asset name, byte size and SHA-256 as
 * the API returned for that release) and downloads it from GitHub or a mirror
 * with the exact same verification. The result then carries `source:
 * 'known-good'`; API-resolved downloads carry `source: 'api'`.
 *
 * China fallback and resumable downloads
 * --------------------------------------
 * The package the API links to is on github.com, which can be blocked. When
 * the primary link fails for ANY reason (network error, HTTP error, size
 * mismatch, checksum mismatch), `ensureJdk()` retries the same asset name from
 * Temurin mirrors in order and still verifies every download against the
 * SHA-256 and size. Mirrors come from `options.jdkMirror` (a base URL or an
 * array of base URLs), else `$DSH_APK_VM_JDK_MIRROR` (comma/whitespace
 * separated), else the Tsinghua University TUNA mirror. An explicit empty
 * array/string disables mirrors. `<base>/<major>/jdk/<arch>/<os>/<assetName>`
 * is the mirror URL template.
 *
 * A partial archive is never deleted just because a source failed: it is kept
 * in `<jdkRoot>/downloads` and the next source/retry continues with an HTTP
 * `Range` request (`downloadDefault`), so retrying is cheap. Only a completed
 * but corrupt (checksum mismatch) or oversized archive is discarded.
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
 *         (opts: { timeoutMs, maxBytes, resume, expectedSize, onProgress })
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

const ADOPTIUM_API_LATEST = 'https://api.adoptium.net/v3/assets/latest';
/** Temurin major version handled by this module by default. */
const ADOPTIUM_MAJOR = 17;
/** Public Temurin mirror that works from mainland China (github.com blocked). */
const TUNA_ADOPTIUM_BASE = 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium';
const DEFAULT_JDK_MIRRORS = Object.freeze([TUNA_ADOPTIUM_BASE]);
const JDK_MIRROR_ENV = 'DSH_APK_VM_JDK_MIRROR';
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_EXTRACT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ARCHIVE_BYTES = 600 * 1024 * 1024;
/** Bound for the small Adoptium API lookup (a blocked API must not stall setup). */
const DEFAULT_API_TIMEOUT_MS = 15 * 1000;
/** Reachability probe bound; a dead source is skipped after this. */
const DEFAULT_CANDIDATE_PROBE_TIMEOUT_MS = 8 * 1000;
/**
 * Per-source download cap for sources that are not the last one. A hanging
 * primary (for example the GitHub-hosted asset on a network where github.com is
 * dropped silently) must not consume the whole download budget before the
 * built-in mirror is tried; the final source keeps the full timeout.
 */
const DEFAULT_NON_FINAL_CANDIDATE_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_SCAN_DEPTH = 3;
const PROGRESS_STEP_BYTES = 16 * 1024 * 1024;
const MAX_EXTRACT_OUTPUT_BYTES = 2 * 1024 * 1024;
/** Accepted range for the `jdkVersion` option (Temurin majors that exist). */
const MIN_JDK_VERSION = 8;
const MAX_JDK_VERSION = 99;
/** GitHub Releases base for Temurin binaries; mirrors serve the same assets. */
const TEMURIN_BINARIES_BASE = 'https://github.com/adoptium';

/**
 * Static known-good Eclipse Temurin releases.
 *
 * The Adoptium API is normally reachable (it is not hosted on github.com), but
 * the API can be blocked by a proxy/firewall or be briefly unavailable while
 * the GitHub release it points at is reachable through a mirror. In that case
 * the plugin falls back to this table: the same asset names, byte sizes and
 * sha256 digests that the API returned for the release, so the download is
 * still integrity-verified. Values below were generated from
 * https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse
 * (and the matching linux/mac queries) on 2026-11-12 for release
 * `jdk-17.0.21+9`. Keep `source` in sync: an asset listed here is downloaded
 * and verified exactly like an API-resolved one.
 *
 * Tests may inject a replacement table via `options.knownGoodReleases`.
 */
export const KNOWN_GOOD_JDK_RELEASES = Object.freeze({
  17: Object.freeze({
    release: 'jdk-17.0.21+9',
    version: '17.0.21+9',
    assets: Object.freeze({
      'windows-x64': Object.freeze({
        name: 'OpenJDK17U-jdk_x64_windows_hotspot_17.0.21_9.zip',
        size: 191117380,
        sha256: '98518ecf554465057ee5509462631deeee374bc368c12a411d225cd29381f84b',
      }),
      'linux-x64': Object.freeze({
        name: 'OpenJDK17U-jdk_x64_linux_hotspot_17.0.21_9.tar.gz',
        size: 193594705,
        sha256: '8b9b611d917e3dfd8419d3566b5949226f69b052fed7e109c1368add1dfe8711',
      }),
      'linux-aarch64': Object.freeze({
        name: 'OpenJDK17U-jdk_aarch64_linux_hotspot_17.0.21_9.tar.gz',
        size: 192336814,
        sha256: '3e4eca7ead088f080af1476007decf010a240a1eb4e1e78c54fa32fbcc347084',
      }),
      'mac-x64': Object.freeze({
        name: 'OpenJDK17U-jdk_x64_mac_hotspot_17.0.21_9.tar.gz',
        size: 180879475,
        sha256: '868f5c672b3389fdbe48e44f94ae170f01668b1401360944fc7159d7cc9772cc',
      }),
      'mac-aarch64': Object.freeze({
        name: 'OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.21_9.tar.gz',
        size: 186192554,
        sha256: '78b08c7f5a0598242d5719c022e19479cb4a3aa45c37c19726a757a469ed1c15',
      }),
    }),
  }),
});

/** Adoptium API `os` values for the platforms the plugin supports. */
const ADOPTIUM_OS = Object.freeze({ win32: 'windows', darwin: 'mac', linux: 'linux' });
/** Adoptium API `architecture` values for Node.js `process.arch` values. */
const ADOPTIUM_ARCH = Object.freeze({ x64: 'x64', arm64: 'aarch64', arm: 'aarch64' });

/** GitHub Releases link for one known-good Temurin asset. */
function knownGoodReleaseUrl(major, release, assetName) {
  return `${TEMURIN_BINARIES_BASE}/temurin${major}-binaries/releases/download/${encodeURIComponent(release)}/${assetName}`;
}

/**
 * Look up the bundled known-good Temurin asset for `(major, os, arch)`.
 *
 * Returns `{ ok: true, link, name, checksum, size, source: 'known-good',
 * version, release }` or `{ ok: false, error }`. `releases` overrides the
 * static table (used by tests).
 */
export function knownGoodJdkAsset(
  jdkVersion = ADOPTIUM_MAJOR,
  osName = '',
  archName = '',
  releases = KNOWN_GOOD_JDK_RELEASES,
) {
  const major = Number(jdkVersion);
  const table = releases && typeof releases === 'object' && !Array.isArray(releases) ? releases : KNOWN_GOOD_JDK_RELEASES;
  const entry = table[major] || table[String(major)];
  if (!entry || typeof entry !== 'object' || !entry.assets || typeof entry.assets !== 'object') {
    return { ok: false, error: `no known-good Eclipse Temurin ${major} release is bundled for offline setup` };
  }
  const key = `${osName}-${archName}`;
  const pkg = entry.assets[key];
  if (!pkg || typeof pkg !== 'object') {
    return { ok: false, error: `no known-good Eclipse Temurin ${major} package is bundled for ${key}` };
  }
  const name = nonEmptyString(pkg.name);
  const checksum = nonEmptyString(pkg.sha256 || pkg.checksum).toLowerCase();
  const size = Number(pkg.size);
  const release = nonEmptyString(entry.release);
  if (!name || !release || !/^[0-9a-f]{64}$/.test(checksum) || !Number.isFinite(size) || size <= 0) {
    return { ok: false, error: `the bundled known-good Temurin ${major} entry for ${key} is invalid` };
  }
  const version = nonEmptyString(entry.version) || versionFromAssetName(name) || null;
  return {
    ok: true,
    link: knownGoodReleaseUrl(major, release, name),
    name,
    checksum,
    size,
    version,
    release: release || null,
    source: 'known-good',
  };
}

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

/** Mirror URL for one Adoptium asset: `<base>/<major>/jdk/<arch>/<os>/<assetName>`. */
function mirrorAssetUrl(base, archName, osName, assetName, major = ADOPTIUM_MAJOR) {
  return `${base}/${major}/jdk/${archName}/${osName}/${assetName}`;
}

/** Build the ordered download candidates: the API link first, then each mirror. */
function downloadCandidates(asset, mirrors, archName, osName, major = ADOPTIUM_MAJOR) {
  const candidates = [{ url: asset.link, viaMirror: false, label: 'Adoptium' }];
  for (const base of mirrors) {
    const url = mirrorAssetUrl(base, archName, osName, asset.name, major);
    if (candidates.some((candidate) => candidate.url === url)) continue;
    candidates.push({ url, viaMirror: true, mirrorBase: base, label: `mirror ${base}` });
  }
  return candidates;
}

/** Actionable aggregate error after every download source failed. */
function aggregateDownloadError(failures, extra) {
  const detail = failures.length > 0 ? failures.join('; ') : 'no download source was attempted';
  const resumeHint = nonEmptyString(extra);
  return (
    `JDK download failed from all ${failures.length} source(s): ${detail}; ` +
    (resumeHint ? `${resumeHint}; ` : '') +
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
 * Build the Adoptium "latest Temurin <major>" API URL for one OS/architecture
 * pair. `osName` is the Adoptium spelling (`windows` / `mac` / `linux`),
 * `archName` is `x64` or `aarch64`; `version` defaults to Temurin 17.
 */
export function adoptiumAssetUrl(osName, archName, version = ADOPTIUM_MAJOR) {
  return (
    `${ADOPTIUM_API_LATEST}/${encodeURIComponent(String(version))}/hotspot` +
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
  const url = adoptiumAssetUrl(options.os, options.arch, options.version);
  const timeoutMs = positiveNumber(options.apiTimeoutMs, DEFAULT_API_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    return {
      ok: false,
      error: controller.signal.aborted
        ? `Adoptium API request timed out after ${timeoutMs} ms`
        : `Adoptium API request failed: ${errorMessage(error)}`,
    };
  } finally {
    clearTimeout(timer);
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
    const version = Number(options.version) || ADOPTIUM_MAJOR;
    return { ok: false, error: `Adoptium API response did not contain a valid JDK ${version} package` };
  }
  return { ok: true, ...asset, apiUrl: url };
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Quick reachability probe for a download source. A blocked host can accept a
 * TCP connection attempt forever (packets are dropped, so neither `fetch`
 * resolves nor rejects promptly); probing with a short HEAD request lets
 * `ensureJdk` skip a dead primary and reach the working mirror in seconds
 * instead of waiting out the whole download budget.
 *
 * Only 2xx, 3xx, 403 and 405 are treated as reachable: 403/405 mean the server
 * answered but refuses HEAD, so the real GET is still attempted and decides.
 */
async function probeDownloadCandidate(url, options = {}) {
  const opts = optionsObject(options);
  const timeoutMs = positiveNumber(opts.timeoutMs, DEFAULT_CANDIDATE_PROBE_TIMEOUT_MS);
  const fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
  if (!fetchImpl) return { ok: false, error: 'fetch is unavailable in this Node.js runtime' };
  if (!/^https:\/\//i.test(String(url))) return { ok: false, error: 'not an https URL' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { accept: '*/*' },
    });
    if (!response || typeof response !== 'object') return { ok: false, error: 'no response' };
    const status = Number(response.status) || 0;
    if (response.ok === true || (status >= 300 && status < 400) || status === 403 || status === 405) {
      return { ok: true, status };
    }
    return { ok: false, error: `HTTP ${status || 'unknown'}` };
  } catch (error) {
    return {
      ok: false,
      error: controller.signal.aborted ? `no response within ${timeoutMs} ms` : errorMessage(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Default streaming downloader. Follows redirects, aborts after `timeoutMs`
 * and destroys the stream once `maxBytes` is exceeded. When
 * `options.resume === true` and `destination` already holds a partial file,
 * the download continues with an HTTP `Range` request; a server that ignores
 * the range restarts the file from byte 0. A partial file is kept on failure
 * so the next source or retry can resume it (`{ ok, bytes?, error? }`).
 */
async function downloadDefault(url, destination, options = {}) {
  const opts = optionsObject(options);
  const timeoutMs = positiveNumber(opts.timeoutMs, DEFAULT_DOWNLOAD_TIMEOUT_MS);
  const maxBytes = positiveNumber(opts.maxBytes, DEFAULT_MAX_ARCHIVE_BYTES);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const resume = opts.resume === true;
  if (!/^https:\/\//i.test(String(url))) return { ok: false, error: 'JDK download URL must use https' };
  if (typeof globalThis.fetch !== 'function') {
    return { ok: false, error: 'fetch is unavailable in this Node.js runtime' };
  }
  const existingStats = resume ? statSafe(destination) : null;
  const existingBytes = existingStats && existingStats.isFile() ? existingStats.size : 0;
  const headers = {};
  if (existingBytes > 0) headers.range = `bytes=${existingBytes}-`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await globalThis.fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers,
    });
    if (!response || response.ok === false || !response.body) {
      const status = (response && response.status) || 'unknown';
      if (existingBytes > 0) {
        // A stale partial file can make a server answer 416; drop it so the
        // next attempt (or the next mirror) restarts from scratch.
        await fsp.rm(destination, { force: true }).catch(() => {});
      }
      return { ok: false, error: `JDK download failed: HTTP ${status}` };
    }
    const resumed = existingBytes > 0 && response.status === 206;
    if (!resumed && existingBytes > 0) {
      // The server ignored the Range header: restart the file from byte 0.
      await fsp.rm(destination, { force: true }).catch(() => {});
    }
    const offset = resumed ? existingBytes : 0;
    const declared = Number(
      response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('content-length')
        : 0,
    );
    const total = Number.isFinite(declared) && declared > 0 ? offset + declared : null;
    if (total !== null && total > maxBytes) {
      return { ok: false, error: `JDK download too large: ${total} bytes (max ${maxBytes})` };
    }
    let bytes = offset;
    let nextReportAt = offset + PROGRESS_STEP_BYTES;
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
          onProgress({ received: bytes, total });
        } catch {
          /* progress callbacks must not break the download */
        }
      }
    });
    await pipeline(body, createWriteStream(destination, { flags: resumed ? 'a' : 'w' }));
    return { ok: true, bytes };
  } catch (error) {
    const message = controller.signal.aborted
      ? `JDK download timed out after ${timeoutMs} ms`
      : errorMessage(error);
    // Keep the partial file: the next mirror or retry resumes it.
    const partialBytes = fileSize(destination);
    return { ok: false, error: message, bytes: partialBytes === null ? 0 : partialBytes };
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

/** Leading numeric major version of a JDK version string ('17.0.9+9' -> 17). */
function majorVersionOf(version) {
  const match = /^(\d+)/.exec(String(version === null || version === undefined ? '' : version));
  return match ? Number(match[1]) : null;
}

/** Validate the `jdkVersion` option (defaults to Temurin 17). */
function resolveJdkMajor(value) {
  if (value === undefined || value === null || value === '') return { ok: true, major: ADOPTIUM_MAJOR };
  const major = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(major) || major < MIN_JDK_VERSION || major > MAX_JDK_VERSION) {
    return {
      ok: false,
      error:
        `options.jdkVersion must be an integer between ${MIN_JDK_VERSION} and ${MAX_JDK_VERSION} ` +
        `(received ${JSON.stringify(value)})`,
    };
  }
  return { ok: true, major };
}

/**
 * Ensure a managed Eclipse Temurin JDK exists (Temurin 17 by default),
 * downloading and extracting it when needed. Never throws for expected
 * failures; every step is injectable.
 *
 * Resolution order: a JDK already installed in `jdkRoot` (skipped when it does
 * not match an explicitly pinned `jdkVersion`) -> the Adoptium API -> the
 * bundled known-good table when the API is blocked/unavailable (the archive is
 * still downloaded from GitHub or a mirror and sha256-verified).
 *
 * Options: `jdkRoot`, `home`, `env`, `platform`, `arch`, `fetchImpl`,
 * `download`, `extract`, `log`, `onProgress`, `timeoutMs`, `maxBytes`,
 * `jdkVersion` (Temurin major, default 17), `jdkMirror` (base URL or array of
 * base URLs for the China fallback), `knownGoodReleases` (table override used
 * by tests), `probe` (reachability probe override used by tests),
 * `probeTimeoutMs` (default 8 s), `apiTimeoutMs` (default 15 s) and
 * `candidateTimeoutMs` (per-source cap for non-final sources, default 2 min).
 *
 * When the built-in downloader is used and more than one source is available,
 * every non-final source is first probed with a short HEAD request and skipped
 * when it does not answer, and non-final sources get a shorter download
 * timeout. This keeps a silently-blackholed GitHub release from stalling the
 * whole setup before the built-in mirror is tried.
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
 *   source?: 'api'|'known-good'|null,
 *   jdkVersion?: number,
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
    const versionConfig = resolveJdkMajor(opts.jdkVersion);
    if (!versionConfig.ok) return { ok: false, error: versionConfig.error };
    const major = versionConfig.major;
    const pinned = opts.jdkVersion !== undefined && opts.jdkVersion !== null && opts.jdkVersion !== '';

    const jdkRoot = defaultJdkRoot(opts);
    if (!jdkRoot) {
      return { ok: false, error: 'could not determine the managed JDK directory', jdkVersion: major };
    }

    const cached = findManagedJdk({ ...opts, jdkRoot });
    if (cached) {
      const cachedVersion = jdkVersionFromHome(cached);
      const cachedMajor = majorVersionOf(cachedVersion);
      if (!pinned || cachedMajor === null || cachedMajor === major) {
        progress('cached', `Using existing managed JDK at ${cached}`);
        return {
          ok: true,
          cached: true,
          javaHome: cached,
          version: cachedVersion,
          url: null,
          viaMirror: false,
          bytes: null,
          sha256: null,
          source: null,
          jdkVersion: major,
        };
      }
      progress(
        'cached',
        `Existing managed JDK at ${cached} is version ${cachedVersion}; ` +
          `installing the pinned Temurin ${major}`,
      );
    }

    const osName = ADOPTIUM_OS[platform];
    if (!osName) {
      return { ok: false, error: `unsupported platform for JDK download: ${platform}`, jdkVersion: major };
    }
    const archName = ADOPTIUM_ARCH[nonEmptyString(opts.arch) || process.arch];
    if (!archName) {
      return {
        ok: false,
        error: `unsupported architecture for JDK download: ${opts.arch || process.arch}`,
        jdkVersion: major,
      };
    }
    const mirrorConfig = resolveJdkMirrors(opts);
    if (!mirrorConfig.ok) return { ok: false, error: mirrorConfig.error, jdkVersion: major };

    progress('resolve', `Resolving Eclipse Temurin JDK ${major} for ${osName}-${archName}`);
    const apiAsset = await resolveAdoptiumAsset({ ...opts, os: osName, arch: archName, version: major });
    let asset;
    let apiLookupError = null;
    if (apiAsset.ok) {
      asset = { ...apiAsset, source: 'api' };
    } else {
      apiLookupError = apiAsset.error;
      const fallback = knownGoodJdkAsset(major, osName, archName, opts.knownGoodReleases);
      if (!fallback.ok) {
        return {
          ok: false,
          error:
            `${apiAsset.error}; ${fallback.error}; ` +
            'retry with network access or set options.jdkMirror ' +
            '(or DSH_APK_VM_JDK_MIRROR) to a Temurin mirror that has this release',
          jdkVersion: major,
        };
      }
      asset = fallback;
      progress(
        'resolve',
        `Adoptium API unavailable (${apiAsset.error}); using the bundled known-good ` +
          `${asset.name} (Temurin ${asset.version || major})`,
      );
    }

    const downloadsDir = path.join(jdkRoot, 'downloads');
    const archive = path.join(downloadsDir, asset.name);
    let bytes = null;
    let digest = null;
    let origin = null;
    let partialBytes = 0;

    if (existsSync(archive)) {
      const archivedSize = fileSize(archive);
      if (asset.size !== null && archivedSize !== null && archivedSize === asset.size) {
        const archivedDigest = await sha256File(archive);
        if (archivedDigest === asset.checksum) {
          digest = archivedDigest;
          bytes = archivedSize;
          origin = { url: asset.link, viaMirror: false };
          progress('download', `Reusing verified archive ${asset.name}`);
        } else {
          await fsp.rm(archive, { force: true }).catch(() => {});
          progress('download', `Discarding a corrupt archive ${asset.name} (checksum mismatch)`);
        }
      } else if (
        asset.size !== null &&
        archivedSize !== null &&
        archivedSize > 0 &&
        archivedSize < asset.size
      ) {
        partialBytes = archivedSize;
        progress(
          'download',
          `Found a partial ${asset.name} (${archivedSize} of ${asset.size} bytes); ` +
            'retrying is safe and will resume it',
        );
      } else {
        await fsp.rm(archive, { force: true }).catch(() => {});
      }
    }

    if (!origin) {
      await fsp.mkdir(downloadsDir, { recursive: true });
      const usingDefaultDownload = typeof opts.download !== 'function';
      const downloadFn = usingDefaultDownload ? downloadDefault : opts.download;
      const candidates = downloadCandidates(asset, mirrorConfig.mirrors, archName, osName, major);
      const probeFn =
        typeof opts.probe === 'function'
          ? opts.probe
          : usingDefaultDownload && candidates.length > 1
            ? probeDownloadCandidate
            : null;
      const failures = [];
      const sizeHint = asset.size ? ` (~${Math.round(asset.size / (1024 * 1024))} MB)` : '';
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        const isFinalCandidate = index === candidates.length - 1;
        if (probeFn && !isFinalCandidate) {
          const probe = await probeFn(candidate.url, {
            timeoutMs: positiveNumber(opts.probeTimeoutMs, DEFAULT_CANDIDATE_PROBE_TIMEOUT_MS),
          });
          if (!probe || probe.ok !== true) {
            failures.push(
              `${candidate.label}: unreachable (${probe && probe.error ? probe.error : 'no response'})`,
            );
            continue;
          }
        }
        const resumeHint = partialBytes > 0 ? ` (resuming at ${partialBytes} bytes)` : '';
        progress('download', `Downloading ${asset.name} from ${candidate.label}${sizeHint}${resumeHint}`);
        const baseTimeoutMs = positiveNumber(opts.timeoutMs, DEFAULT_DOWNLOAD_TIMEOUT_MS);
        const candidateTimeoutMs = isFinalCandidate
          ? baseTimeoutMs
          : Math.min(
              baseTimeoutMs,
              positiveNumber(opts.candidateTimeoutMs, DEFAULT_NON_FINAL_CANDIDATE_TIMEOUT_MS),
            );
        let downloadResult;
        try {
          downloadResult = await downloadFn(candidate.url, archive, {
            timeoutMs: candidateTimeoutMs,
            maxBytes: positiveNumber(opts.maxBytes, DEFAULT_MAX_ARCHIVE_BYTES),
            resume: true,
            expectedSize: asset.size,
            onProgress: (value) => progress('download', `Downloading ${asset.name}`, value),
          });
        } catch (error) {
          downloadResult = { ok: false, error: errorMessage(error) };
        }
        const downloadedSize = fileSize(archive);
        if (!downloadResult || downloadResult.ok !== true) {
          partialBytes =
            asset.size !== null &&
            downloadedSize !== null &&
            downloadedSize > 0 &&
            downloadedSize < asset.size
              ? downloadedSize
              : 0;
          const detail = downloadResult && downloadResult.error ? downloadResult.error : 'unknown error';
          const kept = partialBytes > 0 ? ` (${partialBytes} of ${asset.size} bytes kept for resume)` : '';
          failures.push(`${candidate.label}: ${detail}${kept}`);
          continue;
        }
        if (!existsSync(archive)) {
          partialBytes = 0;
          failures.push(`${candidate.label}: download did not create an archive file`);
          continue;
        }
        const size = fileSize(archive);
        if (asset.size !== null && size !== asset.size) {
          if (size !== null && size > 0 && size < asset.size) {
            partialBytes = size;
            failures.push(
              `${candidate.label}: incomplete download (expected ${asset.size} bytes, got ${size}); ` +
                'the partial archive was kept so the next retry resumes it',
            );
          } else {
            await fsp.rm(archive, { force: true }).catch(() => {});
            partialBytes = 0;
            failures.push(`${candidate.label}: size mismatch (expected ${asset.size} bytes, got ${size})`);
          }
          continue;
        }
        const hash = await sha256File(archive);
        if (hash !== asset.checksum) {
          await fsp.rm(archive, { force: true }).catch(() => {});
          partialBytes = 0;
          failures.push(`${candidate.label}: checksum mismatch (expected ${asset.checksum}, got ${hash})`);
          continue;
        }
        bytes = size;
        digest = hash;
        origin = candidate;
        partialBytes = 0;
        break;
      }
      if (!origin) {
        const notes = [];
        if (partialBytes > 0) {
          notes.push(
            `a partial archive was kept (${partialBytes} bytes); retrying is safe and resumes the download`,
          );
        }
        if (apiLookupError) {
          notes.push(`the Adoptium API lookup failed too (${apiLookupError})`);
        }
        return {
          ok: false,
          error: aggregateDownloadError(failures, notes.join('; ')),
          jdkVersion: major,
        };
      }
    }

    const sha256 = digest;
    progress(
      'download',
      `Verified ${asset.name} (${bytes === null ? 'unknown' : bytes} bytes, sha256 ${sha256.slice(0, 12)}...)`,
    );

    const extractFn = typeof opts.extract === 'function' ? opts.extract : extractDefault;
    const staging = path.join(jdkRoot, `.staging-${Date.now()}-${process.pid}`);
    let target = null;
    try {
      await fsp.mkdir(staging, { recursive: true });
      progress('extract', `Extracting ${asset.name}`);
      let extractResult;
      try {
        extractResult = await extractFn(archive, staging, { platform });
      } catch (error) {
        return { ok: false, error: `JDK extraction failed: ${errorMessage(error)}`, jdkVersion: major };
      }
      if (!extractResult || extractResult.ok !== true) {
        const detail = extractResult && extractResult.error ? extractResult.error : 'unknown error';
        return { ok: false, error: `JDK extraction failed: ${detail}`, jdkVersion: major };
      }

      const stagedHome = scanForJavaHome(staging, platform);
      if (!stagedHome) {
        return { ok: false, error: 'JDK archive did not contain a usable bin/java', jdkVersion: major };
      }
      const fallbackName = `jdk-${versionFromAssetName(asset.name) || major}`;
      const targetName = stagedHome === staging ? fallbackName : path.basename(stagedHome);
      target = path.join(jdkRoot, targetName);
      await fsp.rm(target, { recursive: true, force: true });
      progress('install', `Installing JDK into ${target}`);
      await moveDirectory(stagedHome, target);
    } finally {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }

    const installed = target && isJavaHome(target, platform) ? target : findManagedJdk({ ...opts, jdkRoot });
    if (!installed) {
      return { ok: false, error: 'JDK was extracted but no bin/java was found afterwards', jdkVersion: major };
    }
    const version =
      jdkVersionFromHome(installed) || versionFromAssetName(asset.name) || asset.version || null;
    const installedMajor = majorVersionOf(version);
    if (pinned && installedMajor !== null && installedMajor !== major) {
      return {
        ok: false,
        error:
          `installed JDK version mismatch: expected Temurin ${major}, found ${version} at ${installed}; ` +
          'remove it and retry, or omit options.jdkVersion to use the existing JDK',
        jdkVersion: major,
      };
    }
    const viaMirror = Boolean(origin && origin.viaMirror);
    progress('done', `JDK ${major} ready at ${installed}${viaMirror ? ' (via mirror)' : ''}`);
    return {
      ok: true,
      cached: false,
      javaHome: installed,
      version,
      url: origin ? origin.url : asset.link,
      viaMirror,
      bytes,
      sha256,
      source: asset.source,
      jdkVersion: major,
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
