/**
 * Tiny JSON store for VM ownership leases.
 *
 * The lease book lives in memory (it has to: every tool call and every panel
 * poll asks it a question), but a DSH/plugin restart must not silently drop a
 * conversation's dedicated VM. The store persists a compact snapshot to
 * `<profile>/.apk-vm/leases.json` after every claim/touch/release and restores
 * it on startup. Writes are synchronous and atomic (tmp file + rename): the
 * file is tiny, and losing it would re-open the takeover races this feature
 * exists to prevent.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const LEASE_STORE_VERSION = 1;

export function leaseStorePath(stateDir) {
  return path.join(String(stateDir || ''), 'leases.json');
}

/** Load the persisted lease list. Corrupt/missing files mean "no leases". */
export function loadLeaseStore(file) {
  if (!file) return [];
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const entries = Array.isArray(raw)
    ? raw
    : raw && Array.isArray(raw.leases)
      ? raw.leases
      : [];
  return entries.filter((entry) =>
    entry &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    typeof entry.id === 'string' &&
    entry.id &&
    typeof entry.key === 'string' &&
    entry.key
  );
}

/**
 * Persist a lease snapshot. Returns false instead of throwing: a read-only
 * profile directory must degrade to "dedicated VMs last until restart", never
 * break the VM manager.
 */
export function saveLeaseStore(file, entries) {
  if (!file) return false;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const payload = {
      version: LEASE_STORE_VERSION,
      savedAt: new Date().toISOString(),
      leases: Array.isArray(entries) ? entries : [],
    };
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
