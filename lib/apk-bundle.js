/**
 * APK bundle support: plain .apk, Android App Bundle archives (.apks) and
 * XAPK packages. Uses only Node built-ins; split APKs are extracted to a temp
 * directory and installed with `adb install-multiple`.
 */
import { inflateRawSync } from 'node:zlib';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function readUInt64(buffer, offset) {
  const low = buffer.readUInt32LE(offset);
  const high = buffer.readUInt32LE(offset + 4);
  return high * 0x100000000 + low;
}

/** List entries in an APK/ZIP/APKS/XAPK archive from its central directory. */
export function listZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('not a ZIP archive');
  let eocd = -1;
  const min = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive: end-of-central-directory not found');
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < total; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('corrupt ZIP central directory');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength).replace(/\\/g, '/');
    if (name && !name.endsWith('/')) {
      entries.push({
        name,
        method,
        compressedSize,
        uncompressedSize,
        localOffset,
        dataOffset: -1,
      });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  for (const entry of entries) {
    if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
      throw new Error(`corrupt ZIP local header for ${entry.name}`);
    }
    const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
    entry.dataOffset = entry.localOffset + 30 + nameLength + extraLength;
    if (entry.dataOffset + entry.compressedSize > buffer.length) throw new Error(`truncated ZIP entry ${entry.name}`);
  }
  return entries;
}

function readZipEntry(buffer, entry) {
  const data = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

function safeEntryPath(name) {
  const normalized = String(name || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
  if (!normalized || normalized.includes('\0')) throw new Error(`unsafe ZIP entry name: ${JSON.stringify(name)}`);
  return normalized;
}

function isApkEntry(name) {
  return /\.apk$/i.test(name);
}

function bundleKind(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.apk') return 'apk';
  if (ext === '.apks') return 'apks';
  if (ext === '.xapk') return 'xapk';
  if (ext === '.aab') return 'aab';
  return 'unknown';
}

function chooseBase(apks) {
  const byName = apks.find((entry) => /(^|\/)(splits\/)?base-master\.apk$/i.test(entry.name));
  if (byName) return byName;
  const plainBase = apks.find((entry) => /(^|\/)(base|universal|app)\.apk$/i.test(entry.name));
  if (plainBase) return plainBase;
  return [...apks].sort((a, b) => b.uncompressedSize - a.uncompressedSize)[0] || null;
}

/**
 * Extract a bundle to a temp directory.
 * Returns { kind, basePath, apkPaths, extractedDir, entries }.
 */
export async function extractApkBundle(filePath, options = {}) {
  const source = path.resolve(String(filePath || ''));
  const kind = bundleKind(source);
  if (kind === 'unknown') throw new Error(`unsupported package extension: ${path.extname(source) || '(none)'}`);
  if (kind === 'aab') {
    throw new Error(
      'AAB files are App Bundles and cannot be installed directly; build device APKs first ' +
        '(e.g. `bundletool build-apks --bundle app.aab --output app.apks`) and upload the .apks file',
    );
  }
  if (kind === 'apk') return { kind, basePath: source, apkPaths: [source], extractedDir: null, entries: [] };
  const buffer = await fsp.readFile(source);
  const entries = listZipEntries(buffer);
  const apks = entries.filter((entry) => isApkEntry(entry.name));
  if (!apks.length) throw new Error(`${kind.toUpperCase()} archive contains no .apk entries`);
  const base = chooseBase(apks);
  if (!base) throw new Error(`${kind.toUpperCase()} archive has no candidate base APK`);
  // Install the base plus all split/config APKs. In .apks archives the
  // standalone variant is intentionally ignored: it is a complete fallback, not
  // a split that belongs next to base-master.
  let selected = apks;
  if (kind === 'apks') {
    selected = apks.filter((entry) => !/^standalones\//i.test(entry.name));
    if (!selected.some((entry) => entry.name === base.name)) selected.push(base);
  }
  const dir =
    options.dir ||
    path.join(os.tmpdir(), `dsh-apk-bundle-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await fsp.mkdir(dir, { recursive: true });
  const apkPaths = [];
  let basePath = null;
  for (const entry of selected) {
    const relative = safeEntryPath(entry.name);
    const target = path.join(dir, relative);
    if (!target.startsWith(dir + path.sep)) throw new Error(`unsafe bundle path: ${entry.name}`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, readZipEntry(buffer, entry));
    apkPaths.push(target);
    if (entry.name === base.name) basePath = target;
  }
  if (!basePath) basePath = apkPaths[0];
  return {
    kind,
    basePath,
    apkPaths,
    extractedDir: dir,
    entries: selected.map((entry) => entry.name),
  };
}

export async function cleanupBundle(bundle) {
  if (!bundle || !bundle.extractedDir) return;
  await fsp.rm(bundle.extractedDir, { recursive: true, force: true }).catch(() => {});
}
