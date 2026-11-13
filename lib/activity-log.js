/**
 * Agent activity log.
 *
 * Append-only record of what the agent did through the apk_vm tool (and, in
 * the future, the panel's own HTTP actions): one JSON object per line in
 * `<rootDir>/activity.jsonl`, plus PNG screenshots in
 * `<rootDir>/screenshots/<entryId>.png`.
 *
 * The log is deliberately dumb and defensive:
 *   - record() never throws and never rejects, even when the disk is read-only;
 *   - every entry is JSON-safe (losslessJson) and has obvious secrets redacted;
 *   - long strings are truncated to maxStringBytes;
 *   - reads tolerate a corrupt JSONL line (it is skipped) and writes rewrite the
 *     file compactly once pruning kicks in;
 *   - the log is a ring: it keeps at most maxEntries entries and maxBytes bytes
 *     (journal + screenshots), dropping the oldest entries and their shots.
 *
 * Typical wiring from index.js:
 *   import { ActivityLog } from './lib/activity-log.js';
 *   const activityLog = new ActivityLog({ dataDir: rootsFor()[0] || process.cwd() });
 *   await activityLog.record({ action: 'shell', source: 'tool', instanceId: 'default', ... });
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { losslessJson } from './json-safe.js';

export const ACTIVITY_SOURCES = Object.freeze(['tool', 'http', 'system']);
export const DEFAULT_MAX_ENTRIES = 1000;
export const DEFAULT_MAX_BYTES = 250 * 1024 * 1024;
export const DEFAULT_MAX_STRING_BYTES = 2048;

const SHOT_MEDIA_TYPE = 'image/png';
const SHOT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SECRET_KEY_RE =
  /pass(word|wd)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|session[-_]?id/i;
const BEARER_RE = /((?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const ASSIGNMENT_RE =
  /((?:password|passwd|token|secret|api[-_]?key|authorization|cookie|credential)\s*[=:]\s*)(["']?)([^\s"',;]{3,})\2/gi;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const MAX_DEPTH = 12;

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function truncate(value, maxChars) {
  const text = String(value == null ? '' : value);
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return text;
  if (limit <= 1) return text.slice(0, limit);
  return `${text.slice(0, limit - 1)}…`;
}

function redactText(value, maxChars) {
  const text = String(value == null ? '' : value)
    .replace(PRIVATE_KEY_RE, '[redacted private key]')
    .replace(BEARER_RE, '$1[redacted]')
    .replace(ASSIGNMENT_RE, '$1$2[redacted]$2');
  return truncate(text, maxChars);
}

function sanitizeInner(value, maxChars, depth) {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (typeof value === 'string') return redactText(value, maxChars);
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizeInner(item, maxChars, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out = {};
    let keys = 0;
    for (const key of Object.keys(value)) {
      if (keys >= 200) break;
      keys += 1;
      out[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : sanitizeInner(value[key], maxChars, depth + 1);
    }
    return out;
  }
  return value;
}

function sanitizeValue(value, maxChars) {
  return sanitizeInner(losslessJson(value), maxChars, 0);
}

function safeStringify(value, maxChars) {
  try {
    const json = JSON.stringify(sanitizeValue(value, maxChars));
    return json === undefined ? null : truncate(json, maxChars);
  } catch {
    return null;
  }
}

function argsPreviewString(value, maxChars) {
  if (value == null) return null;
  if (typeof value === 'string') return redactText(value, maxChars);
  return safeStringify(value, maxChars);
}

function cleanId(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return SHOT_ID_RE.test(text) ? text : null;
}

function isoAt(value) {
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function isValidEntry(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 256 &&
    typeof value.at === 'string' &&
    typeof value.action === 'string' &&
    typeof value.source === 'string' &&
    typeof value.instanceId === 'string' &&
    typeof value.ok === 'boolean'
  );
}

function lineBytes(entry) {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
}

/**
 * Default log root for a data directory: `<dataDir>/.apk-vm/activity`.
 * Falls back to the user's home directory when dataDir is missing.
 */
export function defaultActivityLogRoot(dataDir) {
  const trimmed = typeof dataDir === 'string' ? dataDir.trim() : '';
  const base = trimmed ? path.resolve(trimmed) : os.homedir();
  return path.join(base, '.apk-vm', 'activity');
}

export class ActivityLog {
  /**
   * @param {object} [options]
   * @param {string} [options.rootDir] absolute log root (wins over dataDir)
   * @param {string} [options.dataDir] data directory, default root is `<dataDir>/.apk-vm/activity`
   * @param {number} [options.maxEntries] ring size in entries (default 1000)
   * @param {number} [options.maxBytes] ring size in bytes, journal + shots (default 250MB)
   * @param {number} [options.maxStringBytes] per-string truncation limit (default 2048)
   */
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const explicitRoot = typeof opts.rootDir === 'string' && opts.rootDir.trim()
      ? path.resolve(opts.rootDir.trim())
      : null;
    this.rootDir = explicitRoot || defaultActivityLogRoot(opts.dataDir);
    this.file = path.join(this.rootDir, 'activity.jsonl');
    this.shotsDir = path.join(this.rootDir, 'screenshots');
    this.maxEntries = clampInt(opts.maxEntries, DEFAULT_MAX_ENTRIES, 1, 100000);
    this.maxBytes = clampInt(opts.maxBytes, DEFAULT_MAX_BYTES, 1, Number.MAX_SAFE_INTEGER);
    this.maxStringBytes = clampInt(opts.maxStringBytes, DEFAULT_MAX_STRING_BYTES, 64, 1024 * 1024);
    this._seq = 0;
    this._queue = Promise.resolve();
  }

  /**
   * Append one activity entry. Resolves with the stored entry; never throws.
   * A PNG can be attached as `entry.shot` (Buffer / Uint8Array) and is written
   * to screenshots/<id>.png, setting shotId.
   */
  async record(entry) {
    const shotBuffer = this._shotBuffer(entry);
    let normalized;
    try {
      normalized = this._normalize(entry);
    } catch {
      normalized = this._normalize(null);
    }
    try {
      return await this._enqueue(() => this._persist(normalized, shotBuffer));
    } catch {
      return normalized;
    }
  }

  /**
   * Newest-first page of entries plus ring statistics.
   * @param {object} [options] {limit, beforeId, action, instanceId, source, ok}
   */
  async list(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const limit = clampInt(opts.limit, 100, 1, 1000);
    const snapshot = await this._load();
    let entries = snapshot.entries;
    if (typeof opts.beforeId === 'string' && opts.beforeId) {
      const index = entries.findIndex((candidate) => candidate.id === opts.beforeId);
      entries = index > 0 ? entries.slice(0, index) : [];
    }
    let newestFirst = entries.slice().reverse();
    if (typeof opts.action === 'string' && opts.action) {
      newestFirst = newestFirst.filter((candidate) => candidate.action === opts.action);
    }
    if (typeof opts.instanceId === 'string' && opts.instanceId) {
      newestFirst = newestFirst.filter((candidate) => candidate.instanceId === opts.instanceId);
    }
    if (typeof opts.source === 'string' && opts.source) {
      newestFirst = newestFirst.filter((candidate) => candidate.source === opts.source);
    }
    if (typeof opts.ok === 'boolean') {
      newestFirst = newestFirst.filter((candidate) => candidate.ok === opts.ok);
    }
    const page = newestFirst.slice(0, limit);
    const nextId = newestFirst.length > limit && page.length > 0 ? page[page.length - 1].id : null;
    return { entries: page, nextId, stats: this._statsFrom(snapshot) };
  }

  /** One entry by id, or null. */
  async get(id) {
    const wanted = cleanId(id);
    if (!wanted) return null;
    const snapshot = await this._load();
    return snapshot.entries.find((candidate) => candidate.id === wanted) || null;
  }

  /** Screenshot for an entry: {buffer, mediaType} or null. */
  async shot(id) {
    const wanted = cleanId(id);
    if (!wanted) return null;
    try {
      const buffer = await fsp.readFile(path.join(this.shotsDir, `${wanted}.png`));
      return { buffer, mediaType: SHOT_MEDIA_TYPE };
    } catch {
      return null;
    }
  }

  /** Delete every entry and screenshot. */
  async clear() {
    return this._enqueue(async () => {
      const snapshot = await this._load();
      for (const file of snapshot.shotFiles) {
        try {
          await fsp.unlink(file.path);
        } catch {
          /* ignore */
        }
      }
      try {
        await fsp.rm(this.shotsDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        await fsp.unlink(this.file);
      } catch {
        /* ignore */
      }
      return { ok: true, removedEntries: snapshot.entries.length, removedShots: snapshot.shotFiles.length };
    });
  }

  /** {count, bytes, shots, oldest, newest} for the whole ring. */
  async stats() {
    return this._statsFrom(await this._load());
  }

  // ---------------------------------------------------------------------
  // internals

  _shotPath(id) {
    return path.join(this.shotsDir, `${id}.png`);
  }

  _shotBuffer(entry) {
    if (!entry || typeof entry !== 'object') return null;
    for (const key of ['shot', 'shotBuffer', 'screenshot']) {
      const value = entry[key];
      if (Buffer.isBuffer(value)) return value.length > 0 ? value : null;
      if (value instanceof Uint8Array) return value.length > 0 ? Buffer.from(value) : null;
    }
    return null;
  }

  _nextId() {
    const stamp = Date.now().toString(36);
    const seq = (this._seq++ % 46656).toString(36).padStart(3, '0');
    return `${stamp}-${seq}-${randomBytes(3).toString('hex')}`;
  }

  _normalize(entry) {
    const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
    const id = cleanId(source.id) || this._nextId();
    const action = typeof source.action === 'string' && source.action.trim()
      ? redactText(source.action.trim(), 100)
      : 'unknown';
    const instanceId = source.instanceId != null && String(source.instanceId).trim()
      ? redactText(String(source.instanceId).trim(), 200)
      : 'default';
    const tool = source.tool != null && String(source.tool).trim()
      ? redactText(String(source.tool).trim(), 100)
      : null;
    let summary = null;
    if (source.summary != null) {
      summary = typeof source.summary === 'string'
        ? redactText(source.summary, this.maxStringBytes)
        : safeStringify(source.summary, this.maxStringBytes);
    }
    let error = null;
    if (source.error != null) {
      if (source.error instanceof Error) {
        error = redactText(source.error.message || source.error.name || 'error', this.maxStringBytes);
      } else if (typeof source.error === 'string') {
        error = redactText(source.error, this.maxStringBytes);
      } else {
        error = safeStringify(source.error, this.maxStringBytes);
      }
    }
    const normalized = {
      id,
      at: isoAt(source.at),
      action,
      source: ACTIVITY_SOURCES.includes(source.source) ? source.source : 'tool',
      instanceId,
      tool,
      summary,
      ok: source.ok !== false,
      error,
      durationMs:
        Number.isFinite(source.durationMs) && source.durationMs >= 0
          ? Math.round(source.durationMs)
          : null,
      argsPreview: argsPreviewString(source.argsPreview != null ? source.argsPreview : source.args, this.maxStringBytes),
      shotId: cleanId(source.shotId),
    };
    return normalized;
  }

  _enqueue(task) {
    const run = this._queue.then(task, task);
    this._queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async _persist(entry, shotBuffer) {
    const stored = { ...entry };
    try {
      await fsp.mkdir(this.shotsDir, { recursive: true });
    } catch {
      /* append below will fail too; the caller still gets an entry */
    }
    if (shotBuffer) {
      try {
        await fsp.writeFile(this._shotPath(entry.id), shotBuffer);
        stored.shotId = entry.id;
      } catch {
        stored.shotId = entry.shotId || null;
      }
    }
    try {
      await fsp.appendFile(this.file, `${JSON.stringify(stored)}\n`, 'utf8');
    } catch {
      return stored;
    }
    try {
      await this._prune();
    } catch {
      /* pruning is best effort */
    }
    return stored;
  }

  async _load() {
    let raw = '';
    try {
      raw = await fsp.readFile(this.file, 'utf8');
    } catch {
      raw = '';
    }
    const entries = [];
    let lines = 0;
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (!text) continue;
      lines += 1;
      try {
        const parsed = JSON.parse(text);
        if (isValidEntry(parsed)) entries.push(parsed);
      } catch {
        /* tolerate corrupt lines */
      }
    }
    const shotFiles = await this._shotFiles();
    const shotsBytes = shotFiles.reduce((total, file) => total + file.size, 0);
    return {
      entries,
      lines,
      fileBytes: Buffer.byteLength(raw, 'utf8'),
      shotFiles,
      shotsBytes,
      dirty: lines !== entries.length,
    };
  }

  async _shotFiles() {
    let names = [];
    try {
      names = await fsp.readdir(this.shotsDir);
    } catch {
      return [];
    }
    const files = [];
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.png')) continue;
      const full = path.join(this.shotsDir, name);
      try {
        const stat = await fsp.stat(full);
        if (stat.isFile()) files.push({ name, path: full, size: stat.size });
      } catch {
        /* ignore */
      }
    }
    return files;
  }

  _statsFrom(snapshot) {
    const entries = snapshot.entries;
    return {
      count: entries.length,
      bytes: snapshot.fileBytes + snapshot.shotsBytes,
      shots: snapshot.shotFiles.length,
      oldest: entries.length > 0 ? entries[0].at : null,
      newest: entries.length > 0 ? entries[entries.length - 1].at : null,
    };
  }

  async _prune() {
    const snapshot = await this._load();
    const entries = snapshot.entries;
    const shotSizes = new Map(snapshot.shotFiles.map((file) => [file.name, file.size]));
    let keep = entries.length;
    let bytes = snapshot.fileBytes + snapshot.shotsBytes;
    while (keep > 1 && (keep > this.maxEntries || bytes > this.maxBytes)) {
      const entry = entries[entries.length - keep];
      bytes -= lineBytes(entry);
      const shotName = entry.shotId ? `${entry.shotId}.png` : null;
      if (shotName && shotSizes.has(shotName)) bytes -= shotSizes.get(shotName);
      keep -= 1;
    }
    const kept = entries.slice(entries.length - keep);
    if (keep < entries.length || snapshot.dirty) {
      await this._rewrite(kept);
    }
    const usedShots = new Set(kept.filter((entry) => entry.shotId).map((entry) => `${entry.shotId}.png`));
    for (const file of snapshot.shotFiles) {
      if (usedShots.has(file.name)) continue;
      try {
        await fsp.unlink(file.path);
      } catch {
        /* ignore */
      }
    }
  }

  async _rewrite(entries) {
    const text = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, this.file);
  }
}

export default ActivityLog;
