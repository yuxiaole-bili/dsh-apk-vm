/**
 * lib/installed-apps.js — remember APKs installed through the plugin and
 * reinstall them when a VM boots without the package.
 *
 * Why: a VM can be reset to a clean state (the quick-boot snapshot was pruned,
 * the AVD was recreated, the plugin/emulator was upgraded, or the guest image
 * changed). The installed app and its login state are then gone, and the Agent
 * has to reinstall the APK by hand. This registry keeps a small local list of
 * APKs the plugin installed and lets the host reinstall any whose package is
 * missing on the next boot.
 *
 * Storage: `<dataDir>/.apk-vm/installed-apps.json` (JSON, atomic write,
 * tolerant reads). Only local host paths and package metadata are stored;
 * nothing here is uploaded anywhere. Delete the file or set
 * `autoReinstall: false` to opt out.
 *
 * No npm dependencies.
 */
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const INSTALLED_APPS_VERSION = 1;
export const DEFAULT_MAX_REMEMBERED_APPS = 10;
const ENTRY_STRING_MAX = 1024;

/**
 * Default registry file for a data directory: `<dataDir>/.apk-vm/installed-apps.json`.
 *
 * @param {string} dataDir
 * @returns {string}
 */
export function defaultInstalledAppsPath(dataDir) {
  return path.join(String(dataDir || process.cwd()), '.apk-vm', 'installed-apps.json');
}

function cleanString(value, max = ENTRY_STRING_MAX) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Normalize one remembered-app record. Returns null for records without a
 * usable local APK path (the package name is filled in after a successful
 * install when the guest reports it).
 *
 * @param {any} input
 * @returns {{ apkPath: string, packageName: string | null, label: string | null,
 *   launchActivity: string | null, instanceId: string, rememberedAt: number } | null}
 */
export function normalizeRememberedApp(input) {
  if (!input || typeof input !== 'object') return null;
  const apkPath = cleanString(input.apkPath || input.path);
  if (!apkPath || !path.isAbsolute(apkPath)) return null;
  const rememberedAt = Number(input.rememberedAt || input.installedAt);
  return {
    apkPath,
    packageName: cleanString(input.packageName),
    label: cleanString(input.label),
    launchActivity: cleanString(input.launchActivity),
    instanceId: cleanString(input.instanceId) || 'default',
    rememberedAt: Number.isFinite(rememberedAt) && rememberedAt > 0 ? rememberedAt : Date.now(),
  };
}

function safeWinKey(value) {
  const text = String(value || '');
  return process.platform === 'win32' ? text.replace(/\//g, '\\').toLowerCase() : text;
}

/**
 * Small persistent registry of APKs installed through the plugin.
 *
 * All methods are best-effort: reads tolerate corrupt files and `record()`
 * never throws on I/O failures (callers are on the install path).
 */
export class InstalledAppRegistry {
  /**
   * @param {{ file: string, maxApps?: number, now?: () => number }} options
   */
  constructor(options = {}) {
    if (!options.file) throw new TypeError('InstalledAppRegistry requires a file path');
    this.file = path.resolve(String(options.file));
    this.maxApps = Number.isFinite(options.maxApps) && options.maxApps > 0
      ? Math.floor(options.maxApps)
      : DEFAULT_MAX_REMEMBERED_APPS;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    /** @type {ReturnType<typeof normalizeRememberedApp>[]} */
    this._entries = null;
  }

  async _load() {
    if (this._entries) return this._entries;
    this._entries = [];
    try {
      const text = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.apps) ? parsed.apps : [];
      const seen = new Set();
      for (const raw of list) {
        const entry = normalizeRememberedApp(raw);
        if (!entry) continue;
        const key = `${safeWinKey(entry.apkPath)}|${entry.instanceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this._entries.push(entry);
      }
      this._entries.sort((a, b) => b.rememberedAt - a.rememberedAt);
      this._entries = this._entries.slice(0, this.maxApps);
    } catch {
      this._entries = [];
    }
    return this._entries;
  }

  async _save() {
    const payload = {
      version: INSTALLED_APPS_VERSION,
      updatedAt: this.now(),
      apps: this._entries || [],
    };
    const dir = path.dirname(this.file);
    const temporary = `${this.file}.tmp-${process.pid}`;
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await fsp.rename(temporary, this.file);
      return { ok: true };
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => {});
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  /**
   * @returns {Promise<{ apkPath: string, packageName: string | null, label: string | null,
   *   launchActivity: string | null, instanceId: string, rememberedAt: number }[]>}
   */
  async list() {
    const entries = await this._load();
    return entries.map((entry) => ({ ...entry }));
  }

  /**
   * Remember (or refresh) an installed APK. Upserts by APK path + instance and
   * keeps the newest `maxApps` entries.
   *
   * @param {any} input
   * @returns {Promise<{ ok: boolean, error?: string, entries: any[] }>}
   */
  async record(input) {
    const base = normalizeRememberedApp(input);
    if (!base) return { ok: false, error: 'invalid remembered-app record', entries: await this.list() };
    const entry = { ...base, rememberedAt: this.now() };
    const entries = await this._load();
    const key = `${safeWinKey(entry.apkPath)}|${entry.instanceId}`;
    const next = [entry, ...entries.filter((item) => `${safeWinKey(item.apkPath)}|${item.instanceId}` !== key)];
    this._entries = next.slice(0, this.maxApps);
    const saved = await this._save();
    return { ok: saved.ok, error: saved.error, entries: await this.list() };
  }

  /**
   * @param {(entry: any) => boolean} predicate
   * @returns {Promise<{ removed: number }>}
   */
  async forget(predicate) {
    const entries = await this._load();
    const kept = entries.filter((entry) => !predicate(entry));
    const removed = entries.length - kept.length;
    if (removed > 0) {
      this._entries = kept;
      await this._save();
    }
    return { removed };
  }

  async clear() {
    const entries = await this._load();
    const removed = entries.length;
    this._entries = [];
    await this._save();
    return { removed };
  }

  /**
   * Summaries for the panel/HTTP (`GET /apk-vm/state` → `rememberedApps`).
   * @returns {Promise<{ count: number, apps: { packageName: string | null, label: string | null,
   *   apkPath: string, instanceId: string, rememberedAt: number }[] }>}
   */
  async summary() {
    const entries = await this.list();
    return {
      count: entries.length,
      apps: entries.map((entry) => ({
        packageName: entry.packageName,
        label: entry.label,
        apkPath: entry.apkPath,
        instanceId: entry.instanceId,
        rememberedAt: entry.rememberedAt,
      })),
    };
  }
}

/**
 * Reinstall remembered APKs whose package is missing on a ready VM.
 *
 * Only entries whose local APK file still exists are considered; packages that
 * are already installed are skipped. Failures are collected, never thrown.
 *
 * @param {{
 *   registry: { list: () => Promise<any[]> },
 *   listPackages: () => Promise<{ packages?: { packageName?: string }[] }>,
 *   installApk: (apkPath: string) => Promise<any>,
 *   fileExists?: (file: string) => boolean,
 * }} options
 * @returns {Promise<{ ok: boolean, checked: number, reinstalled: any[], skipped: any[], failed: any[], error?: string }>}
 */
export async function reinstallMissingApps(options = {}) {
  const registry = options.registry;
  const listPackages = options.listPackages;
  const installApk = options.installApk;
  const fileExists = typeof options.fileExists === 'function' ? options.fileExists : (file) => existsSync(file);
  if (!registry || typeof registry.list !== 'function') {
    throw new TypeError('reinstallMissingApps requires a registry with list()');
  }
  if (typeof listPackages !== 'function' || typeof installApk !== 'function') {
    throw new TypeError('reinstallMissingApps requires listPackages() and installApk()');
  }
  const result = { ok: true, checked: 0, reinstalled: [], skipped: [], failed: [] };
  let entries;
  try {
    entries = await registry.list();
  } catch (error) {
    result.ok = false;
    result.error = String((error && error.message) || error);
    return result;
  }
  if (!Array.isArray(entries) || entries.length === 0) return result;

  let installed = new Set();
  try {
    const listed = await listPackages();
    const packages = Array.isArray(listed && listed.packages) ? listed.packages : [];
    installed = new Set(packages.map((item) => String(item && item.packageName || '')).filter(Boolean));
  } catch (error) {
    result.ok = false;
    result.error = `could not list packages: ${String((error && error.message) || error)}`;
    return result;
  }

  for (const entry of entries) {
    result.checked += 1;
    const packageName = entry && entry.packageName ? String(entry.packageName) : null;
    if (packageName && installed.has(packageName)) {
      result.skipped.push({ packageName, reason: 'installed' });
      continue;
    }
    const apkPath = entry && entry.apkPath ? String(entry.apkPath) : '';
    if (!apkPath || !fileExists(apkPath)) {
      result.skipped.push({ packageName, apkPath: apkPath || null, reason: 'apk-missing' });
      continue;
    }
    try {
      const meta = await installApk(apkPath);
      const installedPackage = String((meta && meta.packageName) || packageName || '');
      if (installedPackage) installed.add(installedPackage);
      result.reinstalled.push({
        packageName: installedPackage || packageName,
        label: (meta && meta.label) || entry.label || null,
        apkPath,
        instanceId: entry.instanceId || 'default',
      });
    } catch (error) {
      result.failed.push({
        packageName,
        apkPath,
        error: String((error && error.message) || error),
      });
    }
  }
  return result;
}

/**
 * One-line human summary for logs/activity entries.
 *
 * @param {{ reinstalled?: any[], failed?: any[], skipped?: any[] }} result
 * @returns {string}
 */
export function summarizeReinstallResult(result) {
  const reinstalled = Array.isArray(result && result.reinstalled) ? result.reinstalled : [];
  const failed = Array.isArray(result && result.failed) ? result.failed : [];
  const skipped = Array.isArray(result && result.skipped) ? result.skipped : [];
  const names = (items) => items
    .map((item) => (item && (item.packageName || item.apkPath)) || 'unknown')
    .filter(Boolean)
    .slice(0, 5)
    .join(', ');
  const parts = [];
  if (reinstalled.length) parts.push(`reinstalled ${reinstalled.length} app(s): ${names(reinstalled)}`);
  if (failed.length) parts.push(`${failed.length} failed: ${names(failed)}`);
  if (!reinstalled.length && !failed.length) {
    parts.push(skipped.length ? `nothing to reinstall (${skipped.length} skipped)` : 'nothing to reinstall');
  }
  return parts.join('; ');
}
