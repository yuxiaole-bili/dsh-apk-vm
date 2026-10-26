#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Build the dependency-free dsh-apk-vm sample APK with the Android SDK
 * command-line tools only (no Gradle, no AndroidX, no npm packages).
 *
 * Pipeline: aapt2 compile -> aapt2 link (+ R.java) -> javac -> d8 ->
 * deterministic ZIP packaging -> zipalign -> apksigner (v2/v3).
 *
 * The tiny ZIP writer at the bottom intentionally does not use a library. It
 * copies the compressed resource entries produced by aapt2, adds classes.dex,
 * and pins every entry timestamp so repeated builds of the same sources and
 * toolchain are byte-identical.
 *
 * Usage:
 *   node examples/sample-apk/build.mjs
 *   node examples/sample-apk/build.mjs --sdk <android-sdk> --java-home <jdk>
 *   node examples/sample-apk/build.mjs --api 34 --build-tools 34.0.0
 *
 * Environment fallbacks: ANDROID_SDK_ROOT or ANDROID_HOME, and JAVA_HOME
 * (or javac on PATH). See examples/README.md.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const BUILD_DIR = path.join(HERE, 'build');
const RES_DIR = path.join(HERE, 'res');
const SRC_DIR = path.join(HERE, 'src');
const MANIFEST = path.join(HERE, 'AndroidManifest.xml');
const DEFAULT_KEYSTORE = path.join(HERE, 'demo-public.keystore');
const DEFAULT_OUT = path.join(HERE, 'dsh-sample.apk');

const MIN_SDK = 24;
const TARGET_SDK_DEFAULT = 34;
const PACKAGE_NAME = 'dev.dsh.sample';
const KEY_ALIAS = 'dsh-sample';
/** Public, throwaway demo key password. This is not a secret. */
const KEY_PASS = 'android';
/** ZIP timestamps are pinned to 2020-01-01 00:00:00 for reproducibility. */
const FIXED_DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const FIXED_DOS_TIME = 0;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`build failed: ${error.message}`);
  process.exit(1);
}
if (opts.help) {
  printUsage();
  process.exit(0);
}
if (opts.verbose) console.log('verbose: child process output is echoed');

main().catch((error) => {
  console.error(`\nbuild failed: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const sdk = resolveSdk(opts.sdk);
  const buildTools = pickBuildTools(sdk, opts.buildTools);
  const api = String(opts.api || TARGET_SDK_DEFAULT);
  const androidJar = path.join(sdk, 'platforms', `android-${api}`, 'android.jar');
  if (!existsSync(androidJar)) {
    throw new Error(
      `Android platform android-${api} is not installed under ${path.join(sdk, 'platforms')}. ` +
        `Install it with sdkmanager "platforms;android-${api}" or pass --api <level>.`,
    );
  }
  const javaHome = resolveJavaHome(opts.javaHome);
  const tools = {
    ...buildTools,
    java: javaBin(javaHome, 'java'),
    javac: javaBin(javaHome, 'javac'),
    jar: javaBin(javaHome, 'jar'),
    keytool: javaBin(javaHome, 'keytool'),
  };
  for (const key of ['java', 'javac', 'jar']) {
    if (!existsSync(tools[key])) throw new Error(`missing ${key} in ${javaHome}/bin`);
  }

  const keystore = path.resolve(opts.keystore || DEFAULT_KEYSTORE);
  const outApk = path.resolve(opts.out || DEFAULT_OUT);
  const childEnv = {
    ...process.env,
    JAVA_HOME: javaHome,
    PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
  };
  const run = makeRunner(childEnv);

  if (!existsSync(MANIFEST) || !existsSync(RES_DIR) || !existsSync(SRC_DIR)) {
    throw new Error(`sample sources are incomplete under ${HERE}`);
  }
  await rm(BUILD_DIR, { recursive: true, force: true });
  await mkdir(BUILD_DIR, { recursive: true });
  await mkdir(path.dirname(outApk), { recursive: true });
  await ensureKeystore(keystore, tools, run);

  console.log('dsh-apk-vm sample APK builder');
  console.log(`  platform:    android-${api}`);
  console.log(`  build-tools: ${buildTools.version}`);
  console.log(`  min SDK:     ${MIN_SDK}`);
  console.log(`  output:      ${displayPath(outApk)}`);
  console.log('');

  const resZip = path.join(BUILD_DIR, 'resources.zip');
  const genDir = path.join(BUILD_DIR, 'gen');
  const unsignedApk = path.join(BUILD_DIR, 'unsigned.apk');
  const classesDir = path.join(BUILD_DIR, 'classes');
  const classesJar = path.join(BUILD_DIR, 'classes.jar');
  const dexDir = path.join(BUILD_DIR, 'dex');
  const unalignedApk = path.join(BUILD_DIR, 'unaligned.apk');
  const alignedApk = path.join(BUILD_DIR, 'aligned.apk');
  const signedApk = path.join(BUILD_DIR, 'signed.apk');
  await mkdir(genDir, { recursive: true });
  await mkdir(classesDir, { recursive: true });
  await mkdir(dexDir, { recursive: true });

  // aapt2 and zipalign are native tools that may fail on non-ASCII absolute
  // paths, so feed them paths relative to this directory (the runner's cwd).
  const rel = (file) => path.relative(HERE, file) || '.';

  step(1, 8, 'aapt2 compile');
  run(tools.aapt2, ['compile', '--dir', rel(RES_DIR), '-o', rel(resZip)], {
    label: 'aapt2 compile',
  });

  step(2, 8, 'aapt2 link + R.java');
  run(
    tools.aapt2,
    [
      'link',
      '-o',
      rel(unsignedApk),
      '-I',
      androidJar,
      '--manifest',
      rel(MANIFEST),
      '--java',
      rel(genDir),
      '--min-sdk-version',
      String(MIN_SDK),
      '--target-sdk-version',
      api,
      rel(resZip),
    ],
    { label: 'aapt2 link' },
  );

  step(3, 8, 'javac (framework-only Java sources)');
  const javaFiles = [...collectJavaFiles(genDir), ...collectJavaFiles(SRC_DIR)].sort();
  if (javaFiles.length === 0) throw new Error('no Java sources found');
  run(
    tools.javac,
    [
      '-encoding',
      'UTF-8',
      '-source',
      '8',
      '-target',
      '8',
      '-Xlint:-options',
      '-proc:none',
      '-bootclasspath',
      androidJar,
      '-d',
      classesDir,
      ...javaFiles,
    ],
    { label: 'javac' },
  );

  step(4, 8, 'd8 (classes.jar -> classes.dex)');
  run(tools.jar, ['--create', '--file', classesJar, '-C', classesDir, '.'], { label: 'jar' });
  run(
    tools.java,
    [
      '-cp',
      tools.d8Jar,
      'com.android.tools.r8.D8',
      '--lib',
      androidJar,
      '--min-api',
      String(MIN_SDK),
      '--output',
      dexDir,
      classesJar,
    ],
    { label: 'd8' },
  );
  const dexFile = path.join(dexDir, 'classes.dex');
  if (!existsSync(dexFile)) throw new Error('d8 did not produce classes.dex');

  step(5, 8, 'package classes.dex (fixed ZIP timestamps)');
  const entries = readZipEntries(unsignedApk);
  const arsc = entries.find((entry) => entry.name === 'resources.arsc');
  if (!arsc) throw new Error('aapt2 output has no resources.arsc');
  if (arsc.method !== 0) {
    throw new Error('resources.arsc is compressed; Android 11+ requires it stored uncompressed');
  }
  const dex = readFileSync(dexFile);
  const dexEntry = {
    name: 'classes.dex',
    method: 0, // stored: avoids zlib version differences and is a valid APK entry
    crc: crc32(dex),
    usize: dex.length,
    data: dex,
  };
  const manifestIndex = entries.findIndex((entry) => entry.name === 'AndroidManifest.xml');
  entries.splice(manifestIndex >= 0 ? manifestIndex + 1 : 0, 0, dexEntry);
  writeZipEntries(entries, unalignedApk);

  step(6, 8, 'zipalign -p 4');
  run(tools.zipalign, ['-f', '-p', '4', rel(unalignedApk), rel(alignedApk)], {
    label: 'zipalign',
  });

  step(7, 8, 'apksigner (v2 + v3, public demo key)');
  run(
    tools.java,
    [
      '-jar',
      tools.apksignerJar,
      'sign',
      '--ks',
      keystore,
      '--ks-key-alias',
      KEY_ALIAS,
      '--ks-pass',
      `pass:${KEY_PASS}`,
      '--key-pass',
      `pass:${KEY_PASS}`,
      '--v1-signing-enabled',
      'false',
      '--v2-signing-enabled',
      'true',
      '--v3-signing-enabled',
      'true',
      '--v4-signing-enabled',
      'false',
      '--out',
      signedApk,
      alignedApk,
    ],
    { label: 'apksigner sign' },
  );

  step(8, 8, 'verify, inspect, copy into place');
  const verify = run(
    tools.java,
    ['-jar', tools.apksignerJar, 'verify', '--verbose', '--print-certs', signedApk],
    { label: 'apksigner verify' },
  );
  const schemes = {
    v1: /Verified using v1 scheme \(JAR signing\): (true|false)/.exec(verify)?.[1] === 'true',
    v2: /Verified using v2 scheme \(APK Signature Scheme v2\): (true|false)/.exec(verify)?.[1] === 'true',
    v3: /Verified using v3 scheme \(APK Signature Scheme v3\): (true|false)/.exec(verify)?.[1] === 'true',
  };
  if (!schemes.v2) throw new Error('apksigner verify did not confirm the v2 signature');

  const badging = run(tools.aapt2, ['dump', 'badging', rel(signedApk)], {
    label: 'aapt2 dump badging',
  });
  const packageName = /^package: name='([^']+)'/m.exec(badging)?.[1];
  const launchable = /^launchable-activity: name='([^']+)'/m.exec(badging)?.[1];
  const versionName = /^package: name='[^']+' versionCode='[^']+' versionName='([^']+)'/m.exec(badging)?.[1];
  if (packageName !== PACKAGE_NAME) {
    throw new Error(`unexpected package name in built APK: ${packageName || '(missing)'}`);
  }
  if (!launchable) throw new Error('built APK has no launchable activity');

  await copyFile(signedApk, outApk);
  const bytes = statSync(outApk).size;
  const sha256 = createHash('sha256').update(readFileSync(outApk)).digest('hex');

  console.log('');
  console.log('APK built successfully');
  console.log(`  file:        ${displayPath(outApk)}`);
  console.log(`  bytes:       ${bytes}`);
  console.log(`  sha256:      ${sha256}`);
  console.log(`  package:     ${packageName}`);
  console.log(`  version:     ${versionName || '(unknown)'}`);
  console.log(`  activity:    ${launchable}`);
  console.log(
    `  signatures:  v2=${schemes.v2} v3=${schemes.v3} v1=${schemes.v1} (public demo key)`,
  );
}

function printUsage() {
  console.log(`Usage: node examples/sample-apk/build.mjs [options]

Options:
  --sdk <dir>          Android SDK root (default: ANDROID_SDK_ROOT or ANDROID_HOME)
  --java-home <dir>    JDK 17+ home (default: JAVA_HOME, or javac on PATH)
  --api <level>        Compile/target platform (default: ${TARGET_SDK_DEFAULT})
  --build-tools <ver>  Use a specific build-tools version (default: newest installed)
  --keystore <file>    Signing keystore (default: demo-public.keystore)
  --out <file>         Output APK (default: dsh-sample.apk)
  --verbose            Echo each child command
  --help               Show this help

The checked-in demo keystore is a public, throwaway test key. Do not use it for
anything but this sample.`);
}

function parseArgs(argv) {
  const parsed = { verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    let value = eq >= 0 ? arg.slice(eq + 1) : undefined;
    if (name === 'verbose') {
      parsed.verbose = true;
      continue;
    }
    if (value === undefined) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--${name} requires a value`);
      }
      i += 1;
    }
    switch (name) {
      case 'sdk':
      case 'java-home':
      case 'api':
      case 'build-tools':
      case 'keystore':
      case 'out':
        parsed[name === 'java-home' ? 'javaHome' : name === 'build-tools' ? 'buildTools' : name] = value;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return parsed;
}

function resolveSdk(explicit) {
  const candidates = uniquePaths([
    explicit,
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    process.platform === 'win32' && path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'),
    process.platform === 'darwin' && path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    process.platform !== 'win32' && path.join(os.homedir(), 'Android', 'Sdk'),
    process.platform !== 'win32' && path.join(os.homedir(), 'Android', 'sdk'),
  ]);
  for (const candidate of candidates) {
    if (
      existsSync(path.join(candidate, 'build-tools')) &&
      existsSync(path.join(candidate, 'platforms'))
    ) {
      return path.resolve(candidate);
    }
  }
  throw new Error(
    'Android SDK not found. Set ANDROID_SDK_ROOT (or ANDROID_HOME), or pass --sdk <dir>. ' +
      'The SDK needs build-tools and platforms directories.',
  );
}

function resolveJavaHome(explicit) {
  const candidates = uniquePaths([
    explicit,
    process.env.JAVA_HOME,
    process.platform === 'win32' &&
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Android', 'Android Studio', 'jbr'),
    process.platform === 'win32' &&
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Android Studio', 'jbr'),
    process.platform === 'darwin' && '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    process.platform !== 'win32' && path.join(os.homedir(), 'android-studio', 'jbr'),
  ]);
  for (const candidate of candidates) {
    if (javaToolsPresent(candidate)) return path.resolve(candidate);
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of process.platform === 'win32' ? ['.exe', ''] : ['']) {
      const javac = path.join(dir, `javac${ext}`);
      if (existsSync(javac)) {
        const home = path.dirname(path.dirname(javac));
        if (javaToolsPresent(home)) return path.resolve(home);
        break;
      }
    }
  }
  throw new Error(
    'JDK not found. Set JAVA_HOME, or pass --java-home <dir>. ' +
      'JDK 17 is recommended; javac, jar and keytool are required.',
  );
}

function javaToolsPresent(home) {
  return ['javac', 'java', 'jar'].every((tool) => existsSync(javaBin(home, tool)));
}

function javaBin(home, tool) {
  return path.join(home, 'bin', process.platform === 'win32' ? `${tool}.exe` : tool);
}

function pickBuildTools(sdk, explicit) {
  const root = path.join(sdk, 'build-tools');
  const versions = explicit
    ? [String(explicit)]
    : readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+){1,2}$/.test(entry.name))
        .map((entry) => entry.name)
        .sort(compareVersions)
        .reverse();
  const attempted = [];
  for (const version of versions) {
    const dir = path.join(root, version);
    const aapt2 = findTool(dir, 'aapt2');
    const zipalign = findTool(dir, 'zipalign');
    const d8Jar = path.join(dir, 'lib', 'd8.jar');
    const apksignerJar = path.join(dir, 'lib', 'apksigner.jar');
    if (aapt2 && zipalign && existsSync(d8Jar) && existsSync(apksignerJar)) {
      return { version, aapt2, zipalign, d8Jar, apksignerJar };
    }
    attempted.push(version);
  }
  throw new Error(
    `no usable build-tools found under ${root}` +
      (explicit ? ` (requested ${explicit})` : attempted.length ? `; tried ${attempted.join(', ')}` : '') +
      '. Install build-tools with sdkmanager.',
  );
}

function findTool(dir, base) {
  const names =
    process.platform === 'win32' ? [`${base}.exe`, `${base}.bat`, `${base}.cmd`, base] : [base];
  for (const name of names) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function collectJavaFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectJavaFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.java')) files.push(full);
  }
  return files;
}

function makeRunner(childEnv) {
  return function run(exe, args, { label = path.basename(exe) } = {}) {
    if (opts.verbose) console.log(`$ ${[exe, ...args].map(quoteForLog).join(' ')}`);
    const result = spawnSync(exe, args, {
      cwd: HERE,
      env: childEnv,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error) {
      throw new Error(`${label} could not start: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = `${result.stdout || ''}${result.stderr || ''}`.trim();
      throw new Error(
        `${label} exited with code ${result.status}${detail ? `\n${detail.slice(-4000)}` : ''}`,
      );
    }
    return `${result.stdout || ''}${result.stderr || ''}`;
  };
}

async function ensureKeystore(keystore, tools, run) {
  if (existsSync(keystore)) return;
  if (!existsSync(tools.keytool)) {
    throw new Error(
      `signing keystore not found (${displayPath(keystore)}) and keytool is unavailable; ` +
        'add --keystore or install a full JDK',
    );
  }
  await mkdir(path.dirname(keystore), { recursive: true });
  console.log(
    `signing keystore not found; generating a new public demo key at ${displayPath(keystore)}`,
  );
  console.log('note: a new key changes the APK signature, so the output will not match the committed APK');
  run(
    tools.keytool,
    [
      '-genkeypair',
      '-noprompt',
      '-keystore',
      keystore,
      '-storetype',
      'PKCS12',
      '-storepass',
      KEY_PASS,
      '-keypass',
      KEY_PASS,
      '-alias',
      KEY_ALIAS,
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '10000',
      '-dname',
      'CN=dsh-apk-vm sample, OU=Demo, O=dsh-apk-vm, C=US',
    ],
    { label: 'keytool' },
  );
}

function step(index, total, label) {
  console.log(`[${index}/${total}] ${label}`);
}

function displayPath(file) {
  const relative = path.relative(REPO_ROOT, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return file;
  return relative.split(path.sep).join('/');
}

function uniquePaths(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value) continue;
    const resolved = path.resolve(String(value));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function quoteForLog(value) {
  const text = String(value);
  return /[\s"']/u.test(text) ? JSON.stringify(text) : text;
}

/* ------------------------------------------------------------------------- */
/* Tiny deterministic ZIP reader/writer (ZIP64 is intentionally unsupported) */
/* ------------------------------------------------------------------------- */

function readZipEntries(file) {
  const buffer = readFileSync(file);
  const eocdMin = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= eocdMin; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error(`not a ZIP/APK file: ${file}`);
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) {
    throw new Error('multi-disk ZIP archives are not supported');
  }
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 is not supported by the tiny packer');
  }
  if (centralOffset + centralSize > buffer.length) throw new Error('corrupt ZIP central directory');

  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt ZIP entry');
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('corrupt ZIP local header');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > buffer.length) throw new Error('truncated ZIP entry');
    if (method !== 0 && method !== 8) throw new Error(`unsupported ZIP method ${method} for ${name}`);
    entries.push({
      name,
      method,
      crc,
      usize: uncompressedSize,
      data: buffer.subarray(dataOffset, dataOffset + compressedSize),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function writeZipEntries(entries, file) {
  if (entries.length > 0xffff) throw new Error('too many ZIP entries');
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (name.length > 0xffff) throw new Error(`ZIP entry name is too long: ${entry.name}`);
    if (entry.data.length >= 0xffffffff || entry.usize >= 0xffffffff) {
      throw new Error(`ZIP64 needed for ${entry.name}`);
    }
    const flags = /[^\x00-\x7f]/u.test(entry.name) ? 0x0800 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.usize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.usize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.length + name.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  writeFileSync(file, Buffer.concat([...localParts, centralDirectory, end]));
}
