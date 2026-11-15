/**
 * Persistent, human-friendly display names for APK VM instances.
 *
 * Instance ids stay stable and URL-safe (`default`, `frontend`, `remote-…`);
 * the display name is what the panel and agents show. Names live next to the
 * other plugin state (`<dataDir>/.apk-vm/instance-names.json`) so they survive
 * DSH restarts, plugin upgrades and AVD recreation.
 */
import { readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const INSTANCE_NAMES_VERSION = 1;
export const MAX_INSTANCE_NAME_LENGTH = 48;
const DEFAULT_MAX_NAMES = 200;

/** Trim and flatten a user-supplied name; returns '' when nothing is usable. */
export function sanitizeDisplayName(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_INSTANCE_NAME_LENGTH);
}

export function defaultInstanceNamesPath(dataDir) {
  return path.join(String(dataDir || process.cwd()), '.apk-vm', 'instance-names.json');
}

/** In-memory view of the name map, persisted with atomic rename writes. */
export class InstanceNameBook {
  constructor({ file = null, maxEntries = DEFAULT_MAX_NAMES } = {}) {
    this.file = file ? String(file) : null;
    this.maxEntries = Math.max(1, Number(maxEntries) || DEFAULT_MAX_NAMES);
    this._names = new Map();
    this._loaded = false;
  }

  _load() {
    if (this._loaded) return;
    this._loaded = true;
    if (!this.file) return;
    try {
      const raw = readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
      const entries = parsed && typeof parsed === 'object'
        ? parsed.version === INSTANCE_NAMES_VERSION && parsed.names && typeof parsed.names === 'object'
          ? parsed.names
          : parsed.names && typeof parsed.names === 'object'
            ? parsed.names
            : parsed
        : {};
      for (const [id, value] of Object.entries(entries)) {
        const name = sanitizeDisplayName(value);
        const key = String(id || '').trim();
        if (!key || !name) continue;
        this._names.set(key, name);
        if (this._names.size >= this.maxEntries) break;
      }
    } catch {
      /* a missing or corrupt file simply starts empty */
    }
  }

  /** Current display name for an id, or '' when none was set. */
  get(id) {
    this._load();
    const key = String(id || '').trim();
    return key ? this._names.get(key) || '' : '';
  }

  /** Id → display-name snapshot (for diagnostics/tests). */
  list() {
    this._load();
    return Object.fromEntries(this._names);
  }

  _snapshot() {
    this._load();
    return Object.fromEntries(this._names);
  }

  async _persist() {
    if (!this.file) return { ok: true };
    const dir = path.dirname(this.file);
    const text = JSON.stringify(
      { version: INSTANCE_NAMES_VERSION, names: this._snapshot() },
      null,
      2
    ) + '\n';
    try {
      await fsp.mkdir(dir, { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
      await fsp.writeFile(tmp, text, 'utf8');
      await fsp.rename(tmp, this.file);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `could not persist instance names: ${error && error.message ? error.message : error}` };
    }
  }

  async set(id, name) {
    const key = String(id || '').trim();
    const clean = sanitizeDisplayName(name);
    if (!key) return { ok: false, error: 'instance id is required' };
    if (!clean) return { ok: false, error: 'name is required' };
    this._load();
    this._names.set(key, clean);
    if (this._names.size > this.maxEntries) {
      const oldest = this._names.keys().next().value;
      if (oldest && oldest !== key) this._names.delete(oldest);
    }
    const saved = await this._persist();
    if (!saved.ok) return saved;
    return { ok: true, id: key, name: clean };
  }

  async delete(id) {
    this._load();
    const key = String(id || '').trim();
    if (!key || !this._names.has(key)) return { ok: true, removed: false };
    this._names.delete(key);
    const saved = await this._persist();
    if (!saved.ok) return saved;
    return { ok: true, removed: true };
  }
}
