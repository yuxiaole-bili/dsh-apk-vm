/**
 * VM ownership leases.
 *
 * A running Android emulator is expensive and stateful: two conversations that
 * type into it at the same time silently fight over the foreground app. This
 * module records who is currently using each VM (default or extra instance)
 * and lets callers choose a shared or dedicated VM without implicit takeover.
 *
 * Leases are intentionally small, serializable records. InstanceManager keeps
 * them in memory; the lease key is derived from a DSH session id or workspace
 * path, never from a PID or a human-readable display label.
 */

export const OWNER_SCOPE = Object.freeze({
  SHARED: 'shared',
  CONVERSATION: 'conversation',
  PROJECT: 'project',
});

export const OWNER_SCOPES = Object.values(OWNER_SCOPE);
export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

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
  };
}

export class VmLeaseConflict extends Error {
  constructor(instanceId, owner, message) {
    const label = owner ? ownerLabelFor(owner) : 'another conversation';
    super(message || `VM ${instanceId} is in use by ${label}; pass force:true to take it over`);
    this.name = 'VmLeaseConflict';
    this.code = 'vm-busy';
    this.status = 409;
    this.instanceId = instanceId;
    this.owner = publicOwner(owner);
  }
}

/**
 * In-memory lease table. `list()` includes a computed `expiresAt` but never
 * mutates the stored owner beyond lastSeen/since bookkeeping.
 */
export class VmLeaseBook {
  constructor({ ttlMs = DEFAULT_LEASE_TTL_MS, now = Date.now } = {}) {
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.now = typeof now === 'function' ? now : Date.now;
    this.leases = new Map();
  }

  isExpired(lease, at = this.now()) {
    if (!lease || this.ttlMs <= 0) return false;
    const last = Number(lease.lastSeenAt || lease.since || 0);
    return last > 0 && at - last > this.ttlMs;
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
    if (existing && existing.key !== incoming.key && !force) {
      throw new VmLeaseConflict(instanceId, existing);
    }
    const lease = existing && existing.key === incoming.key
      ? {
          ...existing,
          ...incoming,
          since: existing.since || at,
          lastSeenAt: at,
        }
      : {
          ...incoming,
          since: at,
          lastSeenAt: at,
        };
    lease.expiresAt = this.ttlMs > 0 ? lease.lastSeenAt + this.ttlMs : null;
    this.leases.set(instanceId, lease);
    return {
      lease: publicOwner(lease),
      previous: existing && existing.key !== lease.key ? publicOwner(existing) : null,
      reclaimed: Boolean(existing && existing.key === lease.key),
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
    }
    return released;
  }

  clear() {
    this.leases.clear();
  }
}
