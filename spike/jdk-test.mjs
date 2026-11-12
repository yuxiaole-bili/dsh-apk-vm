/**
 * spike/jdk-test.mjs — HERMETIC verification for lib/jdk.js (managed JDK 17).
 *
 * The default run is fully offline and fast: every network, download and
 * extraction step is injected, so nothing is fetched and no archive is unpacked
 * for real. A real-network end-to-end run against the Adoptium API and a real
 * ~190 MB Temurin JDK extraction is gated behind:
 *
 *   DSH_APK_VM_JDK_E2E=1 node spike/jdk-test.mjs
 *
 * Covers: jdkRoot/env precedence, Adoptium URL mapping, depth-bounded managed
 * JDK discovery (including ignored/unreadable directories), cached reuse,
 * fresh install with checksum verification, retry-friendly archive reuse,
 * checksum mismatch, download failure, invalid API payloads, unsupported
 * platform/architecture, the China-mirror fallback (`jdkMirror` option,
 * `DSH_APK_VM_JDK_MIRROR` env, primary→mirror retry semantics), the bundled
 * known-good table used when the Adoptium API is blocked, `jdkVersion`
 * pinning/mismatch handling, resumable partial downloads (the partial archive
 * is kept and the retry continues with `Range`), setup.js integration
 * (`javaHome`/`javaPresent` report fields, `jdkRoot`/`extraJavaHomes`
 * pass-through) and JSON-safe results.
 *
 *   cd apk-vm-preview
 *   node spike/jdk-test.mjs
 *
 * Exit code 0 = every check passed.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  KNOWN_GOOD_JDK_RELEASES,
  adoptiumAssetUrl,
  defaultJdkRoot,
  ensureJdk,
  findManagedJdk,
  knownGoodJdkAsset,
} from '../lib/jdk.js';
import { bootstrapSdk, detectEnvironment, setupReport } from '../lib/setup.js';

const PLATFORM = process.platform;
const IS_WIN = PLATFORM === 'win32';
const JAVA_BIN = IS_WIN ? 'java.exe' : 'java';
const ADOPTIUM_OS = { win32: 'windows', darwin: 'mac', linux: 'linux' };
const ADOPTIUM_ARCH = { x64: 'x64', arm64: 'aarch64', arm: 'aarch64' };
const OS_SEGMENT = ADOPTIUM_OS[PLATFORM];
const MIRROR_SEGMENT = `/17/jdk/x64/${OS_SEGMENT}`;

/** TUNA-style mirror URL for one fake asset (mirror tests always pin arch=x64). */
function mirrorUrl(base, assetName) {
  return `${String(base).replace(/\/+$/, '')}${MIRROR_SEGMENT}/${assetName}`;
}

/** Unhandled rejections would crash a real plugin host; fail the suite instead. */
const unhandled = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(reason);
});

let passed = 0;
const failures = [];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const liveTempRoots = [];

/** Create a throw-away directory; registered for cleanup even on hard exit. */
async function tempRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-jdk-test-'));
  liveTempRoots.push(root);
  return root;
}

process.on('exit', () => {
  for (const root of liveTempRoots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best effort on exit */
    }
  }
});

/** Write a fake JAVA_HOME (`<dir>/bin/java[.exe]`). */
async function writeJavaHome(dir) {
  await fsp.mkdir(path.join(dir, 'bin'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'bin', JAVA_BIN), '#!/bin/sh\nexit 0\n', 'utf8');
  return dir;
}

/** Minimal Adoptium API payload for one fake asset. */
function fakePayload(bytes, name, overrides = {}) {
  const checksum =
    overrides.checksum || createHash('sha256').update(bytes).digest('hex');
  return [
    {
      binary: {
        package: {
          link: overrides.link || `https://example.test/${name}`,
          checksum,
          name,
          size: bytes.length,
          ...(overrides.package || {}),
        },
      },
      release_name: 'jdk-17.0.9+9',
    },
  ];
}

function fakeResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertJsonSafe(value) {
  assert.deepEqual(jsonSafe(value), value, 'result must survive JSON.stringify/parse unchanged');
}

/**
 * Injected downloader: writes the deterministic fake archive bytes and records
 * the call, mirroring the injectable `download(url, dest, opts)` contract.
 */
function makeDownload(bytes, calls, options = {}) {
  return async (url, destination, opts = {}) => {
    calls.push({ url, destination, opts });
    if (options.failWith) return { ok: false, error: options.failWith };
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, bytes);
    return { ok: true, bytes: bytes.length };
  };
}

/**
 * Injected extractor: creates `<dest>/jdk-<version>/bin/java[.exe]` (the shape
 * of a real Temurin archive) and records the call.
 */
function makeExtract(version, calls) {
  return async (archive, destination, opts = {}) => {
    await fsp.mkdir(path.join(destination, `jdk-${version}`, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(destination, `jdk-${version}`, 'bin', JAVA_BIN), '', 'utf8');
    calls.push({ archive, destination, platform: opts.platform });
    return { ok: true };
  };
}

/**
 * Build an injectable `knownGoodReleases` table for the host OS with one x64
 * asset, so known-good fallback tests never touch the real bundled table.
 */
function fakeKnownGoodTable(assetName, bytes, overrides = {}) {
  return {
    17: {
      release: overrides.release || 'jdk-17.0.21+9',
      version: overrides.version || '17.0.21+9',
      assets: {
        [`${OS_SEGMENT}-x64`]: {
          name: assetName,
          size: bytes.length,
          sha256: overrides.sha256 || createHash('sha256').update(bytes).digest('hex'),
        },
      },
    },
  };
}

/** Simple test harness: one fresh temp root per case, always cleaned up. */
async function test(name, fn) {
  const root = await tempRoot();
  try {
    await fn(root);
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    const message = error && error.message ? error.message : String(error);
    console.log(`FAIL ${name}: ${message.split('\n')[0]}`);
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    const index = liveTempRoots.indexOf(root);
    if (index >= 0) liveTempRoots.splice(index, 1);
  }
}

/** Run `java -version` for the real-network E2E case. */
function runJavaVersion(javaHome) {
  const binary = path.join(javaHome, 'bin', IS_WIN ? 'java.exe' : 'java');
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(binary, ['-version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, error: error.message });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: 'java -version timed out' });
    }, 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish({ ok: false, error: error.message }));
    child.on('close', (code) =>
      finish({ ok: code === 0, code, output: `${stderr}${stdout}`.trim() }),
    );
  });
}

// ---------------------------------------------------------------------------
// Case 1: directory resolution (jdkRoot > env > home)
// ---------------------------------------------------------------------------

await test('defaultJdkRoot uses <home>/.dsh/apk-vm/jdk and honors jdkRoot/env overrides', async (root) => {
  const home = path.join(root, 'home');
  assert.equal(defaultJdkRoot({ home }), path.join(home, '.dsh', 'apk-vm', 'jdk'));

  const envDir = path.join(root, 'managed-from-env');
  assert.equal(
    defaultJdkRoot({ home, env: { DSH_APK_VM_JDK_DIR: envDir } }),
    path.resolve(envDir),
    'DSH_APK_VM_JDK_DIR must be honored when no explicit jdkRoot is given',
  );

  const explicit = path.join(root, 'managed-explicit');
  assert.equal(
    defaultJdkRoot({ jdkRoot: explicit, home, env: { DSH_APK_VM_JDK_DIR: envDir } }),
    path.resolve(explicit),
    'options.jdkRoot must win over the environment variable',
  );

  // An injected env map is authoritative: the process environment is not read.
  assert.equal(
    defaultJdkRoot({ home, env: { PATH: '' } }),
    path.join(home, '.dsh', 'apk-vm', 'jdk'),
    'an isolated env without DSH_APK_VM_JDK_DIR must fall back to the home dir',
  );
});

// ---------------------------------------------------------------------------
// Case 2: Adoptium URL mapping
// ---------------------------------------------------------------------------

await test('adoptiumAssetUrl maps every supported OS/arch pair onto the https latest-17 API', async () => {
  const pairs = [
    ['windows', 'x64', 'windows', 'x64'],
    ['mac', 'aarch64', 'mac', 'aarch64'],
    ['linux', 'x64', 'linux', 'x64'],
    ['linux', 'aarch64', 'linux', 'aarch64'],
  ];
  for (const [osName, archName, expectedOs, expectedArch] of pairs) {
    const url = adoptiumAssetUrl(osName, archName);
    assert.ok(url.startsWith('https://api.adoptium.net/v3/assets/latest/17/hotspot'), url);
    const params = new URL(url).searchParams;
    assert.equal(params.get('os'), expectedOs, `os mapping for ${osName}`);
    assert.equal(params.get('architecture'), expectedArch, `arch mapping for ${archName}`);
    assert.equal(params.get('image_type'), 'jdk');
    assert.equal(params.get('vendor'), 'eclipse');
  }
});

// ---------------------------------------------------------------------------
// Case 3: synchronous discovery
// ---------------------------------------------------------------------------

await test('findManagedJdk finds a root-level, depth-2 and depth-3 JAVA_HOME', async (root) => {
  // jdkRoot itself is a JAVA_HOME.
  const selfRoot = path.join(root, 'self');
  await writeJavaHome(selfRoot);
  assert.equal(findManagedJdk({ jdkRoot: selfRoot }), selfRoot);

  // Depth 1/2/3 descendants are scanned (BFS, so the shallowest one wins).
  const shallow = await writeJavaHome(path.join(root, 'shallow', 'jdk-17.0.9+9'));
  assert.equal(findManagedJdk({ jdkRoot: path.join(root, 'shallow') }), shallow);

  const deepRoot = path.join(root, 'deep');
  const deep = await writeJavaHome(path.join(deepRoot, 'a', 'b', 'jdk-17.0.9+9'));
  assert.equal(findManagedJdk({ jdkRoot: deepRoot }), path.resolve(deep));

  // Depth 4 is out of bounds for the bounded scan.
  const tooDeepRoot = path.join(root, 'too-deep');
  await writeJavaHome(path.join(tooDeepRoot, 'a', 'b', 'c', 'jdk-17.0.9+9'));
  assert.equal(findManagedJdk({ jdkRoot: tooDeepRoot }), null, 'depth 4 must not be scanned');
});

await test('findManagedJdk ignores non-JDK, unreadable and scratch directories', async (root) => {
  // bin/ without java, and a plain directory that is not a JAVA_HOME.
  const notJdk = path.join(root, 'not-a-jdk');
  await fsp.mkdir(path.join(notJdk, 'jdk-17.0.9+9', 'bin'), { recursive: true });
  await fsp.writeFile(path.join(notJdk, 'jdk-17.0.9+9', 'bin', 'javac'), '', 'utf8');
  assert.equal(findManagedJdk({ jdkRoot: notJdk }), null);

  // A downloaded archive staging area must never be reported as a JDK.
  const scratch = path.join(root, 'scratch');
  await writeJavaHome(path.join(scratch, 'downloads', 'jdk-17.0.9+9'));
  assert.equal(findManagedJdk({ jdkRoot: scratch }), null);

  // jdkRoot pointing at a plain file must not throw.
  const filePath = path.join(root, 'file-as-root');
  await fsp.writeFile(filePath, 'not a directory', 'utf8');
  assert.equal(findManagedJdk({ jdkRoot: filePath }), null);

  // Unreadable directories are skipped (POSIX permissions only).
  if (!IS_WIN) {
    const locked = path.join(root, 'locked');
    await writeJavaHome(path.join(locked, 'jdk-17.0.9+9'));
    await fsp.chmod(locked, 0o000);
    try {
      assert.equal(findManagedJdk({ jdkRoot: locked }), null);
    } finally {
      await fsp.chmod(locked, 0o755);
    }
  }
});

// ---------------------------------------------------------------------------
// Case 4: cached reuse
// ---------------------------------------------------------------------------

await test('ensureJdk returns an existing managed JDK without touching the network', async (root) => {
  const jdkRoot = path.join(root, 'managed');
  const javaHome = await writeJavaHome(path.join(jdkRoot, 'jdk-17.0.9+9'));
  const result = await ensureJdk({
    jdkRoot,
    platform: PLATFORM,
    fetchImpl: () => {
      throw new Error('ensureJdk must not fetch when a managed JDK already exists');
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.cached, true);
  assert.equal(result.javaHome, path.resolve(javaHome));
  assert.equal(result.version, '17.0.9+9');
  assert.equal(result.url, null);
  assert.equal(result.source, null, 'a cached JDK has no download source');
  assert.equal(result.jdkVersion, 17);
  assertJsonSafe(result);
});

// ---------------------------------------------------------------------------
// Case 5: fresh install with injected fetch/download/extract
// ---------------------------------------------------------------------------

await test('ensureJdk installs a fake Temurin archive and reuses it on the second call', async (root) => {
  const jdkRoot = path.join(root, 'managed');
  const archiveBytes = Buffer.from('deterministic fake Temurin archive payload', 'utf8');
  const assetName = 'OpenJDK17U-jdk_x64_windows_hotspot_17.0.9_9.zip';
  const payload = fakePayload(archiveBytes, assetName);
  const expectedSha = createHash('sha256').update(archiveBytes).digest('hex');

  const fetchCalls = [];
  const downloadCalls = [];
  const extractCalls = [];
  const progress = [];
  const logs = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(url);
    return fakeResponse(payload);
  };

  const result = await ensureJdk({
    jdkRoot,
    platform: PLATFORM,
    fetchImpl,
    download: makeDownload(archiveBytes, downloadCalls),
    extract: makeExtract('17.0.9+9', extractCalls),
    onProgress: (event) => progress.push(event),
    log: (line) => logs.push(line),
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.cached, false);
  assert.equal(result.javaHome, path.resolve(path.join(jdkRoot, 'jdk-17.0.9+9')));
  assert.equal(result.version, '17.0.9+9');
  assert.equal(result.url, payload[0].binary.package.link);
  assert.equal(result.bytes, archiveBytes.length);
  assert.equal(result.sha256, expectedSha, 'installed result must expose the verified SHA-256');
  assert.equal(result.source, 'api', 'an API-resolved install reports source api');
  assert.equal(result.jdkVersion, 17);
  assert.ok(existsSync(path.join(result.javaHome, 'bin', JAVA_BIN)), 'bin/java must exist after install');
  assertJsonSafe(result);

  // API + download + extract were called exactly once with the expected shapes.
  assert.equal(fetchCalls.length, 1);
  const expectedApiUrl = ADOPTIUM_OS[PLATFORM] && ADOPTIUM_ARCH[process.arch]
    ? adoptiumAssetUrl(ADOPTIUM_OS[PLATFORM], ADOPTIUM_ARCH[process.arch])
    : null;
  if (expectedApiUrl) assert.equal(fetchCalls[0], expectedApiUrl);
  assert.equal(downloadCalls.length, 1);
  assert.equal(downloadCalls[0].url, result.url);
  assert.equal(downloadCalls[0].destination, path.join(jdkRoot, 'downloads', assetName));
  assert.equal(downloadCalls[0].opts.resume, true, 'downloads must be resumable');
  assert.equal(downloadCalls[0].opts.expectedSize, archiveBytes.length);
  assert.equal(extractCalls.length, 1);
  assert.ok(progress.length > 0, 'onProgress must be called');
  assert.ok(progress.some((event) => event.step === 'done'), 'progress must reach the done step');
  assert.ok(logs.length > 0, 'log must be called');
  assert.ok(existsSync(downloadCalls[0].destination), 'the verified archive is kept for retries');

  // No staging directory may survive a successful install.
  const leftovers = (await fsp.readdir(jdkRoot)).filter((name) => name.startsWith('.staging-'));
  assert.deepEqual(leftovers, [], `staging directories left behind: ${leftovers.join(', ')}`);

  // Second call: must be served from disk, with no API request at all.
  const second = await ensureJdk({
    jdkRoot,
    platform: PLATFORM,
    fetchImpl: () => {
      throw new Error('second ensureJdk must not fetch');
    },
  });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.cached, true);
  assert.equal(second.javaHome, result.javaHome);
  assert.equal(fetchCalls.length, 1, 'cached call must not hit the API');
  assertJsonSafe(second);
});

await test('ensureJdk re-downloads nothing when the verified archive is already on disk', async (root) => {
  const jdkRoot = path.join(root, 'managed');
  const archiveBytes = Buffer.from('retry-friendly fake archive', 'utf8');
  const assetName = 'OpenJDK17U-jdk_x64_fake_17.0.9_9.zip';
  const payload = fakePayload(archiveBytes, assetName);

  const firstDownload = [];
  await ensureJdk({
    jdkRoot,
    platform: PLATFORM,
    fetchImpl: async () => fakeResponse(payload),
    download: makeDownload(archiveBytes, firstDownload),
    extract: makeExtract('17.0.9+9', []),
  });
  assert.equal(firstDownload.length, 1);

  // A later retry (e.g. extraction failed) reuses the verified archive: only
  // the API is consulted again, the ~190 MB download is skipped.
  const secondDownload = [];
  const second = await ensureJdk({
    jdkRoot,
    platform: PLATFORM,
    fetchImpl: async () => fakeResponse(payload),
    download: makeDownload(archiveBytes, secondDownload),
    extract: makeExtract('17.0.9+9', []),
  });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.cached, true, 'already-installed JDK is the cached fast path');
  assert.equal(secondDownload.length, 0, 'verified archive must be reused, not re-downloaded');
});

await test('ensureJdk reuses a verified archive when the installed JDK was removed', async (root) => {
  const jdkRoot = path.join(root, 'managed');
  const archiveBytes = Buffer.from('retry-after-install-removal', 'utf8');
  const assetName = 'OpenJDK17U-jdk_x64_fake_17.0.9_9.zip';
  const payload = fakePayload(archiveBytes, assetName);

  await ensureJdk({
    jdkRoot,
    platform: PLATFORM,
    fetchImpl: async () => fakeResponse(payload),
    download: makeDownload(archiveBytes, []),
    extract: makeExtract('17.0.9+9', []),
  });
  await fsp.rm(path.join(jdkRoot, 'jdk-17.0.9+9'), { recursive: true, force: true });

  const downloads = [];
  const result = await ensureJdk({
    jdkRoot,
    platform: PLATFORM,
    fetchImpl: async () => fakeResponse(payload),
    download: makeDownload(archiveBytes, downloads),
    extract: makeExtract('17.0.9+9', []),
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.cached, false);
  assert.equal(downloads.length, 0, 'checksum-verified archive must be reused from <jdkRoot>/downloads');
  assert.equal(result.sha256, createHash('sha256').update(archiveBytes).digest('hex'));
});

// ---------------------------------------------------------------------------
// Case 6: failures are returned, never thrown
// ---------------------------------------------------------------------------

await test('ensureJdk reports a download failure as ok:false without throwing', async (root) => {
  const jdkRoot = path.join(root, 'managed');
  const result = await ensureJdk({
    jdkRoot,
    platform: PLATFORM,
    fetchImpl: async () => fakeResponse(fakePayload(Buffer.from('x'), 'fake.zip')),
    download: makeDownload(Buffer.from('x'), [], { failWith: 'connection reset by peer' }),
    extract: makeExtract('17.0.9+9', []),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /connection reset by peer/);
  assertJsonSafe(result);
  const leftovers = (await fsp.readdir(jdkRoot)).filter((name) => name.startsWith('.staging-'));
  assert.deepEqual(leftovers, [], 'no staging dir after a download failure');
});

await test('ensureJdk reports a checksum mismatch as ok:false and deletes the archive', async (root) => {
  const jdkRoot = path.join(root, 'managed');
  const archiveBytes = Buffer.from('tampered archive bytes', 'utf8');
  const assetName = 'OpenJDK17U-jdk_x64_fake_17.0.9_9.zip';
  const payload = fakePayload(archiveBytes, assetName, {
    checksum: '0'.repeat(64),
  });
  const downloads = [];

  const result = await ensureJdk({
    jdkRoot,
    platform: PLATFORM,
    fetchImpl: async () => fakeResponse(payload),
    download: makeDownload(archiveBytes, downloads),
    extract: makeExtract('17.0.9+9', []),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /checksum mismatch/i);
  assert.ok(!existsSync(downloads[0].destination), 'a mismatching archive must be deleted');
  assert.ok(!existsSync(path.join(jdkRoot, 'jdk-17.0.9+9')), 'nothing may be installed');
  const leftovers = (await fsp.readdir(jdkRoot)).filter((name) => name.startsWith('.staging-'));
  assert.deepEqual(leftovers, []);
  assertJsonSafe(result);
});

// ---------------------------------------------------------------------------
// Case 6c: bundled known-good fallback when the Adoptium API is unreachable
// ---------------------------------------------------------------------------

const KNOWN_GOOD_ENTRY = KNOWN_GOOD_JDK_RELEASES[17];
const KNOWN_GOOD_KEY = `${OS_SEGMENT}-x64`;
const KNOWN_GOOD_PACKAGE = KNOWN_GOOD_ENTRY.assets[KNOWN_GOOD_KEY];
const KNOWN_GOOD_PRIMARY =
  'https://github.com/adoptium/temurin17-binaries/releases/download/' +
  `${encodeURIComponent(KNOWN_GOOD_ENTRY.release)}/${KNOWN_GOOD_PACKAGE.name}`;
const TUNA_BASE = 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium';

await test('the bundled known-good table matches the published Temurin 17.0.21+9 assets', async () => {
  assert.equal(KNOWN_GOOD_ENTRY.release, 'jdk-17.0.21+9');
  assert.equal(KNOWN_GOOD_ENTRY.version, '17.0.21+9');
  assert.deepEqual(Object.keys(KNOWN_GOOD_ENTRY.assets).sort(), [
    'linux-aarch64',
    'linux-x64',
    'mac-aarch64',
    'mac-x64',
    'windows-x64',
  ]);
  const windows = KNOWN_GOOD_ENTRY.assets['windows-x64'];
  assert.equal(windows.name, 'OpenJDK17U-jdk_x64_windows_hotspot_17.0.21_9.zip');
  assert.equal(windows.size, 191117380);
  assert.equal(windows.sha256, '98518ecf554465057ee5509462631deeee374bc368c12a411d225cd29381f84b');
  for (const [key, pkg] of Object.entries(KNOWN_GOOD_ENTRY.assets)) {
    assert.match(pkg.sha256, /^[0-9a-f]{64}$/, `${key}: sha256 must be lowercase hex`);
    assert.ok(pkg.size > 100 * 1024 * 1024, `${key}: expected a >100MB archive`);
  }

  const asset = knownGoodJdkAsset(17, 'windows', 'x64');
  assert.equal(asset.ok, true);
  assert.equal(asset.source, 'known-good');
  assert.equal(asset.name, windows.name);
  assert.equal(asset.size, windows.size);
  assert.equal(asset.checksum, windows.sha256);
  assert.equal(asset.version, '17.0.21+9');
  assert.equal(
    asset.link,
    `https://github.com/adoptium/temurin17-binaries/releases/download/` +
      `${encodeURIComponent('jdk-17.0.21+9')}/OpenJDK17U-jdk_x64_windows_hotspot_17.0.21_9.zip`,
  );

  const missingPlatform = knownGoodJdkAsset(17, 'windows', 'aarch64');
  assert.equal(missingPlatform.ok, false);
  assert.match(
    missingPlatform.error,
    /no known-good Eclipse Temurin 17 package is bundled for windows-aarch64/,
  );
  const missingRelease = knownGoodJdkAsset(21, 'linux', 'x64');
  assert.equal(missingRelease.ok, false);
  assert.match(missingRelease.error, /no known-good Eclipse Temurin 21 release/);
  const invalidEntry = knownGoodJdkAsset(17, 'linux', 'x64', {
    17: {
      release: 'jdk-17',
      assets: { 'linux-x64': { name: 'x.zip', size: 0, sha256: 'nope' } },
    },
  });
  assert.equal(invalidEntry.ok, false);
  assert.match(invalidEntry.error, /invalid/);
});

await test('ensureJdk falls back to the known-good table when the Adoptium API fails', async (root) => {
  const cases = [
    ['empty payload', async () => fakeResponse([])],
    ['missing binary.package', async () => fakeResponse([{ binary: {} }])],
    [
      'non-https link',
      async () =>
        fakeResponse(
          fakePayload(Buffer.from('x'), 'fake.zip', { link: 'http://insecure.test/fake.zip' }),
        ),
    ],
    [
      'fetch throws',
      async () => {
        throw new Error('getaddrinfo ENOTFOUND api.adoptium.net');
      },
    ],
  ];
  for (const [label, fetchImpl] of cases) {
    const requested = [];
    const result = await ensureJdk({
      jdkRoot: path.join(root, `managed-${label.replace(/\W+/g, '-')}`),
      platform: PLATFORM,
      arch: 'x64',
      fetchImpl,
      download: async (url) => {
        requested.push(url);
        return { ok: false, error: 'known-good source unreachable' };
      },
    });
    assert.equal(result.ok, false, `${label}: expected ok:false`);
    assert.match(result.error, /Adoptium API/i, `${label}: API error must be surfaced: ${result.error}`);
    assert.match(result.error, /JDK download failed from all 2 source\(s\)/);
    assert.match(result.error, /known-good source unreachable/);
    assert.match(result.error, /jdkMirror/);
    assert.equal(result.jdkVersion, 17);
    assert.equal(requested.length, 2);
    assert.equal(requested[0], KNOWN_GOOD_PRIMARY, `${label}: primary known-good URL`);
    assert.equal(
      requested[1],
      mirrorUrl(TUNA_BASE, KNOWN_GOOD_PACKAGE.name),
      `${label}: default TUNA mirror URL`,
    );
    assertJsonSafe(result);
  }
});

await test('ensureJdk installs the known-good asset from a mirror when the API and GitHub are blocked', async (root) => {
  const bytes = Buffer.from('known-good temurin archive bytes', 'utf8');
  const assetName = 'OpenJDK17U-jdk_x64_known_good_17.0.21_9.zip';
  const table = fakeKnownGoodTable(assetName, bytes);
  const expectedPrimary =
    'https://github.com/adoptium/temurin17-binaries/releases/download/' +
    `${encodeURIComponent('jdk-17.0.21+9')}/${assetName}`;
  const base = 'https://mirror.example.test/Adoptium';
  const expectedMirror = mirrorUrl(base, assetName);
  const requested = [];
  const progress = [];

  const result = await ensureJdk({
    jdkRoot: path.join(root, 'managed'),
    platform: PLATFORM,
    arch: 'x64',
    jdkMirror: base,
    fetchImpl: async () => {
      throw new Error('api.adoptium.net blocked');
    },
    knownGoodReleases: table,
    download: async (url, destination, opts = {}) => {
      requested.push(url);
      if (url === expectedPrimary) return { ok: false, error: 'github.com blocked' };
      assert.equal(url, expectedMirror);
      return makeDownload(bytes, [])(url, destination, opts);
    },
    extract: makeExtract('17.0.21+9', []),
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.source, 'known-good');
  assert.equal(result.cached, false);
  assert.equal(result.jdkVersion, 17);
  assert.equal(result.url, expectedMirror);
  assert.equal(result.viaMirror, true);
  assert.deepEqual(requested, [expectedPrimary, expectedMirror]);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(existsSync(path.join(result.javaHome, 'bin', JAVA_BIN)));
  assert.ok(
    progress.some((event) => /known-good/i.test(event.message || '')),
    'progress must name the known-good fallback',
  );
  assertJsonSafe(result);
});

await test('ensureJdk probes non-final sources and skips a blackholed primary quickly', async (root) => {
  const bytes = Buffer.from('probe test archive bytes', 'utf8');
  const assetName = 'OpenJDK17U-jdk_x64_probe_17.0.21_9.zip';
  const primary =
    'https://github.com/adoptium/temurin17-binaries/releases/download/' +
    `${encodeURIComponent('jdk-17.0.21+9')}/${assetName}`;
  const base = 'https://mirror.example.test/Adoptium';
  const expectedMirror = mirrorUrl(base, assetName);
  const payload = fakePayload(bytes, assetName, { link: primary });
  const probes = [];
  const downloads = [];

  const result = await ensureJdk({
    jdkRoot: path.join(root, 'managed'),
    platform: PLATFORM,
    arch: 'x64',
    jdkMirror: base,
    fetchImpl: async () => fakeResponse(payload),
    probe: async (url, opts = {}) => {
      probes.push({ url, timeoutMs: opts.timeoutMs });
      if (url === primary) return { ok: false, error: 'no response within 8000 ms' };
      return { ok: true, status: 200 };
    },
    probeTimeoutMs: 1234,
    download: makeDownload(bytes, downloads),
    extract: makeExtract('17.0.21+9', []),
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.viaMirror, true);
  assert.equal(result.url, expectedMirror);
  assert.deepEqual(
    downloads.map((call) => call.url),
    [expectedMirror],
    'a blackholed primary must be skipped without starting its download',
  );
  assert.equal(probes.length, 1, 'only non-final sources are probed');
  assert.equal(probes[0].url, primary);
  assert.equal(probes[0].timeoutMs, 1234, 'probeTimeoutMs must reach the probe');
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(existsSync(path.join(result.javaHome, 'bin', JAVA_BIN)));
  assertJsonSafe(result);
});

await test('ensureJdk caps non-final source timeouts and keeps the full budget for the last source', async (root) => {
  const bytes = Buffer.from('timeout cap archive bytes', 'utf8');
  const assetName = 'OpenJDK17U-jdk_x64_cap_17.0.21_9.zip';
  const primary =
    'https://github.com/adoptium/temurin17-binaries/releases/download/' +
    `${encodeURIComponent('jdk-17.0.21+9')}/${assetName}`;
  const base = 'https://mirror.example.test/Adoptium';
  const expectedMirror = mirrorUrl(base, assetName);
  const payload = fakePayload(bytes, assetName, { link: primary });
  const downloads = [];

  const result = await ensureJdk({
    jdkRoot: path.join(root, 'managed'),
    platform: PLATFORM,
    arch: 'x64',
    jdkMirror: base,
    fetchImpl: async () => fakeResponse(payload),
    probe: async () => ({ ok: true, status: 200 }),
    timeoutMs: 9000,
    candidateTimeoutMs: 4000,
    download: async (url, destination, opts = {}) => {
      downloads.push({ url, timeoutMs: opts.timeoutMs });
      if (url === primary) return { ok: false, error: 'primary hung after the capped budget' };
      return makeDownload(bytes, [])(url, destination, opts);
    },
    extract: makeExtract('17.0.21+9', []),
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.url, expectedMirror);
  assert.deepEqual(
    downloads.map((call) => call.url),
    [primary, expectedMirror],
  );
  assert.equal(downloads[0].timeoutMs, 4000, 'non-final sources use the candidate cap');
  assert.equal(downloads[1].timeoutMs, 9000, 'the final source keeps the full download budget');
  assertJsonSafe(result);
});

await test('ensureJdk times out a hanging Adoptium API lookup and falls back to the known-good table', async (root) => {
  const bytes = Buffer.from('api timeout archive bytes', 'utf8');
  const assetName = 'OpenJDK17U-jdk_x64_apitimeout_17.0.21_9.zip';
  const table = fakeKnownGoodTable(assetName, bytes);
  const base = 'https://mirror.example.test/Adoptium';
  const downloads = [];
  const progress = [];
  const fetchCalls = [];

  const result = await ensureJdk({
    jdkRoot: path.join(root, 'managed'),
    platform: PLATFORM,
    arch: 'x64',
    jdkMirror: base,
    apiTimeoutMs: 100,
    fetchImpl: (url, init = {}) => {
      fetchCalls.push(url);
      return new Promise((resolve, reject) => {
        if (init.signal) {
          init.signal.addEventListener('abort', () => reject(new Error('aborted by test timer')));
        }
      });
    },
    knownGoodReleases: table,
    download: makeDownload(bytes, downloads),
    extract: makeExtract('17.0.21+9', []),
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.source, 'known-good');
  assert.equal(result.jdkVersion, 17);
  assert.equal(fetchCalls.length, 1);
  assert.ok(
    progress.some((event) => /Adoptium API unavailable/i.test(event.message || '')),
    'the API timeout must be reported as the known-good fallback reason',
  );
  assert.ok(
    progress.some((event) => /known-good/i.test(event.message || '')),
    'progress must name the known-good fallback',
  );
  assert.ok(existsSync(path.join(result.javaHome, 'bin', JAVA_BIN)));
  assertJsonSafe(result);
});

await test('ensureJdk verifies the known-good sha256 and deletes a tampered archive', async (root) => {
  const bytes = Buffer.from('known-good temurin archive bytes', 'utf8');
  const assetName = 'OpenJDK17U-jdk_x64_known_good_17.0.21_9.zip';
  const table = fakeKnownGoodTable(assetName, bytes);
  const jdkRoot = path.join(root, 'managed');
  const tampered = Buffer.from(bytes);
  tampered[0] ^= 0xff;
  const base = 'https://mirror.example.test/Adoptium';

  const result = await ensureJdk({
    jdkRoot,
    platform: PLATFORM,
    arch: 'x64',
    jdkMirror: base,
    fetchImpl: async () => {
      throw new Error('api.adoptium.net blocked');
    },
    knownGoodReleases: table,
    // Both the GitHub link and the mirror deliver tampered bytes.
    download: makeDownload(tampered, []),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /checksum mismatch/i);
  assert.match(result.error, /JDK download failed from all 2 source/);
  assert.equal(result.jdkVersion, 17);
  assert.ok(!existsSync(path.join(jdkRoot, 'downloads', assetName)), 'a tampered archive must be deleted');
  assert.ok(!existsSync(path.join(jdkRoot, 'jdk-17')), 'nothing may be installed');
  assertJsonSafe(result);
});

await test('ensureJdk reports the API error and the missing known-good package when nothing resolves', async (root) => {
  const result = await ensureJdk({
    jdkRoot: path.join(root, 'managed'),
    platform: PLATFORM,
    arch: 'x64',
    fetchImpl: async () => {
      throw new Error('api.adoptium.net blocked');
    },
    knownGoodReleases: { 17: { release: 'jdk-17.0.21+9', version: '17.0.21+9', assets: {} } },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Adoptium API request failed/);
  assert.match(result.error, /no known-good Eclipse Temurin 17 package is bundled for/);
  assert.match(result.error, /Temurin mirror/);
  assertJsonSafe(result);
});

// ---------------------------------------------------------------------------
// Case 6d: jdkVersion pinning
// ---------------------------------------------------------------------------

await test('ensureJdk can pin a different Temurin major version (jdkVersion)', async (root) => {
  const jdkRoot = path.join(root, 'managed');
  const bytes = Buffer.from('temurin 21 archive bytes', 'utf8');
  const assetName = 'OpenJDK21U-jdk_x64_fake_21.0.1_12.zip';
  const payload = fakePayload(bytes, assetName);
  const fetchCalls = [];
  const result = await ensureJdk({
    jdkRoot,
    platform: PLATFORM,
    arch: 'x64',
    jdkVersion: 21,
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      return fakeResponse(payload);
    },
    download: makeDownload(bytes, []),
    extract: makeExtract('21.0.1+12', []),
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.jdkVersion, 21);
  assert.equal(result.source, 'api');
  assert.equal(result.version, '21.0.1+12');
  assert.equal(fetchCalls[0], adoptiumAssetUrl(ADOPTIUM_OS[PLATFORM], 'x64', 21));
  assert.equal(result.javaHome, path.resolve(path.join(jdkRoot, 'jdk-21.0.1+12')));
  assertJsonSafe(result);
});

await test('ensureJdk replaces a cached JDK that does not match the pinned jdkVersion', async (root) => {
  const jdkRoot = path.join(root, 'managed');
  await writeJavaHome(path.join(jdkRoot, 'jdk-17.0.9+9'));
  const bytes = Buffer.from('pinned 21 archive bytes', 'utf8');
  const payload = fakePayload(bytes, 'OpenJDK21U-jdk_x64_fake_21.0.1_12.zip');
  const fetchCalls = [];
  const logs = [];

  const result = await ensureJdk({
    jdkRoot,
    platform: PLATFORM,
    arch: 'x64',
    jdkVersion: 21,
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      return fakeResponse(payload);
    },
    download: makeDownload(bytes, []),
    extract: makeExtract('21.0.1+12', []),
    log: (line) => logs.push(line),
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.cached, false, 'a mismatched cached JDK must be bypassed');
  assert.equal(result.jdkVersion, 21);
  assert.equal(result.version, '21.0.1+12');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0], adoptiumAssetUrl(ADOPTIUM_OS[PLATFORM], 'x64', 21));
  assert.ok(logs.some((line) => /pinned Temurin 21/.test(line)), `missing pin notice in logs: ${logs.join(' | ')}`);

  const matching = await ensureJdk({
    jdkRoot,
    platform: PLATFORM,
    jdkVersion: 21,
    fetchImpl: () => {
      throw new Error('must not fetch once the pinned JDK is installed');
    },
  });
  assert.equal(matching.ok, true, matching.error);
  assert.equal(matching.cached, true);
  assert.equal(matching.jdkVersion, 21);
});

await test('ensureJdk rejects invalid jdkVersion values', async (root) => {
  for (const value of ['abc', 7, 100, 1.5]) {
    const result = await ensureJdk({
      jdkRoot: path.join(root, 'managed'),
      platform: PLATFORM,
      jdkVersion: value,
    });
    assert.equal(result.ok, false, `jdkVersion=${JSON.stringify(value)} must be rejected`);
    assert.match(result.error, /jdkVersion must be an integer between 8 and 99/);
    assertJsonSafe(result);
  }
});

await test('ensureJdk verifies the installed major version against a pinned jdkVersion', async (root) => {
  const bytes = Buffer.from('wrong-major archive bytes', 'utf8');
  const payload = fakePayload(bytes, 'OpenJDK17U-jdk_x64_fake_17.0.9_9.zip');
  const result = await ensureJdk({
    jdkRoot: path.join(root, 'managed'),
    platform: PLATFORM,
    arch: 'x64',
    jdkVersion: 21,
    fetchImpl: async () => fakeResponse(payload),
    download: makeDownload(bytes, []),
    extract: makeExtract('17.0.9+9', []),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /installed JDK version mismatch: expected Temurin 21, found 17\.0\.9\+9/);
  assert.equal(result.jdkVersion, 21);
  assertJsonSafe(result);
});

// ---------------------------------------------------------------------------
// Case 6e: resumable partial downloads
// ---------------------------------------------------------------------------

await test('ensureJdk keeps a partial download and resumes it on retry', async (root) => {
  const jdkRoot = path.join(root, 'managed');
  const bytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz-partial-resume-payload-1234567890', 'utf8');
  const assetName = 'OpenJDK17U-jdk_x64_partial_17.0.9_9.zip';
  const payload = fakePayload(bytes, assetName);
  const archivePath = path.join(jdkRoot, 'downloads', assetName);
  const progress = [];

  const first = await ensureJdk({
    jdkRoot,
    platform: PLATFORM,
    arch: 'x64',
    jdkMirror: [],
    fetchImpl: async () => fakeResponse(payload),
    download: async (url, destination, opts = {}) => {
      assert.equal(opts.resume, true, 'the downloader must be told to resume');
      assert.equal(opts.expectedSize, bytes.length);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.writeFile(destination, bytes.subarray(0, 20));
      return { ok: false, error: 'connection reset by peer' };
    },
    onProgress: (event) => progress.push(event),
  });
  assert.equal(first.ok, false);
  assert.match(first.error, /connection reset by peer/);
  assert.match(first.error, /retrying is safe and resumes the download/);
  assert.match(first.error, /partial archive was kept/);
  assert.ok(existsSync(archivePath), 'the partial archive must be kept for the retry');
  assert.equal((await fsp.stat(archivePath)).size, 20);

  const second = await ensureJdk({
    jdkRoot,
    platform: PLATFORM,
    arch: 'x64',
    jdkMirror: [],
    fetchImpl: async () => fakeResponse(payload),
    download: async (url, destination, opts = {}) => {
      assert.equal(opts.resume, true);
      assert.equal(opts.expectedSize, bytes.length);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.writeFile(destination, bytes);
      return { ok: true, bytes: bytes.length };
    },
    extract: makeExtract('17.0.9+9', []),
    onProgress: (event) => progress.push(event),
  });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.cached, false);
  assert.equal((await fsp.stat(archivePath)).size, bytes.length);
  assert.equal(second.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(
    progress.some((event) => /resuming at 20 bytes/.test(event.message || '')),
    'progress must report the resume offset',
  );
  assertJsonSafe(second);
});

await test('ensureJdk rejects unsupported platforms and architectures instead of guessing', async (root) => {
  const unsupportedPlatform = await ensureJdk({ jdkRoot: path.join(root, 'managed'), platform: 'solaris' });
  assert.equal(unsupportedPlatform.ok, false);
  assert.match(unsupportedPlatform.error, /unsupported platform/i);

  const unsupportedArch = await ensureJdk({
    jdkRoot: path.join(root, 'managed'),
    platform: 'linux',
    arch: 'riscv64',
    fetchImpl: async () => fakeResponse([]),
  });
  assert.equal(unsupportedArch.ok, false);
  assert.match(unsupportedArch.error, /unsupported architecture/i);
});

// ---------------------------------------------------------------------------
// Case 6b: China-mirror fallback (github.com package links are often blocked)
// ---------------------------------------------------------------------------

const MIRROR_ASSET = 'OpenJDK17U-jdk_x64_fake_17.0.9_9.zip';

await test('ensureJdk falls back to a mirror when the primary Adoptium link is blocked', async (root) => {
  const bytes = Buffer.from('mirror-delivered temurin archive bytes', 'utf8');
  const payload = fakePayload(bytes, MIRROR_ASSET);
  const primaryUrl = payload[0].binary.package.link;
  const base = 'https://mirror.example.test/Adoptium';
  const expectedMirror = mirrorUrl(base, MIRROR_ASSET);
  const requested = [];

  const result = await ensureJdk({
    jdkRoot: path.join(root, 'managed'),
    platform: PLATFORM,
    arch: 'x64',
    jdkMirror: base,
    fetchImpl: async () => fakeResponse(payload),
    download: async (url, destination, opts = {}) => {
      requested.push(url);
      if (url === primaryUrl) return { ok: false, error: 'fetch failed (github.com blocked)' };
      assert.equal(url, expectedMirror);
      return makeDownload(bytes, [])(url, destination, opts);
    },
    extract: makeExtract('17.0.9+9', []),
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.cached, false);
  assert.equal(result.url, expectedMirror, 'the successful mirror URL must be reported');
  assert.equal(result.viaMirror, true);
  assert.deepEqual(requested, [primaryUrl, expectedMirror]);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.ok(existsSync(path.join(result.javaHome, 'bin', JAVA_BIN)));
  assertJsonSafe(result);
});

await test('ensureJdk defaults to the TUNA mirror and reports every failed source', async (root) => {
  const payload = fakePayload(Buffer.from('x'), MIRROR_ASSET);
  const requested = [];

  const result = await ensureJdk({
    jdkRoot: path.join(root, 'managed'),
    platform: PLATFORM,
    arch: 'x64',
    fetchImpl: async () => fakeResponse(payload),
    download: async (url) => {
      requested.push(url);
      return { ok: false, error: 'network unreachable' };
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /JDK download failed from all 2 source\(s\)/);
  assert.match(result.error, /network unreachable/);
  assert.match(result.error, /jdkMirror/);
  assert.match(result.error, /DSH_APK_VM_JDK_MIRROR/);
  assert.equal(requested[0], payload[0].binary.package.link);
  assert.equal(
    requested[1],
    mirrorUrl('https://mirrors.tuna.tsinghua.edu.cn/Adoptium', MIRROR_ASSET),
    'the default mirror must be the TUNA Adoptium mirror',
  );
  assertJsonSafe(result);
});

await test('ensureJdk skips a mirror with a bad checksum and installs from the next mirror', async (root) => {
  const bytes = Buffer.from('good temurin archive bytes', 'utf8');
  const tampered = Buffer.from(bytes);
  tampered[0] ^= 0xff; // same length, different SHA-256
  const payload = fakePayload(bytes, MIRROR_ASSET);
  const primaryUrl = payload[0].binary.package.link;
  const badBase = 'https://bad-mirror.example.test/Adoptium';
  const goodBase = 'https://good-mirror.example.test/Adoptium';
  const requested = [];

  const result = await ensureJdk({
    jdkRoot: path.join(root, 'managed'),
    platform: PLATFORM,
    arch: 'x64',
    jdkMirror: [badBase, goodBase],
    fetchImpl: async () => fakeResponse(payload),
    download: async (url, destination, opts = {}) => {
      requested.push(url);
      const delivered = url === mirrorUrl(goodBase, MIRROR_ASSET) ? bytes : tampered;
      return makeDownload(delivered, [])(url, destination, opts);
    },
    extract: makeExtract('17.0.9+9', []),
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.url, mirrorUrl(goodBase, MIRROR_ASSET));
  assert.equal(result.viaMirror, true);
  assert.deepEqual(requested, [
    primaryUrl,
    mirrorUrl(badBase, MIRROR_ASSET),
    mirrorUrl(goodBase, MIRROR_ASSET),
  ]);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
});

await test('ensureJdk treats a truncated download as a failure and retries the next source', async (root) => {
  const bytes = Buffer.from('complete temurin archive bytes', 'utf8');
  const payload = fakePayload(bytes, MIRROR_ASSET);
  const primaryUrl = payload[0].binary.package.link;
  const base = 'https://size-check.example.test/Adoptium';
  const requested = [];

  const result = await ensureJdk({
    jdkRoot: path.join(root, 'managed'),
    platform: PLATFORM,
    arch: 'x64',
    jdkMirror: base,
    fetchImpl: async () => fakeResponse(payload),
    download: async (url, destination, opts = {}) => {
      requested.push(url);
      const delivered = url === primaryUrl ? bytes.subarray(0, bytes.length - 5) : bytes;
      return makeDownload(delivered, [])(url, destination, opts);
    },
    extract: makeExtract('17.0.9+9', []),
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.url, mirrorUrl(base, MIRROR_ASSET), 'the truncated primary must fall through');
  assert.equal(result.viaMirror, true);
  assert.deepEqual(requested, [primaryUrl, mirrorUrl(base, MIRROR_ASSET)]);
});

await test('jdkMirror accepts an array and overrides DSH_APK_VM_JDK_MIRROR', async (root) => {
  const bytes = Buffer.from('override temurin archive bytes', 'utf8');
  const payload = fakePayload(bytes, MIRROR_ASSET);
  const primaryUrl = payload[0].binary.package.link;
  const badBase = 'https://array-first.example.test/Adoptium';
  const goodBase = 'https://array-second.example.test/Adoptium';
  const envBase = 'https://env-should-lose.example.test/Adoptium';
  const requested = [];

  const result = await ensureJdk({
    jdkRoot: path.join(root, 'managed'),
    platform: PLATFORM,
    arch: 'x64',
    env: { DSH_APK_VM_JDK_MIRROR: envBase },
    jdkMirror: [badBase, goodBase],
    fetchImpl: async () => fakeResponse(payload),
    download: async (url, destination, opts = {}) => {
      requested.push(url);
      if (url === primaryUrl || url === mirrorUrl(badBase, MIRROR_ASSET)) {
        return { ok: false, error: 'blocked' };
      }
      return makeDownload(bytes, [])(url, destination, opts);
    },
    extract: makeExtract('17.0.9+9', []),
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.url, mirrorUrl(goodBase, MIRROR_ASSET));
  assert.equal(result.viaMirror, true);
  assert.deepEqual(requested, [primaryUrl, mirrorUrl(badBase, MIRROR_ASSET), mirrorUrl(goodBase, MIRROR_ASSET)]);
  assert.ok(!requested.includes(mirrorUrl(envBase, MIRROR_ASSET)), 'the option wins over the env var');
});

await test('DSH_APK_VM_JDK_MIRROR supplies comma/space separated mirrors from options.env', async (root) => {
  const bytes = Buffer.from('env-mirror temurin archive bytes', 'utf8');
  const payload = fakePayload(bytes, MIRROR_ASSET);
  const primaryUrl = payload[0].binary.package.link;
  const firstBase = 'https://env-first.example.test/Adoptium';
  const secondBase = 'https://env-second.example.test/Adoptium';
  const requested = [];

  const result = await ensureJdk({
    jdkRoot: path.join(root, 'managed'),
    platform: PLATFORM,
    arch: 'x64',
    env: { DSH_APK_VM_JDK_MIRROR: `${firstBase}, ${secondBase}` },
    fetchImpl: async () => fakeResponse(payload),
    download: async (url, destination, opts = {}) => {
      requested.push(url);
      if (url === primaryUrl || url === mirrorUrl(firstBase, MIRROR_ASSET)) {
        return { ok: false, error: 'blocked' };
      }
      return makeDownload(bytes, [])(url, destination, opts);
    },
    extract: makeExtract('17.0.9+9', []),
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.url, mirrorUrl(secondBase, MIRROR_ASSET));
  assert.equal(result.viaMirror, true);
  assert.deepEqual(requested, [
    primaryUrl,
    mirrorUrl(firstBase, MIRROR_ASSET),
    mirrorUrl(secondBase, MIRROR_ASSET),
  ]);
});

await test('an empty jdkMirror disables mirrors and invalid mirror URLs are rejected', async (root) => {
  const payload = fakePayload(Buffer.from('x'), MIRROR_ASSET);
  for (const [index, jdkMirror] of [[], ''].entries()) {
    const requested = [];
    const result = await ensureJdk({
      jdkRoot: path.join(root, `managed-empty-${index}`),
      platform: PLATFORM,
      arch: 'x64',
      jdkMirror,
      fetchImpl: async () => fakeResponse(payload),
      download: async (url) => {
        requested.push(url);
        return { ok: false, error: 'blocked' };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(requested.length, 1, 'mirrors disabled: only the primary URL may be attempted');
    assert.match(result.error, /all 1 source\(s\)/);
  }

  const envRequested = [];
  const envDisabled = await ensureJdk({
    jdkRoot: path.join(root, 'managed-env-empty'),
    platform: PLATFORM,
    arch: 'x64',
    env: { DSH_APK_VM_JDK_MIRROR: '' },
    fetchImpl: async () => fakeResponse(payload),
    download: async (url) => {
      envRequested.push(url);
      return { ok: false, error: 'blocked' };
    },
  });
  assert.equal(envDisabled.ok, false);
  assert.equal(envRequested.length, 1, 'an empty env var disables mirrors too');

  const invalid = await ensureJdk({
    jdkRoot: path.join(root, 'managed-invalid'),
    platform: PLATFORM,
    arch: 'x64',
    jdkMirror: 'http://insecure.example.test/Adoptium',
    fetchImpl: async () => {
      throw new Error('the API must not be resolved for an invalid mirror configuration');
    },
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /invalid JDK mirror URL/i);
  assertJsonSafe(invalid);
});

// ---------------------------------------------------------------------------
// Case 7: setup.js integration (managed JDK report fields + option pass-through)
// ---------------------------------------------------------------------------

await test('detectEnvironment reports javaHome/javaPresent and prefers extraJavaHomes', async (root) => {
  const sdkRoot = path.join(root, 'sdk');
  await fsp.mkdir(sdkRoot, { recursive: true });
  const avdHome = path.join(root, 'avd');
  await fsp.mkdir(avdHome, { recursive: true });

  const jdkRoot = path.join(root, 'managed');
  const managed = await writeJavaHome(path.join(jdkRoot, 'jdk-17.0.9+9'));
  const noExec = async () => ({ code: 0, stdout: '', stderr: '' });
  // An explicit env isolates discovery from the host (no host PATH/JAVA_HOME),
  // which keeps this integration check hermetic on any developer machine.
  const isolatedEnv = { PATH: '', HOME: root, USERPROFILE: root };

  const report = await detectEnvironment({
    sdkRoot,
    avdHome,
    jdkRoot,
    env: isolatedEnv,
    platform: PLATFORM,
    exec: noExec,
  });
  assert.equal(report.javaHome, path.resolve(managed));
  assert.equal(report.javaPresent, true);
  assertJsonSafe(report);

  // A discovered JDK must be injected as JAVA_HOME for the Java-based tools.
  const extra = await writeJavaHome(path.join(root, 'explicit-jdk'));
  const overridden = await detectEnvironment({
    sdkRoot,
    avdHome,
    jdkRoot,
    extraJavaHomes: [extra],
    env: isolatedEnv,
    platform: PLATFORM,
    exec: noExec,
  });
  assert.equal(overridden.javaHome, path.resolve(extra), 'extraJavaHomes must have highest priority');

  const reportText = await setupReport({
    sdkRoot,
    avdHome,
    jdkRoot,
    env: isolatedEnv,
    platform: PLATFORM,
    exec: noExec,
  });
  assert.match(reportText, /(?:^|\n)Java: /, 'setupReport must print the discovered JDK');
  assert.ok(reportText.includes(path.resolve(managed)), 'setupReport must name the managed JAVA_HOME');

  // Programmer errors still throw TypeError (consistent with the module contract).
  await assert.rejects(
    detectEnvironment({ sdkRoot, avdHome, extraJavaHomes: 'not-an-array', platform: PLATFORM }),
    TypeError,
  );
});

// ---------------------------------------------------------------------------
// Case 7b: bootstrapping the SDK from zero needs ONLY the managed JDK
// ---------------------------------------------------------------------------

await test('bootstrapSdk provisions the SDK from zero using only the managed JDK', async (root) => {
  const SDKMANAGER = IS_WIN ? 'sdkmanager.bat' : 'sdkmanager';
  const isolatedEnv = { PATH: '', HOME: root, USERPROFILE: root };
  const jdkRoot = path.join(root, 'managed');
  await writeJavaHome(path.join(jdkRoot, 'jdk-17.0.9+9'));

  let archivePath = null;
  const download = async (url, destination) => {
    archivePath = destination;
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, 'fake command-line tools archive', 'utf8');
    return { ok: true, bytes: 32 };
  };
  const extract = async (archive, destination) => {
    const bin = path.join(destination, 'cmdline-tools', 'bin');
    await fsp.mkdir(bin, { recursive: true });
    await fsp.writeFile(path.join(bin, SDKMANAGER), '', 'utf8');
    return { ok: true };
  };

  // (a) With no JDK anywhere the bootstrap must still refuse with guidance.
  const bare = await bootstrapSdk({
    sdkRoot: path.join(root, 'sdk-bare'),
    env: isolatedEnv,
    platform: PLATFORM,
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    download,
    extract,
  });
  assert.equal(bare.ok, false);
  assert.match(bare.error, /Java \(JDK 17\+\) is required/);

  // (b) With only the plugin-managed JDK present (no JAVA_HOME, no host paths)
  // sdkmanager must be bootstrapped and invoked.
  const sdkRoot = path.join(root, 'sdk');
  const calls = [];
  const result = await bootstrapSdk({
    sdkRoot,
    jdkRoot,
    env: isolatedEnv,
    platform: PLATFORM,
    packages: ['platform-tools'],
    exec: async (file, args, opts) => {
      calls.push({ file, args, opts });
      return { code: 0, stdout: '', stderr: '' };
    },
    download,
    extract,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.licenses, true);
  assert.ok(calls.length >= 2, `expected --licenses and --install calls, got ${calls.length}`);
  assert.ok(archivePath && !existsSync(archivePath), 'the downloaded archive is cleaned up');
  const sdkmanager = path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin', SDKMANAGER);
  assert.ok(existsSync(sdkmanager), 'sdkmanager must be installed under cmdline-tools/latest');
  assert.equal(path.resolve(calls[0].file), path.resolve(sdkmanager));
  assert.deepEqual(calls[0].args.slice(0, 2), [`--sdk_root=${sdkRoot}`, '--licenses']);
  assert.ok(calls[1].args.includes('platform-tools'));
  assertJsonSafe(result);
});

// ---------------------------------------------------------------------------
// Case 8: JSON safety of every result shape
// ---------------------------------------------------------------------------

await test('success and failure results are JSON-safe', async (root) => {
  const jdkRoot = path.join(root, 'managed');
  await writeJavaHome(path.join(jdkRoot, 'jdk-17.0.9+9'));

  const cached = await ensureJdk({ jdkRoot, platform: PLATFORM, fetchImpl: () => {} });
  assertJsonSafe(cached);

  const bytes = Buffer.from('json-safe archive', 'utf8');
  const payload = fakePayload(bytes, 'fake.zip');
  const installed = await ensureJdk({
    jdkRoot: path.join(root, 'managed-2'),
    platform: PLATFORM,
    fetchImpl: async () => fakeResponse(payload),
    download: makeDownload(bytes, []),
    extract: makeExtract('17.0.9+9', []),
  });
  assertJsonSafe(installed);

  const failed = await ensureJdk({
    jdkRoot: path.join(root, 'managed-3'),
    platform: PLATFORM,
    fetchImpl: async () => fakeResponse([]),
    // The API failure now falls back to the known-good table; keep the
    // downloader offline so this case never touches the network.
    download: async () => ({ ok: false, error: 'offline test: no network' }),
  });
  assertJsonSafe(failed);
});

// ---------------------------------------------------------------------------
// Optional real-network end-to-end run (never part of the default suite)
// ---------------------------------------------------------------------------

if (process.env.DSH_APK_VM_JDK_E2E === '1') {
  const root = await tempRoot();
  try {
    console.log('E2E downloading a real Eclipse Temurin JDK 17 (~190 MB) ...');
    const startedAt = Date.now();
    const result = await ensureJdk({
      jdkRoot: path.join(root, 'managed'),
      log: (line) => console.log(`  [jdk] ${line}`),
      onProgress: (event) => {
        if (event.step === 'download' && event.received) {
          const mb = Math.round(event.received / (1024 * 1024));
          const total = event.total ? `/${Math.round(event.total / (1024 * 1024))} MB` : ' MB';
          console.log(`  [jdk] downloaded ${mb}${total}`);
        }
      },
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.cached, false);
    assert.equal(typeof result.javaHome, 'string');
    assert.ok(existsSync(path.join(result.javaHome, 'bin', JAVA_BIN)), 'real JDK bin/java must exist');
    assert.match(result.sha256 || '', /^[0-9a-f]{64}$/);
    assert.equal(typeof result.viaMirror, 'boolean');
    assert.ok(result.source === 'api' || result.source === 'known-good', `unexpected source: ${result.source}`);
    assert.equal(result.jdkVersion, 17);
    assert.ok((result.bytes || 0) > 10 * 1024 * 1024, `archive too small: ${result.bytes} bytes`);

    const version = await runJavaVersion(result.javaHome);
    assert.equal(version.ok, true, version.error);
    assert.match(version.output, /version "?17[.\s]/i, `unexpected java -version output: ${version.output}`);

    const second = await ensureJdk({ jdkRoot: path.join(root, 'managed') });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.cached, true);

    passed += 1;
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      `PASS e2e real Temurin JDK 17 download/extract (${result.version || '?'}, ` +
        `${Math.round((result.bytes || 0) / (1024 * 1024))} MB, ${seconds}s, ` +
        `${result.viaMirror ? 'via China mirror' : 'via Adoptium'}): ${result.javaHome}`,
    );
    console.log(`  source: ${result.url || '(reused verified archive)'}`);
    console.log(version.output.split(/\r?\n/)[0] || '');
  } catch (error) {
    failures.push({ name: 'e2e real Temurin JDK 17', error });
    console.log(`FAIL e2e real Temurin JDK 17: ${error && error.message ? error.message : error}`);
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
} else {
  console.log('SKIP e2e real Temurin download (set DSH_APK_VM_JDK_E2E=1 to enable)');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (unhandled.length > 0) {
  failures.push({ name: 'unhandled rejection', error: unhandled[0] });
  console.log(`FAIL unhandled rejection: ${unhandled[0]}`);
}
const total = passed + failures.length;
console.log(`jdk-test: ${passed}/${total} passed`);
if (failures.length > 0) {
  process.exitCode = 1;
}
