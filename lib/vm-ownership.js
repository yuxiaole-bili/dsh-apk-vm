/**
 * VM ownership leases.
 *
 * A running Android emulator is expensive and stateful: two conversations that
 * type into it at the same time silently fight over the foreground app. This
 * module records who is currently using each VM (default or extra instance)
 * and lets callers choose a shared or dedicated VM without implicit takeover.
 *
 * Leases are intentionally small, serializable records. InstanceManager keeps
 * them in memory and (since 0.13.0) persists a snapshot to
 * `<profile>/.apk-vm/leases.json`; the lease key is derived from a DSH session
 * id or workspace path, never from a PID or a human-readable display label.
 *
 * Dedicated scopes (conversation/project) also carry a *reservation*: while the
 * reservation is alive the VM is reserved for that owner even if the lease
 * heartbeat (`lastSeenAt`) went stale, so another conversation cannot take it
 * without an explicit `force`/`ownerForce` takeover.
 */

export const OWNER_SCOPE = Object.freeze({
  SHARED: 'shared',
  CONVERSATION: 'conversation',
  PROJECT: 'project',
});

export const OWNER_SCOPES = Object.values(OWNER_SCOPE);
export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;
/** Dedicated VMs stay reserved for this long after the last activity. */
export const DEFAULT_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RESERVATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Roles are intentionally separate from scopes: a human panel user may be an
 * administrator while still choosing a shared/conversation/project scope.
 * Only the local panel should be allowed to send the admin role.
 */
export const OWNER_ROLE = Object.freeze({
  ADMIN: 'admin',
  USER: 'user',
});
export const OWNER_ROLES = Object.values(OWNER_ROLE);

export function normalizeRole(value, fallback = OWNER_ROLE.USER) {
  const text = String(value || '').trim().toLowerCase();
  if (OWNER_ROLES.includes(text)) return text;
  return fallback;
}

export function isAdminOwner(owner) {
  return Boolean(owner && normalizeRole(owner.role) === OWNER_ROLE.ADMIN);
}

export function normalizeScope(value, fallback = OWNER_SCOPE.SHARED) {
  const text = String(value || '').trim().toLowerCase();
  if (OWNER_SCOPES.includes(text)) return text;
  return fallback;
}

/** Only conversation/project VMs are reserved; shared VMs are not. */
export function isDedicatedScope(scope) {
  const normalized = normalizeScope(scope);
  return normalized === OWNER_SCOPE.CONVERSATION || normalized === OWNER_SCOPE.PROJECT;
}

function cleanText(value, max = 160) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function shortKey(value, max = 12) {
  const text = cleanText(value, 200);
  if (!text) return 'unknown';
  return text.length <= max ? text : text.slice(0, Math.max(4, max - 1)) + '…';
}

/** Build a stable owner key for a session/project scope. */
export function ownerKeyFor({ scope, sessionId, workspace, key } = {}) {
  const normalized = normalizeScope(scope);
  const explicit = cleanText(key, 200);
  if (explicit) return explicit;
  if (normalized === OWNER_SCOPE.CONVERSATION) {
    const id = cleanText(sessionId, 200);
    return id ? `session:${id}` : 'session:anonymous';
  }
  if (normalized === OWNER_SCOPE.PROJECT) {
    const cwd = cleanText(workspace, 400);
    return cwd ? `project:${cwd}` : 'project:unknown';
  }
  // A shared VM is still leased per conversation: two shared users must not
  // silently look like the same owner just because they both chose "shared".
  const sharedSession = cleanText(sessionId, 200);
  return sharedSession ? `shared:${sharedSession}` : 'shared';
}

function workspaceBase(workspace) {
  return cleanText(workspace, 400).split(/[\\/]/).filter(Boolean).pop() || '';
}

/** Human-readable label; the UI must never rely on the raw key for display. */
export function ownerLabelFor(owner) {
  if (!owner || typeof owner !== 'object') return '未占用';
  const explicit = cleanText(owner.label, 80);
  if (explicit) return explicit;
  const scope = normalizeScope(owner.scope);
  if (scope === OWNER_SCOPE.CONVERSATION) {
    const id = shortKey(owner.sessionId || owner.key, 8);
    return id === 'unknown' ? '对话' : `对话 ${id}`;
  }
  if (scope === OWNER_SCOPE.PROJECT) {
    const base = workspaceBase(owner.workspace || owner.key);
    return base ? `项目 ${base}` : '项目';
  }
  const session = shortKey(owner.sessionId, 8);
  if (session !== 'unknown') return `共享 ${session}`;
  const shared = shortKey(owner.key, 12);
  return shared === 'shared' || shared === 'unknown' ? '共享使用' : `共享 ${shared}`;
}

/** True while a dedicated owner's reservation window is still open. */
export function isReserved(owner, at = Date.now()) {
  if (!owner || typeof owner !== 'object') return false;
  const until = Number(owner.reservedUntil);
  if (!Number.isFinite(until) || until <= 0) return false;
  return until > Number(at);
}

/**
 * Create a normalized owner record. `since`/`lastSeenAt` are assigned by the
 * lease book when the owner is first/again claimed; callers may override them
 * for tests and for restoring a serialized lease.
 */
export function createOwner({
  key,
  scope = OWNER_SCOPE.SHARED,
  sessionId = null,
  workspace = null,
  label = '',
  role = OWNER_ROLE.USER,
  source = 'tool',
  since = null,
  lastSeenAt = null,
  reservedUntil = null,
} = {}) {
  const normalizedScope = normalizeScope(scope);
  const resolvedKey = ownerKeyFor({
    scope: normalizedScope,
    sessionId,
    workspace,
    key,
  });
  const owner = {
    key: resolvedKey,
    scope: normalizedScope,
    sessionId: cleanText(sessionId, 200) || null,
    workspace: cleanText(workspace, 400) || null,
    label: cleanText(label, 80) || ownerLabelFor({ key: resolvedKey, scope: normalizedScope, sessionId, workspace }),
    role: normalizeRole(role),
    source: cleanText(source, 40) || 'tool',
    since: Number.isFinite(since) ? Number(since) : null,
    lastSeenAt: Number.isFinite(lastSeenAt) ? Number(lastSeenAt) : null,
    reservedUntil: Number.isFinite(reservedUntil) && reservedUntil > 0 ? Number(reservedUntil) : null,
  };
  return owner;
}

/** Serialize an owner for JSON responses without exposing internal objects. */
export function publicOwner(owner) {
  if (!owner) return null;
  return {
    key: owner.key,
    scope: owner.scope,
    sessionId: owner.sessionId || null,
    workspace: owner.workspace || null,
    label: ownerLabelFor(owner),
    role: normalizeRole(owner.role),
    source: owner.source || 'tool',
    since: owner.since ?? null,
    lastSeenAt: owner.lastSeenAt ?? null,
    expiresAt: owner.expiresAt ?? null,
    reservedUntil: owner.reservedUntil ?? null,
    locked: owner.locked === true,
    lockedAt: owner.lockedAt ?? null,
  };
}

function reservationMessage(instanceId, owner) {
  const label = ownerLabelFor(owner);
  const short = shortKey(owner.key, 16);
  const until = Number(owner.reservedUntil);
  const untilText = Number.isFinite(until) && until > 0 ? new Date(until).toISOString() : null;
  if (untilText) {
    return `VM ${instanceId} is reserved by ${label} (${short}) until ${untilText}; pass ownerForce:true (alias force:true) to take it over`;
  }
  return `VM ${instanceId} is in use by ${label} (${short}); pass ownerForce:true (alias force:true) to take it over`;
}

function lockedMessage(instanceId, owner) {
  const label = ownerLabelFor(owner);
  const short = shortKey(owner.key, 16);
  return `VM ${instanceId} is locked by ${label} (${short}); only the lock owner can control it. Unlock it in the panel (or POST /apk-vm/ownership action=unlock) first`;
}

export class VmLeaseConflict extends Error {
  constructor(instanceId, owner, message) {
    const label = owner ? ownerLabelFor(owner) : 'another conversation';
    const locked = Boolean(owner && owner.locked === true);
    super(message || (owner
      ? (locked ? lockedMessage(instanceId, owner) : reservationMessage(instanceId, owner))
      : `VM ${instanceId} is in use by ${label}; pass ownerForce:true to take it over`));
    this.name = 'VmLeaseConflict';
    this.code = locked ? 'vm-locked' : 'vm-busy';
    this.status = 409;
    this.instanceId = instanceId;
    this.owner = publicOwner(owner);
    this.reserved = Boolean(owner && Number(owner.reservedUntil) > Date.now());
    this.reservedUntil = owner ? (owner.reservedUntil ?? null) : null;
    this.locked = locked;
    this.lockedAt = owner ? (owner.lockedAt ?? null) : null;
  }
}

/**
 * In-memory lease table. `list()` includes a computed `expiresAt` (and the
 * reservation window for dedicated scopes) but never mutates the stored owner
 * beyond lastSeen/since bookkeeping.
 */
export class VmLeaseBook {
  constructor({ ttlMs = DEFAULT_LEASE_TTL_MS, reservationTtlMs = DEFAULT_RESERVATION_TTL_MS, now = Date.now, onChange = null } = {}) {
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.reservationTtlMs = Math.min(
      MAX_RESERVATION_TTL_MS,
      Math.max(0, Number(reservationTtlMs) || 0)
    );
    this.now = typeof now === 'function' ? now : Date.now;
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.leases = new Map();
  }

  _emit(reason, detail = {}) {
    if (!this.onChange) return;
    try {
      this.onChange({ reason, at: this.now(), ...detail });
    } catch {
      /* persistence hooks must never break lease bookkeeping */
    }
  }

  /**
   * A lease expires when its heartbeat is too old. Dedicated leases with a
   * live reservation are kept until the reservation runs out instead.
   */
  isExpired(lease, at = this.now()) {
    if (!lease) return false;
    if (Number.isFinite(Number(lease.reservedUntil)) && Number(lease.reservedUntil) > 0) {
      return at > Number(lease.reservedUntil);
    }
    if (this.ttlMs <= 0) return false;
    const last = Number(lease.lastSeenAt || lease.since || 0);
    return last > 0 && at - last > this.ttlMs;
  }

  /** Heartbeat staleness (does not remove the lease; reservations still hold). */
  isStale(lease, at = this.now()) {
    if (!lease || this.ttlMs <= 0) return false;
    const last = Number(lease.lastSeenAt || lease.since || 0);
    return last > 0 && at - last > this.ttlMs;
  }

  _reservationUntil(owner, at) {
    if (!isDedicatedScope(owner.scope) || this.reservationTtlMs <= 0) return null;
    return at + this.reservationTtlMs;
  }

  get(id) {
    const key = String(id || 'default');
    const lease = this.leases.get(key) || null;
    if (!lease) return null;
    if (this.isExpired(lease)) {
      this.leases.delete(key);
      return null;
    }
    return lease;
  }

  claim(id, owner, { force = false } = {}) {
    const instanceId = String(id || 'default');
    const incoming = createOwner(owner || {});
    const at = this.now();
    const existing = this.get(instanceId);
    // A lock is a hard block: even ownerForce/takeover cannot steal a locked VM.
    if (existing && existing.locked === true && existing.key !== incoming.key) {
      throw new VmLeaseConflict(instanceId, existing);
    }
    if (existing && existing.key !== incoming.key && !force) {
      throw new VmLeaseConflict(instanceId, existing);
    }
    const previous = existing && existing.key !== incoming.key ? publicOwner(existing) : null;
    let lease;
    if (existing && existing.key === incoming.key) {
      lease = {
        ...existing,
        ...incoming,
        since: existing.since || at,
        lastSeenAt: at,
      };
    } else {
      lease = {
        ...incoming,
        since: at,
        lastSeenAt: at,
      };
    }
    lease.locked = Boolean(existing && existing.key === incoming.key && existing.locked === true);
    lease.lockedAt = lease.locked ? (existing && existing.lockedAt) || at : null;
    lease.expiresAt = this.ttlMs > 0 ? lease.lastSeenAt + this.ttlMs : null;
    // Keep an existing reservation when the same owner reclaims; otherwise
    // start a new window for dedicated scopes and clear it for shared ones.
    const extendUntil = existing && existing.key === incoming.key && isDedicatedScope(lease.scope)
      ? Number(existing.reservedUntil) || 0
      : 0;
    lease.reservedUntil = isDedicatedScope(lease.scope)
      ? Math.max(extendUntil, this._reservationUntil(lease, at) || 0) || null
      : null;
    this.leases.set(instanceId, lease);
    this._emit('claim', { id: instanceId, previous, owner: publicOwner(lease) });
    return {
      lease: publicOwner(lease),
      previous,
      reclaimed: Boolean(existing && existing.key === lease.key),
      reserved: Boolean(lease.reservedUntil),
      reservedUntil: lease.reservedUntil ?? null,
    };
  }

  touch(id, key = null) {
    const instanceId = String(id || 'default');
    const lease = this.get(instanceId);
    if (!lease) return null;
    if (key !== null && String(key) !== lease.key) return null;
    const at = this.now();
    lease.lastSeenAt = at;
    lease.expiresAt = this.ttlMs > 0 ? at + this.ttlMs : null;
    if (isDedicatedScope(lease.scope)) {
      lease.reservedUntil = this._reservationUntil(lease, at) || lease.reservedUntil || null;
    }
    this._emit('touch', { id: instanceId });
    return publicOwner(lease);
  }

  /**
   * Lock a leased VM. While locked, every mutating request from another owner
   * or agent is rejected with 409 `vm-locked`, including panel admin takeover.
   */
  lock(id, key = null, { force = false } = {}) {
    const instanceId = String(id || 'default');
    const lease = this.get(instanceId);
    if (!lease) throw new Error(`VM ${instanceId} is not leased; claim it before locking`);
    if (key !== null && String(key) !== lease.key && !force) {
      throw new VmLeaseConflict(instanceId, lease, `VM ${instanceId} is owned by ${ownerLabelFor(lease)}; pass force:true to lock it`);
    }
    if (lease.locked === true) return publicOwner(lease);
    const at = this.now();
    lease.locked = true;
    lease.lockedAt = at;
    lease.lastSeenAt = at;
    lease.expiresAt = this.ttlMs > 0 ? at + this.ttlMs : null;
    this._emit('lock', { id: instanceId, owner: publicOwner(lease) });
    return publicOwner(lease);
  }

  /** Remove a lock. Owners can unlock their own lease; `force` unlocks others'. */
  unlock(id, key = null, { force = false } = {}) {
    const instanceId = String(id || 'default');
    const lease = this.get(instanceId);
    if (!lease) return null;
    if (key !== null && String(key) !== lease.key && !force) {
      throw new VmLeaseConflict(instanceId, lease, `VM ${instanceId} is locked by ${ownerLabelFor(lease)}; only its owner (or an admin) can unlock it`);
    }
    const wasLocked = lease.locked === true;
    lease.locked = false;
    lease.lockedAt = null;
    if (wasLocked) this._emit('unlock', { id: instanceId, owner: publicOwner(lease) });
    return publicOwner(lease);
  }

  release(id, key = null, { force = false } = {}) {
    const instanceId = String(id || 'default');
    const lease = this.get(instanceId);
    if (!lease) return null;
    if (key !== null && String(key) !== lease.key && !force) {
      throw new VmLeaseConflict(instanceId, lease, `VM ${instanceId} is owned by ${ownerLabelFor(lease)}; pass force:true to release it`);
    }
    this.leases.delete(instanceId);
    this._emit('release', { id: instanceId, owner: publicOwner(lease) });
    return publicOwner(lease);
  }

  list() {
    const result = [];
    for (const id of [...this.leases.keys()]) {
      const lease = this.get(id);
      if (lease) result.push({ id, ...publicOwner(lease) });
    }
    return result;
  }

  /** Release every lease selected by `predicate(entry)`. Used when a DSH session ends. */
  releaseMatching(predicate) {
    const released = [];
    if (typeof predicate !== 'function') return released;
    for (const entry of this.list()) {
      if (!predicate(entry)) continue;
      const lease = this.get(entry.id);
      if (!lease) continue;
      this.leases.delete(entry.id);
      released.push({ id: entry.id, ...publicOwner(lease) });
      this._emit('release', { id: entry.id, owner: publicOwner(lease) });
    }
    return released;
  }

  clear() {
    if (!this.leases.size) return;
    this.leases.clear();
    this._emit('clear');
  }

  /** Serializable snapshot used by InstanceManager's lease store. */
  snapshot() {
    const entries = [];
    for (const entry of this.list()) {
      const lease = this.get(entry.id);
      if (!lease) continue;
      entries.push({
        id: entry.id,
        ...publicOwner(lease),
        reservedUntil: lease.reservedUntil ?? null,
      });
    }
    return entries;
  }

  /**
   * Restore a persisted snapshot. Entries whose reservation heartbeat expired
   * are ignored; entries with a live reservation are kept even when their
   * lastSeenAt is old (that is the point of a reservation).
   */
  restore(entries) {
    if (!Array.isArray(entries)) return 0;
    const at = this.now();
    let restored = 0;
    for (const entry of entries) {
      if (!entry || !entry.id) continue;
      const owner = createOwner({
        key: entry.key,
        scope: entry.scope,
        sessionId: entry.sessionId,
        workspace: entry.workspace,
        label: entry.label,
        role: entry.role,
        source: entry.source || 'restored',
        since: entry.since,
        lastSeenAt: entry.lastSeenAt,
        reservedUntil: entry.reservedUntil,
      });
      const lease = {
        ...owner,
        since: Number.isFinite(Number(entry.since)) ? Number(entry.since) : at,
        lastSeenAt: Number.isFinite(Number(entry.lastSeenAt)) ? Number(entry.lastSeenAt) : at,
        expiresAt: this.ttlMs > 0
          ? (Number.isFinite(Number(entry.lastSeenAt)) ? Number(entry.lastSeenAt) : at) + this.ttlMs
          : null,
        reservedUntil: Number.isFinite(Number(entry.reservedUntil)) && Number(entry.reservedUntil) > 0
          ? Number(entry.reservedUntil)
          : null,
        locked: entry.locked === true,
        lockedAt: Number.isFinite(Number(entry.lockedAt)) && Number(entry.lockedAt) > 0
          ? Number(entry.lockedAt)
          : null,
      };
      if (this.isExpired(lease, at)) continue;
      this.leases.set(String(entry.id), lease);
      restored += 1;
    }
    if (restored) this._emit('restore', { count: restored });
    return restored;
  }
}
