/**
 * Storage accounting and housekeeping for the Android VM.
 *
 * All reported sizes are logical bytes (sparse files are counted by length), so
 * the panel distinguishes apparent AVD size from actual free space. Cleanup is
 * explicit: this module never deletes an AVD or snapshot unless the caller asks
 * for that exact action.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_FILES = 200000;

async function walkSize(root, options = {}) {
  const result = { bytes: 0, files: 0, skipped: false };
  const stack = [String(root)];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (options.stopAt && result.bytes > options.stopAt) {
        result.skipped = true;
        return result;
      }
      if (result.files >= MAX_FILES) {
        result.skipped = true;
        return result;
      }
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fsp.stat(full);
        result.bytes += stat.size;
        result.files += 1;
      } catch {
        /* vanished */
      }
    }
  }
  return result;
}

async function readAvdIni(avdRoot, name) {
  try {
    const text = await fsp.readFile(path.join(avdRoot, `${name}.ini`), 'utf8');
    const match = /^path=(.+)$/m.exec(text);
    return match ? match[1].trim() : path.join(avdRoot, `${name}.avd`);
  } catch {
    return path.join(avdRoot, `${name}.avd`);
  }
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

async function fileStatOrNull(file) {
  try {
    return await fsp.stat(file);
  } catch {
    return null;
  }
}

/** Measure emulator crash dumps written under the emulator crash-report directory. */
async function collectCrashDumps(tempRoot) {
  const dumps = [];
  let bytes = 0;
  const stack = [path.join(tempRoot, 'AndroidEmulator')];
  while (stack.length) {
    const dir = stack.pop();
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.dmp')) continue;
      const stat = await fileStatOrNull(full);
      if (!stat) continue;
      dumps.push({ path: full, bytes: stat.size, at: stat.mtimeMs });
      bytes += stat.size;
    }
  }
  dumps.sort((a, b) => b.bytes - a.bytes);
  return { dumps, bytes };
}

/** Collect AVD sizes, SDK sizes, plugin temp files and free disk space. */
export async function collectStorage(options = {}) {
  const home = options.home || os.homedir();
  const avdRoot = path.resolve(options.avdRoot || path.join(home, '.android', 'avd'));
  const tempRoot = path.resolve(options.tempRoot || os.tmpdir());
  const sdkRoot = options.sdkRoot ? path.resolve(options.sdkRoot) : null;
  const activeAvds = new Set((options.activeAvds || []).map(String));
  const knownAvds = new Set((options.knownAvds || []).map(String));

  const avds = [];
  let avdEntries = [];
  try {
    avdEntries = await fsp.readdir(avdRoot, { withFileTypes: true });
  } catch {
    avdEntries = [];
  }
  for (const entry of avdEntries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.avd')) continue;
    const name = entry.name.slice(0, -4);
    const avdPath = await readAvdIni(avdRoot, name);
    const total = await walkSize(avdPath);
    const snapshotsDir = path.join(avdPath, 'snapshots');
    const snapshots = await walkSize(snapshotsDir);
    avds.push({
      name,
      path: avdPath,
      totalBytes: total.bytes,
      totalFiles: total.files,
      snapshotBytes: snapshots.bytes,
      userdataBytes: Math.max(0, total.bytes - snapshots.bytes),
      active: activeAvds.has(name),
      registered: knownAvds.has(name),
      managed: name === 'dsh_apk' || name.startsWith('dsh_apk_'),
      orphan: name.startsWith('dsh_apk_') && !knownAvds.has(name) && !activeAvds.has(name),
    });
  }
  avds.sort((a, b) => b.totalBytes - a.totalBytes);

  // Quarantined quick-boot snapshots (*.corrupt-*, *.bak-*) pile up after every
  // emulator crash. They are only useful for forensics, so report them so the
  // panel can offer an explicit cleanup.
  const corruptSnapshots = [];
  let corruptBytes = 0;
  for (const item of avds) {
    const snapshotsDir = path.join(item.path, 'snapshots');
    const children = await fsp.readdir(snapshotsDir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (!child.isDirectory() || !/(corrupt|\.bak-|\.old-|\.tmp-)/i.test(child.name)) continue;
      const dir = path.join(snapshotsDir, child.name);
      const measured = await walkSize(dir);
      corruptSnapshots.push({ avd: item.name, name: child.name, path: dir, bytes: measured.bytes, files: measured.files });
      corruptBytes += measured.bytes;
    }
  }
  const crashDumps = await collectCrashDumps(tempRoot);

  const temp = {
    uploadsBytes: (await walkSize(path.join(tempRoot, 'dsh-apk-vm-uploads'))).bytes,
    flowsBytes: (await walkSize(path.join(tempRoot, 'dsh-apk-vm-flows'))).bytes,
    screenshotsBytes: 0,
    recordingsBytes: 0,
    files: 0,
  };
  try {
    const entries = await fsp.readdir(tempRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/^(apk-vm-shot-|dsh-apk-vm-record-)/.test(entry.name)) continue;
      const stat = await fileStatOrNull(path.join(tempRoot, entry.name));
      if (!stat) continue;
      temp.files += 1;
      if (entry.name.startsWith('apk-vm-shot-')) temp.screenshotsBytes += stat.size;
      else temp.recordingsBytes += stat.size;
    }
  } catch {
    /* ignore */
  }

  let sdk = null;
  if (sdkRoot) {
    const total = await walkSize(sdkRoot);
    const parts = {};
    for (const part of ['system-images', 'emulator', 'build-tools', 'platform-tools', 'platforms']) {
      parts[part] = (await walkSize(path.join(sdkRoot, part))).bytes;
    }
    sdk = { root: sdkRoot, totalBytes: total.bytes, totalFiles: total.files, parts };
  }

  let disk = null;
  try {
    const stats = await fsp.statfs(avdRoot || home);
    disk = {
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
      availableBytes: Number(stats.bavail) * Number(stats.bsize),
      path: avdRoot || home,
    };
  } catch {
    disk = null;
  }
  let sdkDisk = null;
  if (sdkRoot) {
    try {
      const stats = await fsp.statfs(sdkRoot);
      sdkDisk = {
        totalBytes: Number(stats.blocks) * Number(stats.bsize),
        freeBytes: Number(stats.bavail) * Number(stats.bsize),
        path: sdkRoot,
      };
    } catch {
      sdkDisk = null;
    }
  }

  const snapshotTotal = avds.reduce((sum, item) => sum + item.snapshotBytes, 0);
  const tempTotal = temp.uploadsBytes + temp.flowsBytes + temp.screenshotsBytes + temp.recordingsBytes;
  const orphanBytes = avds.filter((item) => item.orphan).reduce((sum, item) => sum + item.totalBytes, 0);
  const reclaimableBytes = orphanBytes + corruptBytes + crashDumps.bytes + tempTotal;
  const recommendations = [];
  if (snapshotTotal > 1024 * 1024 * 1024) {
    recommendations.push({
      code: 'snapshots',
      bytes: snapshotTotal,
      text: `Quick-boot snapshots use ${formatBytes(snapshotTotal)}; disable quickBoot/saveSnapshotAfterBoot or delete a snapshot to free it.`,
    });
  }
  if (tempTotal > 0) {
    recommendations.push({ code: 'temp', bytes: tempTotal, text: `Plugin temp files use ${formatBytes(tempTotal)}; safe to clean.` });
  }
  if (corruptBytes > 0) {
    recommendations.push({
      code: 'corrupt-snapshots',
      bytes: corruptBytes,
      text: `${corruptSnapshots.length} quarantined snapshot backup(s) use ${formatBytes(corruptBytes)}; safe to delete.`,
    });
  }
  if (crashDumps.bytes > 0) {
    recommendations.push({
      code: 'crash-dumps',
      bytes: crashDumps.bytes,
      text: `${crashDumps.dumps.length} emulator crash dump(s) use ${formatBytes(crashDumps.bytes)}; safe to delete.`,
    });
  }
  const orphans = avds.filter((item) => item.orphan);
  if (orphans.length) {
    recommendations.push({
      code: 'orphan-avds',
      bytes: orphanBytes,
      text: `${orphans.length} orphan dsh_apk_* AVD(s) are not registered to a running instance; reclaim ${formatBytes(orphanBytes)}.`,
    });
  }

  return {
    ok: true,
    sampledAt: new Date().toISOString(),
    home,
    avdRoot,
    tempRoot,
    sdk,
    sdkDisk,
    avds,
    temp,
    corruptSnapshots,
    crashDumps: crashDumps.dumps,
    disk,
    totals: {
      avdBytes: avds.reduce((sum, item) => sum + item.totalBytes, 0),
      snapshotBytes: snapshotTotal,
      sdkBytes: sdk ? sdk.totalBytes : 0,
      tempBytes: tempTotal,
      corruptBytes,
      crashBytes: crashDumps.bytes,
      orphanBytes,
      reclaimableBytes,
      freeBytes: disk ? disk.freeBytes : 0,
    },
    recommendations,
    formatter: 'bytes',
  };
}

async function removeTree(target) {
  const existed = await fsp.stat(target).catch(() => null);
  if (!existed) return 0;
  const measured = await walkSize(target);
  await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
  return measured.bytes;
}

/** Delete only the plugin's own temporary artifacts. */
export async function cleanTempFiles(options = {}) {
  const tempRoot = path.resolve(options.tempRoot || os.tmpdir());
  let freed = 0;
  let files = 0;
  for (const name of ['dsh-apk-vm-uploads', 'dsh-apk-vm-flows']) {
    const dir = path.join(tempRoot, name);
    const measured = await walkSize(dir);
    await removeTree(dir);
    freed += measured.bytes;
    files += measured.files;
  }
  const entries = await fsp.readdir(tempRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !/^(apk-vm-shot-|dsh-apk-vm-record-)/.test(entry.name)) continue;
    const full = path.join(tempRoot, entry.name);
    const stat = await fileStatOrNull(full);
    if (!stat) continue;
    await fsp.unlink(full).catch(() => {});
    freed += stat.size;
    files += 1;
  }
  return { ok: true, action: 'temp', freedBytes: freed, files };
}

/** Delete snapshots for one AVD by name. Refuses active or non-managed AVDs unless forced. */
export async function cleanSnapshots(options = {}) {
  const avdRoot = path.resolve(options.avdRoot || path.join(os.homedir(), '.android', 'avd'));
  const name = String(options.avdName || '').trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new Error('invalid AVD name');
  if (name !== 'dsh_apk' && !name.startsWith('dsh_apk_')) {
    throw new Error('only plugin-managed dsh_apk* AVDs can have snapshots cleaned');
  }
  const avdPath = await readAvdIni(avdRoot, name);
  if (!avdPath.startsWith(avdRoot + path.sep)) throw new Error('AVD path escapes the AVD root');
  const snapshotsDir = path.join(avdPath, 'snapshots');
  const measured = await walkSize(snapshotsDir);
  await removeTree(snapshotsDir);
  return { ok: true, action: 'snapshots', avdName: name, freedBytes: measured.bytes, files: measured.files };
}

/** Delete only orphan dsh_apk_* AVDs that are not registered/active. */
export async function cleanOrphanAvds(options = {}) {
  const avdRoot = path.resolve(options.avdRoot || path.join(os.homedir(), '.android', 'avd'));
  const known = new Set((options.knownAvds || []).map(String));
  const active = new Set((options.activeAvds || []).map(String));
  const entries = await fsp.readdir(avdRoot, { withFileTypes: true }).catch(() => []);
  const removed = [];
  let freed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.avd')) continue;
    const name = entry.name.slice(0, -4);
    if (!name.startsWith('dsh_apk_') || known.has(name) || active.has(name)) continue;
    const avdPath = path.join(avdRoot, entry.name);
    // A manually launched emulator may hold a lock even if this plugin does not
    // know the AVD; never delete a directory whose lock file is fresh (locks
    // left behind by a crashed emulator are stale after ten minutes).
    const children = await fsp.readdir(avdPath).catch(() => []);
    let lockedByLiveEmulator = false;
    for (const child of children) {
      if (!child.endsWith('.lock')) continue;
      const stat = await fileStatOrNull(path.join(avdPath, child));
      if (stat && Date.now() - stat.mtimeMs < 10 * 60 * 1000) {
        lockedByLiveEmulator = true;
        break;
      }
    }
    if (lockedByLiveEmulator) continue;
    const measured = await walkSize(avdPath);
    await fsp.rm(avdPath, { recursive: true, force: true }).catch(() => {});
    await fsp.unlink(path.join(avdRoot, `${name}.ini`)).catch(() => {});
    freed += measured.bytes;
    removed.push({ name, bytes: measured.bytes });
  }
  return { ok: true, action: 'orphan-avds', freedBytes: freed, removed };
}

/** Delete quarantined *.corrupt-* snapshot backups for managed AVDs (never loaded by the emulator). */
export async function cleanCorruptSnapshots(options = {}) {
  const avdRoot = path.resolve(options.avdRoot || path.join(os.homedir(), '.android', 'avd'));
  const removed = [];
  let freed = 0;
  let files = 0;
  const entries = await fsp.readdir(avdRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.avd')) continue;
    const name = entry.name.slice(0, -4);
    if (!name.startsWith('dsh_apk')) continue;
    const snapshotsDir = path.join(avdRoot, entry.name, 'snapshots');
    const children = await fsp.readdir(snapshotsDir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (!child.isDirectory() || !/(corrupt|\.bak-|\.old-|\.tmp-)/i.test(child.name)) continue;
      const target = path.join(snapshotsDir, child.name);
      const measured = await walkSize(target);
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
      freed += measured.bytes;
      files += measured.files;
      removed.push({ avd: name, name: child.name, bytes: measured.bytes });
    }
  }
  return { ok: true, action: 'corrupt-snapshots', freedBytes: freed, files, removed };
}

/** Delete emulator crash dumps under the emulator crash-report directory. */
export async function cleanCrashDumps(options = {}) {
  const tempRoot = path.resolve(options.tempRoot || os.tmpdir());
  const root = path.join(tempRoot, 'AndroidEmulator');
  const removed = [];
  let freed = 0;
  let files = 0;
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^emu-crash-/i.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const measured = await walkSize(dir);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    freed += measured.bytes;
    files += measured.files;
    removed.push({ name: entry.name, bytes: measured.bytes });
  }
  return { ok: true, action: 'crash-dumps', freedBytes: freed, files, removed };
}

export { formatBytes };
