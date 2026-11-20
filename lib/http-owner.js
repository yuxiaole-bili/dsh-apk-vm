/**
 * Parse owner identity from HTTP headers/query and decide whether a mutating
 * request may touch a VM. Pure helpers: the caller owns the HTTP response and
 * the InstanceManager lease book.
 */

import { OWNER_ROLE, normalizeRole, shortKey } from './vm-ownership.js';

const HEADER_NAMES = [
  ['key', 'x-apk-vm-owner'],
  ['scope', 'x-apk-vm-scope'],
  ['sessionId', 'x-apk-vm-session'],
  ['workspace', 'x-apk-vm-workspace'],
  ['label', 'x-apk-vm-label'],
  ['role', 'x-apk-vm-role'],
];

/** Explicit takeover marker used by the local panel and by HTTP clients. */
export const TAKEOVER_HEADER = 'x-apk-vm-takeover';

function decodeHeaderValue(value) {
  const text = String(value);
  if (!/%[0-9A-Fa-f]{2}/.test(text)) return text;
  try {
    return decodeURIComponent(text);
  } catch (error) {
    return text;
  }
}

function firstValue(headers, query, header) {
  const source = headers || {};
  const direct = source[header];
  if (direct !== undefined && direct !== null) {
    if (Array.isArray(direct)) return decodeHeaderValue(String(direct[0] || '').trim());
    return decodeHeaderValue(String(direct).trim());
  }
  if (query && typeof query.get === 'function') {
    const fromQuery = query.get(header.replace(/^x-apk-vm-/, ''));
    if (fromQuery !== undefined && fromQuery !== null) return decodeHeaderValue(String(fromQuery).trim());
  }
  return '';
}

/** Extract a normalized owner request, or null when the caller sends no key. */
export function ownerFromHttp(headers, query) {
  const key = firstValue(headers, query, 'x-apk-vm-owner');
  if (!key) return null;
  return {
    key,
    scope: firstValue(headers, query, 'x-apk-vm-scope') || 'shared',
    sessionId: firstValue(headers, query, 'x-apk-vm-session') || null,
    workspace: firstValue(headers, query, 'x-apk-vm-workspace') || null,
    label: firstValue(headers, query, 'x-apk-vm-label') || key,
    role: normalizeRole(firstValue(headers, query, 'x-apk-vm-role')),
    source: 'http',
  };
}

/** True when the request carries an explicit takeover marker. */
export function takeoverFromHttp(headers, query) {
  const raw = firstValue(headers, query, TAKEOVER_HEADER).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Describe a lease for a 409 response. Reserved/dedicated leases include the
 * owner short id and the reservation deadline so the conflict is actionable.
 */
function describeLeaseConflict(lease, id) {
  const label = (lease && (lease.label || lease.key)) || 'another owner';
  const key = lease && lease.key ? String(lease.key) : '';
  const short = key ? ` (${shortKey(key, 16)})` : '';
  const reservedUntil = lease && Number(lease.reservedUntil) > 0 ? Number(lease.reservedUntil) : null;
  if (reservedUntil) {
    const until = new Date(reservedUntil).toISOString().replace('.000Z', 'Z');
    return {
      text: `VM ${id} is reserved by ${label}${short} until ${until}`,
      reserved: true,
      reservedUntil,
    };
  }
  return { text: `VM ${id} is in use by ${label}${short}`, reserved: false, reservedUntil: null };
}

/**
 * Compare an incoming owner with the current lease; never mutate state.
 *
 * `options.mutating` marks operations that change a VM (start/stop/tap/...)
 * rather than read-only queries. `options.takeover` is the explicit takeover
 * opt-in (`x-apk-vm-takeover: 1`). The local panel is a human administrator:
 * it may run read-only queries on any VM without stealing the lease, but a
 * mutating request against a lease owned by someone else requires an explicit
 * takeover (409 `vm-takeover-required`).
 */
export function checkOwnerAccess(lease, incoming, instanceId = 'default', options = {}) {
  const id = String(instanceId || 'default');
  const mutating = options.mutating === true;
  const takeover = options.takeover === true;
  // Lock policy: 'all' (default) blocks every other mutating client, 'agents'
  // blocks other agents but lets the local panel/admin operate, 'off' treats
  // the lock as advisory only (no enforcement).
  const lockMode = options.lockMode === 'agents' || options.lockMode === 'off' ? options.lockMode : 'all';
  const isAdmin = Boolean(incoming && normalizeRole(incoming.role) === OWNER_ROLE.ADMIN);
  // A lock is a hard block: even an admin takeover cannot control a locked VM
  // (unless the operator chose the 'agents' policy, where the human panel is exempt).
  if (lease && lease.locked === true && lockMode !== 'off') {
    const sameOwner = Boolean(incoming && incoming.key === lease.key);
    if (!mutating) {
      return { ok: true, admin: isAdmin, autoClaim: false, touch: false, locked: true, lockOwner: lease };
    }
    if (sameOwner) {
      return { ok: true, autoClaim: false, touch: true, locked: true };
    }
    if (lockMode === 'agents' && isAdmin) {
      // The local panel is the human operator: 'agents' locks are for agents.
      return { ok: true, admin: true, autoClaim: false, touch: false, locked: true, lockOwner: lease };
    }
    const label = lease.label || lease.key || 'another owner';
    const short = lease.key ? ` (${shortKey(String(lease.key), 16)})` : '';
    const lockedAt = Number(lease.lockedAt) > 0 ? new Date(Number(lease.lockedAt)).toISOString() : null;
    return {
      ok: false,
      status: 409,
      code: 'vm-locked',
      error: `VM ${id} is locked by ${label}${short}${lockedAt ? ` since ${lockedAt}` : ''}; only the lock owner can control it. Unlock it in the panel (POST /apk-vm/ownership action=unlock) or ask the lock owner to unlock it.`,
      owner: lease,
      locked: true,
      lockedAt: lease.lockedAt || null,
    };
  }
  if (isAdmin) {
    if (!mutating || !lease || !incoming || incoming.key === lease.key) {
      // Read-only access, unleased VM, or the admin's own lease.
      return { ok: true, admin: true, autoClaim: false, touch: false };
    }
    if (takeover) {
      return { ok: true, admin: true, takeover: true, autoClaim: false, touch: false };
    }
    const info = describeLeaseConflict(lease, id);
    return {
      ok: false,
      status: 409,
      code: 'vm-takeover-required',
      error: `${info.text}; send ${TAKEOVER_HEADER}: 1 (or click “Take over” in the panel) to take it over`,
      owner: lease,
      reserved: info.reserved,
      reservedUntil: info.reservedUntil,
    };
  }
  if (!lease) {
    return { ok: true, autoClaim: Boolean(incoming), touch: false };
  }
  if (!incoming) {
    const info = describeLeaseConflict(lease, id);
    return {
      ok: false,
      status: 409,
      code: 'vm-busy',
      error: `${info.text}; include x-apk-vm-owner or claim it first`,
      owner: lease,
      reserved: info.reserved,
      reservedUntil: info.reservedUntil,
    };
  }
  if (incoming.key === lease.key) {
    return { ok: true, autoClaim: false, touch: true };
  }
  const info = describeLeaseConflict(lease, id);
  return {
    ok: false,
    status: 409,
    code: 'vm-busy',
    error: `${info.text}; owner ${incoming.key} cannot control it; pass ownerForce:true (alias force:true) to take it over`,
    owner: lease,
    reserved: info.reserved,
    reservedUntil: info.reservedUntil,
  };
}

export const HTTP_OWNER_HEADERS = HEADER_NAMES.map(([, header]) => header);
