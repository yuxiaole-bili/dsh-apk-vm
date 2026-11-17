/**
 * Host memory guard + VM hardware profiles ("Lite mode").
 *
 * Every local AVD boots a full qemu/GPU stack, so a 16 GB Windows host that
 * runs the default VM plus two extra previews can start paging badly. This
 * module is intentionally pure/self-contained (node:os only) so the plugin can
 * decide *before* spawning an emulator how many local VMs fit, and which
 * hardware profile (standard vs lite) an extra instance should use.
 *
 * All helpers accept injectable inputs (host memory numbers instead of reading
 * node:os) so they can be unit-tested hermetically.
 */
import os from 'node:os';

export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;
export const KIB = 1024;

/** Leave this much host memory for Windows, DSH, the browser and the GPU driver. */
export const DEFAULT_HOST_RESERVE_BYTES = 4 * GIB;
/** Worst-case host RAM a running local AVD (1536 MB guest + qemu/GPU overhead) takes. */
export const DEFAULT_ESTIMATED_VM_BYTES = 3 * GIB;
/** Hard minimum free memory below which we never start another VM. */
export const DEFAULT_HOST_MIN_FREE_BYTES = 1.5 * GIB;

/**
 * Hardware profiles applied to an AVD before it boots.
 * `null` means "keep the existing AVD value / plugin default" (standard mode
 * therefore never rewrites RAM, CPU count, GPU or scrcpy limits).
 */
export const VM_PRESETS = Object.freeze({
  standard: Object.freeze({
    ramSizeMb: null,
    cores: null,
    gpuMode: null,
    frameFps: null,
    scrcpyMaxSize: null,
    scrcpyMaxFps: null,
  }),
  lite: Object.freeze({
    ramSizeMb: 1024,
    cores: 2,
    gpuMode: 'swiftshader_indirect',
    frameFps: 1,
    scrcpyMaxSize: 720,
    scrcpyMaxFps: 30,
  }),
});

const PRESET_FIELDS = Object.freeze([
  'ramSizeMb',
  'cores',
  'gpuMode',
  'frameFps',
  'scrcpyMaxSize',
  'scrcpyMaxFps',
]);

const PRESET_NUMBER_RANGES = Object.freeze({
  ramSizeMb: [256, 8192],
  cores: [1, 16],
  frameFps: [1, 10],
  scrcpyMaxSize: [480, 1920],
  scrcpyMaxFps: [15, 60],
});

/**
 * Human readable byte count, e.g. "12.3 GB", "512 MB". Invalid input -> "n/a".
 * @param {number} bytes
 * @returns {string}
 */
export function formatMemory(bytes) {
  if (bytes === null || bytes === undefined || typeof bytes === 'boolean') return 'n/a';
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'n/a';
  const pretty = (scaled) => {
    const rounded = Math.round(scaled * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  };
  if (value >= GIB) return `${pretty(value / GIB)} GB`;
  if (value >= MIB) return `${Math.round(value / MIB)} MB`;
  if (value >= KIB) return `${Math.round(value / KIB)} KB`;
  return `${Math.round(value)} B`;
}

function invalidMemoryNumber(name, value) {
  return new TypeError(`invalid host memory: ${name} must be a finite positive number, got ${JSON.stringify(value)}`);
}

/**
 * Read the host total/free memory (or use injected numbers in tests).
 * @param {{totalmem?: number, freemem?: number}} [options]
 * @returns {{ok: true, totalBytes: number, freeBytes: number, totalMb: number, freeMb: number}
 *   | {ok: false, error: string}}
 */
export function hostMemoryInfo({ totalmem, freemem } = {}) {
  let totalBytes;
  let freeBytes;
  try {
    totalBytes = totalmem === undefined ? os.totalmem() : totalmem;
    freeBytes = freemem === undefined ? os.freemem() : freemem;
  } catch (error) {
    return { ok: false, error: `host memory unavailable: ${error && error.message ? error.message : error}` };
  }
  const total = Number(totalBytes);
  const free = Number(freeBytes);
  if (!Number.isFinite(total) || total <= 0) return { ok: false, error: invalidMemoryNumber('totalmem', totalBytes).message };
  if (!Number.isFinite(free) || free <= 0) return { ok: false, error: invalidMemoryNumber('freemem', freeBytes).message };
  return {
    ok: true,
    totalBytes: Math.round(total),
    freeBytes: Math.round(free),
    totalMb: Math.round(total / MIB),
    freeMb: Math.round(free / MIB),
  };
}

function hostMemoryKnown(hostMemory) {
  if (!hostMemory || typeof hostMemory !== 'object') return false;
  if (hostMemory.ok === false) return false;
  const total = Number(hostMemory.totalBytes);
  return Number.isFinite(total) && total > 0;
}

function positiveOrFallback(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

/**
 * Effective local-instance cap for this host.
 *
 * Formula: max(1, min(requested, floor((totalBytes - reservedBytes) / estimatedVmBytes))),
 * clamped to 1..8. Unknown host memory is NOT a reason to block instances: the
 * requested value is returned unchanged (limited: false) so the plugin keeps
 * working on exotic platforms.
 *
 * @param {{requested?: number, hostMemory?: object, reservedBytes?: number, estimatedVmBytes?: number}} [options]
 * @returns {{maxInstances: number, requested: number, limited: boolean, reason: string}}
 */
export function effectiveMaxInstances({
  requested = 3,
  hostMemory,
  reservedBytes = DEFAULT_HOST_RESERVE_BYTES,
  estimatedVmBytes = DEFAULT_ESTIMATED_VM_BYTES,
} = {}) {
  const rawRequested = Number(requested);
  const requestedCount = Number.isFinite(rawRequested)
    ? Math.max(1, Math.min(8, Math.floor(rawRequested)))
    : 3;
  const reserve = positiveOrFallback(reservedBytes, DEFAULT_HOST_RESERVE_BYTES);
  const estimate = positiveOrFallback(estimatedVmBytes, DEFAULT_ESTIMATED_VM_BYTES);
  if (!hostMemoryKnown(hostMemory)) {
    return { maxInstances: requestedCount, requested: requestedCount, limited: false, reason: 'host memory unknown' };
  }
  const total = Number(hostMemory.totalBytes);
  const availableBytes = total - reserve;
  const fit = availableBytes > 0 ? Math.floor(availableBytes / estimate) : 0;
  const budgetCap = Math.max(1, fit);
  const maxInstances = Math.max(1, Math.min(requestedCount, budgetCap, 8));
  const limited = maxInstances < requestedCount;
  const reason = limited
    ? `host memory allows ${maxInstances} of ${requestedCount} requested local VM(s): ${formatMemory(total)} total, ${formatMemory(reserve)} reserved, ${formatMemory(estimate)} per VM`
    : `host memory allows ${requestedCount} requested local VM(s): ${formatMemory(total)} total, ${formatMemory(reserve)} reserved, ${formatMemory(estimate)} per VM`;
  return { maxInstances, requested: requestedCount, limited, reason };
}

/**
 * Can one more local VM be started right now, given current free host memory?
 *
 * Requires `freeBytes - reservedBytes >= estimatedVmBytes`. Unknown host memory
 * is treated as "allowed" (conservative in the small sense: never blocks).
 *
 * @param {{hostMemory?: object, runningCount?: number, estimatedVmBytes?: number, reservedBytes?: number}} [options]
 * @returns {{ok: boolean, freeBytes: number|null, requiredBytes: number|null, reason: string}}
 */
export function canStartInstance({
  hostMemory,
  runningCount = 0,
  estimatedVmBytes = DEFAULT_ESTIMATED_VM_BYTES,
  reservedBytes = DEFAULT_HOST_RESERVE_BYTES,
} = {}) {
  if (!hostMemoryKnown(hostMemory)) {
    return { ok: true, freeBytes: null, requiredBytes: null, reason: 'host memory unknown' };
  }
  const freeBytes = Number(hostMemory.freeBytes);
  const reserve = positiveOrFallback(reservedBytes, DEFAULT_HOST_RESERVE_BYTES);
  const estimate = positiveOrFallback(estimatedVmBytes, DEFAULT_ESTIMATED_VM_BYTES);
  const requiredBytes = reserve + estimate;
  const running = Number.isFinite(Number(runningCount)) ? Math.max(0, Math.floor(Number(runningCount))) : 0;
  if (freeBytes - reserve >= estimate) {
    return {
      ok: true,
      freeBytes,
      requiredBytes,
      reason: `enough free host memory (${formatMemory(freeBytes)} free, ${formatMemory(requiredBytes)} required for ${running} running local VM(s) + one more)`,
    };
  }
  return {
    ok: false,
    freeBytes,
    requiredBytes,
    reason: `not enough free host memory: need ${formatMemory(requiredBytes)} free (${formatMemory(reserve)} reserved + ${formatMemory(estimate)} per VM), only ${formatMemory(freeBytes)} free with ${running} running local VM(s); stop idle instances or lower maxInstances`,
  };
}

function presetTypeError(field, expected, value) {
  return new TypeError(`invalid VM preset field "${field}": expected ${expected}, got ${JSON.stringify(value)}`);
}

function normalizePresetValue(field, value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (field === 'gpuMode') {
    if (typeof value !== 'string' || !value.trim()) {
      throw presetTypeError(field, 'a non-empty string (or null)', value);
    }
    return value.trim();
  }
  const range = PRESET_NUMBER_RANGES[field];
  const number = Number(value);
  if (!Number.isFinite(number)) throw presetTypeError(field, `a number between ${range[0]} and ${range[1]} (or null)`, value);
  if (!Number.isInteger(number) || number < range[0] || number > range[1]) {
    throw presetTypeError(field, `an integer between ${range[0]} and ${range[1]} (or null)`, value);
  }
  return number;
}

/**
 * Resolve a VM profile from a preset name and/or an object of overrides.
 *
 * Accepts `'standard'`, `'lite'`, `undefined`, or an object of profile fields;
 * extra `overrides` always win. Returns a fresh object (never a shared preset).
 * Invalid field values throw a TypeError naming the field; unknown preset names
 * throw a TypeError. Callers that must not fail (e.g. plugin startup) should
 * catch and fall back to `'standard'`.
 *
 * @param {string|object|null|undefined} nameOrObject
 * @param {object} [overrides]
 * @returns {{name: string, ramSizeMb: number|null, cores: number|null, gpuMode: string|null, frameFps: number|null, scrcpyMaxSize: number|null, scrcpyMaxFps: number|null}}
 */
export function resolveVmPreset(nameOrObject = 'standard', overrides = {}) {
  let name;
  let base;
  const fields = {};
  if (nameOrObject !== null && typeof nameOrObject === 'object') {
    if (Array.isArray(nameOrObject)) throw new TypeError('VM preset must be a name or an object, not an array');
    name = typeof nameOrObject.name === 'string' && nameOrObject.name.trim() ? nameOrObject.name.trim() : 'custom';
    base = VM_PRESETS.standard;
    for (const field of PRESET_FIELDS) {
      const normalized = normalizePresetValue(field, nameOrObject[field]);
      if (normalized !== undefined) fields[field] = normalized;
    }
  } else {
    const key = nameOrObject === undefined || nameOrObject === null || nameOrObject === ''
      ? 'standard'
      : String(nameOrObject).trim().toLowerCase();
    base = VM_PRESETS[key];
    if (!base) throw new TypeError(`unknown VM preset: ${JSON.stringify(nameOrObject)}`);
    name = key;
  }
  if (overrides !== undefined && overrides !== null) {
    if (typeof overrides !== 'object' || Array.isArray(overrides)) {
      throw new TypeError('VM preset overrides must be an object');
    }
    for (const field of PRESET_FIELDS) {
      const normalized = normalizePresetValue(field, overrides[field]);
      if (normalized !== undefined) fields[field] = normalized;
    }
  }
  return { name, ...base, ...fields };
}
