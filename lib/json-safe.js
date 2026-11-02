/**
 * JSON-safe conversion for values crossing the Agent tool boundary.
 *
 * DSH rejects tool results that do not survive a lossless JSON round-trip.
 * Android diagnostics commonly contain `undefined`, `NaN`, BigInt, Buffers or
 * cycles; convert those into explicit JSON values instead of failing the whole
 * action. The original value is never mutated.
 */

export function losslessJson(value, seen = new WeakSet()) {
  if (value === undefined) return null;
  if (value === null) return value;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'bigint') return value.toString();
  if (type === 'function' || type === 'symbol') return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { type: 'bytes', length: value.length };
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code || null };
  }
  if (type !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => losslessJson(item, seen));
    seen.delete(value);
    return result;
  }
  const result = {};
  for (const key of Object.keys(value)) {
    result[key] = losslessJson(value[key], seen);
  }
  seen.delete(value);
  return result;
}
