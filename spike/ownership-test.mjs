#!/usr/bin/env node
/**
 * VM ownership / dedicated conversation VM tests.
 *
 * These are unit tests: no emulator is started. InstanceManager.create is
 * stubbed with a minimal ExtraVmInstance-shaped object, so the scheduling and
 * lease behavior is exercised without touching an AVD.
 */
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_RESERVATION_TTL_MS,
  OWNER_SCOPE,
  VmLeaseBook,
  VmLeaseConflict,
  createOwner,
  isReserved,
  ownerKeyFor,
  ownerLabelFor,
  publicOwner,
} from '../lib/vm-ownership.js';
import { loadLeaseStore } from '../lib/lease-store.js';
import { InstanceManager } from '../lib/instances.js';
import { checkOwnerAccess, ownerFromHttp, takeoverFromHttp } from '../lib/http-owner.js';

let checks = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  checks += 1;
  console.log('  ok', message);
}
function eq(actual, expected, message) {
  assert.equal(actual, expected, message);
  checks += 1;
  console.log('  ok', message);
}

function fakeManager(options = {}) {
  const manager = new InstanceManager({ maxInstances: 4, leaseTtlMs: 0, ...options });
  let next = 0;
  manager._extraAvdExists = () => true;
  manager.create = async ({ name } = {}) => {
    if (manager.instances.size >= manager.maxInstances) {
      throw new Error(`max instances reached (${manager.maxInstances})`);
    }
    const id = `${name || 'vm'}-${next++}`;
    const instance = {
      id,
      avdName: `avd_${id}`,
      port: 6000 + next,
      owner: null,
      lastUsedAt: Date.now(),
      vm: { _state: 'stopped', _serialActive: null, _root: false },
      touch() { this.lastUsedAt = Date.now(); },
      snapshotApk() { return null; },
    };
    manager.instances.set(id, instance);
    return instance;
  };
  return manager;
}

console.log('ownership: lease book');
{
  const book = new VmLeaseBook({ ttlMs: 0 });
  const a = book.claim('default', { scope: OWNER_SCOPE.SHARED, sessionId: 'session-a' });
  eq(a.lease.key, 'shared:session-a', 'shared lease keys are per session');
  eq(book.get('default').key, 'shared:session-a', 'lease stored');
  assert.throws(
    () => book.claim('default', { scope: OWNER_SCOPE.SHARED, sessionId: 'session-b' }),
    (error) => error instanceof VmLeaseConflict && error.code === 'vm-busy' && error.status === 409,
    'another session cannot implicitly claim a busy VM'
  );
  checks += 1;
  const forced = book.claim('default', { scope: OWNER_SCOPE.SHARED, sessionId: 'session-b' }, { force: true });
  eq(forced.lease.key, 'shared:session-b', 'explicit force takes over');
  eq(forced.previous.key, 'shared:session-a', 'takeover reports previous owner');
  book.release('default', 'shared:session-b');
  eq(book.get('default'), null, 'release clears lease');
  assert.doesNotThrow(() => book.release('default', 'shared:session-b'), 'releasing an unleased VM is a no-op');
  checks += 1;
}

console.log('ownership: owner keys');
{
  const a = createOwner({ scope: 'conversation', sessionId: 's1', label: 'work' });
  const b = createOwner({ scope: 'conversation', sessionId: 's1' });
  const c = createOwner({ scope: 'conversation', sessionId: 's2' });
  eq(a.key, b.key, 'same conversation resolves to one owner key');
  ok(a.key !== c.key, 'different conversations resolve to different owner keys');
  eq(ownerKeyFor({ scope: 'project', workspace: 'D:\\work\\app' }), 'project:D:\\work\\app', 'project key uses workspace');
  eq(ownerKeyFor({ scope: 'shared', sessionId: 's1' }), 'shared:s1', 'shared key still includes session');
  ok(ownerLabelFor(a).includes('work'), 'explicit label is displayed');
  eq(publicOwner(a).key, a.key, 'public owner keeps the stable key');
  eq(DEFAULT_LEASE_TTL_MS, 30 * 60 * 1000, 'default lease ttl is 30 minutes');
}

console.log('ownership: InstanceManager scheduling');
{
  const manager = fakeManager();
  const first = await manager.forOwner(createOwner({ scope: 'shared', sessionId: 'conv-a' }));
  eq(first.default, true, 'first shared conversation gets default VM');
  eq(manager.ownerInfo('default').sessionId, 'conv-a', 'default VM records its conversation owner');

  const second = await manager.forOwner(createOwner({ scope: 'shared', sessionId: 'conv-b' }));
  ok(second.default !== true, 'second shared conversation gets an isolated VM');
  eq(manager.ownerInfo(second.id).sessionId, 'conv-b', 'extra VM records its owner');
  eq(manager.ownerInfo(second.id).scope, 'shared', 'extra VM keeps shared scope');

  const again = await manager.forOwner(createOwner({ scope: 'shared', sessionId: 'conv-b' }));
  eq(again.id, second.id, 'returning conversation reuses its VM');

  const dedicated = await manager.forOwner(createOwner({ scope: 'conversation', sessionId: 'conv-c' }));
  ok(dedicated.default !== true, 'conversation scope gets a dedicated VM when default is owned');
  eq(manager.ownerInfo(dedicated.id).scope, 'conversation', 'conversation lease has conversation scope');
  const dedicatedAgain = await manager.forOwner(createOwner({ scope: 'conversation', sessionId: 'conv-c' }));
  eq(dedicatedAgain.id, dedicated.id, 'dedicated VM is reused across turns');

  assert.throws(
    () => manager.claimOwner('default', createOwner({ scope: 'conversation', sessionId: 'conv-d' })),
    (error) => error instanceof VmLeaseConflict,
    'explicit claim conflicts with the current default owner'
  );
  checks += 1;

  const released = manager.releaseOwner('default', createOwner({ sessionId: 'conv-a' }));
  ok(released, 'owner can release the default VM');
  const next = await manager.forOwner(createOwner({ scope: 'conversation', sessionId: 'conv-d' }));
  eq(next.default, true, 'released default VM can be claimed by a new owner');
  eq(manager.ownerInfo('default').scope, 'conversation', 'default VM can be used by a dedicated owner');
}

console.log('ownership: max instances');
{
  const manager = fakeManager();
  manager.maxInstances = 1;
  await manager.forOwner(createOwner({ scope: 'shared', sessionId: 'a' }));
  await manager.forOwner(createOwner({ scope: 'shared', sessionId: 'b' }));
  await assert.rejects(
    manager.forOwner(createOwner({ scope: 'shared', sessionId: 'c' })),
    /max instances reached/,
    'a full manager reports maxInstances instead of stealing the default VM'
  );
  checks += 1;
}

console.log('ownership: readable labels and session release');
{
  const sharedLabel = ownerLabelFor(createOwner({ scope: 'shared', sessionId: 'abcdef123456' }));
  ok(sharedLabel.startsWith('共享 '), 'shared owner label is human readable');
  const convLabel = ownerLabelFor(createOwner({ scope: 'conversation', sessionId: 'abcdef123456' }));
  ok(convLabel.startsWith('对话 '), 'conversation owner label is human readable');
  const projectLabel = ownerLabelFor(createOwner({ scope: 'project', workspace: 'D:\\work\\my-app' }));
  eq(projectLabel, '项目 my-app', 'project label uses the workspace folder name');

  const manager = fakeManager();
  await manager.forOwner(createOwner({ scope: 'shared', sessionId: 'conv-close-a' }));
  await manager.forOwner(createOwner({ scope: 'shared', sessionId: 'conv-close-b' }));
  const released = manager.releaseBySession('conv-close-a');
  eq(released.length, 1, 'session disposal releases every lease for that session');
  eq(manager.ownerInfo('default'), null, 'released default lease is visible immediately');
  eq(manager.ownerInfo(released[0].instanceId), null, 'released extra lease is cleared too');
  eq(manager.releaseBySession('conv-close-a').length, 0, 'releasing a disposed session twice is a no-op');
}

console.log('ownership: HTTP owner guard');
{
  const incoming = ownerFromHttp(
    {
      'x-apk-vm-owner': 'panel',
      'x-apk-vm-scope': 'conversation',
      'x-apk-vm-session': 'sess-1',
      'x-apk-vm-workspace': 'D:\\work\\app',
      'x-apk-vm-label': '桌面面板',
    },
    new URLSearchParams()
  );
  eq(incoming.key, 'panel', 'HTTP owner key parsed');
  eq(incoming.scope, 'conversation', 'HTTP owner scope parsed');
  eq(incoming.sessionId, 'sess-1', 'HTTP owner session parsed');
  eq(incoming.workspace, 'D:\\work\\app', 'HTTP owner workspace parsed');
  eq(incoming.label, '桌面面板', 'HTTP owner label parsed');
  const admin = ownerFromHttp(
    {
      'x-apk-vm-owner': 'panel:admin',
      'x-apk-vm-role': 'admin',
      'x-apk-vm-label': encodeURIComponent('桌面管理员'),
    },
    new URLSearchParams()
  );
  eq(admin.role, 'admin', 'HTTP admin role parsed');
  eq(admin.label, '桌面管理员', 'percent-encoded admin label decoded');
  const adminLease = { ...publicOwner(createOwner({ scope: 'shared', label: 'Agent A' })), key: 'agent:a' };
  const adminAccess = checkOwnerAccess(adminLease, admin, 'default');
  eq(adminAccess.ok, true, 'admin bypasses a foreign lease');
  eq(adminAccess.admin, true, 'admin access is marked');
  eq(adminAccess.autoClaim, false, 'admin does not auto-claim or steal the lease');
  eq(adminAccess.touch, false, 'admin does not refresh the agent lease');
  const encoded = ownerFromHttp(
    {
      'x-apk-vm-owner': 'panel',
      'x-apk-vm-workspace': encodeURIComponent('D:\\滚木\\项目'),
      'x-apk-vm-label': encodeURIComponent('桌面面板'),
    },
    new URLSearchParams()
  );
  eq(encoded.workspace, 'D:\\滚木\\项目', 'percent-encoded workspace header is decoded');
  eq(encoded.label, '桌面面板', 'percent-encoded label header is decoded');
  eq(ownerFromHttp({}, new URLSearchParams()), null, 'no owner header means anonymous caller');

  const lease = { ...publicOwner(createOwner({ scope: 'conversation', sessionId: 'sess-1', label: '桌面面板' })), key: incoming.key };
  const free = checkOwnerAccess(null, incoming, 'default');
  eq(free.autoClaim, true, 'owner header auto-claims a free VM');
  const same = checkOwnerAccess(lease, incoming, 'default');
  eq(same.ok, true, 'same owner is allowed');
  eq(same.touch, true, 'same owner refreshes the lease');
  const noOwner = checkOwnerAccess(lease, null, 'default');
  eq(noOwner.ok, false, 'mutating HTTP call without owner is blocked on a leased VM');
  eq(noOwner.code, 'vm-busy', 'missing HTTP owner returns vm-busy');
  const foreign = checkOwnerAccess(lease, { ...incoming, key: 'other-panel' }, 'default');
  eq(foreign.ok, false, 'foreign HTTP owner is blocked');
  eq(foreign.owner.key, lease.key, 'conflict reports the current owner');
}

console.log('ownership: reservations');
{
  let now = 1_800_000_000_000;
  const book = new VmLeaseBook({ ttlMs: 0, reservationTtlMs: 60_000, now: () => now });
  const claim = book.claim('default', { scope: OWNER_SCOPE.CONVERSATION, sessionId: 'sess-a' });
  eq(claim.reserved, true, 'conversation claims are reserved');
  eq(claim.reservedUntil, now + 60_000, 'reservation deadline uses reservationTtlMs');
  ok(isReserved(claim.lease, now), 'leased owner is reserved while within the deadline');
  eq(DEFAULT_RESERVATION_TTL_MS, 24 * 60 * 60 * 1000, 'default reservation ttl is 24 hours');

  let conflict = null;
  try {
    book.claim('default', { scope: OWNER_SCOPE.CONVERSATION, sessionId: 'sess-b' });
  } catch (error) {
    conflict = error;
  }
  ok(conflict instanceof VmLeaseConflict, 'reserved VM rejects a foreign claim');
  eq(conflict.code, 'vm-busy', 'reserved conflict keeps vm-busy code');
  eq(conflict.reserved, true, 'conflict marks the reservation');
  ok(String(conflict.message).includes('reserved by'), 'conflict names the reservation');
  ok(String(conflict.message).includes('ownerForce:true'), 'conflict explains the force escape hatch');
  ok(String(conflict.message).includes('force:true'), 'conflict mentions the force alias');

  const taken = book.claim('default', { scope: OWNER_SCOPE.CONVERSATION, sessionId: 'sess-b' }, { force: true });
  eq(taken.previous.key, 'session:sess-a', 'forced takeover reports the previous owner');
  eq(taken.reserved, true, 'the new reservation starts immediately');

  const shared = book.claim('vm-shared', { scope: OWNER_SCOPE.SHARED, sessionId: 'sess-a' });
  eq(shared.reserved, false, 'shared claims are not reserved');
  eq(shared.reservedUntil, null, 'shared claims have no reservation deadline');

  now += 61_000;
  eq(book.get('default'), null, 'expired reservation drops the lease');

  const project = book.claim('vm-project', { scope: OWNER_SCOPE.PROJECT, workspace: 'D:\\work\\app' });
  eq(project.reserved, true, 'project claims are reserved');
  now += 1_000;
  book.touch('vm-project', project.lease.key);
  eq(book.get('vm-project').reservedUntil, now + 60_000, 'touch extends the reservation');
}

console.log('ownership: admin takeover confirmation');
{
  const admin = ownerFromHttp(
    { 'x-apk-vm-owner': 'panel:admin', 'x-apk-vm-role': 'admin', 'x-apk-vm-label': '桌面管理员' },
    new URLSearchParams()
  );
  eq(takeoverFromHttp({ 'x-apk-vm-takeover': '1' }, new URLSearchParams()), true, 'takeover header value 1 is parsed');
  eq(takeoverFromHttp({ 'x-apk-vm-takeover': 'yes' }, new URLSearchParams()), true, 'takeover header value yes is parsed');
  eq(takeoverFromHttp({}, new URLSearchParams('takeover=true')), true, 'takeover query flag is parsed');
  eq(takeoverFromHttp({}, new URLSearchParams()), false, 'missing takeover flag is false');

  const lease = { ...publicOwner(createOwner({ scope: 'conversation', sessionId: 'sess-1', label: 'Agent A' })), key: 'agent:a' };
  const readOnly = checkOwnerAccess(lease, admin, 'default');
  eq(readOnly.ok, true, 'admin read-only access stays allowed');
  const guarded = checkOwnerAccess(lease, admin, 'default', { mutating: true });
  eq(guarded.ok, false, 'admin mutation on a foreign lease is blocked');
  eq(guarded.code, 'vm-takeover-required', 'admin mutation requires an explicit takeover');
  ok(String(guarded.error).includes('x-apk-vm-takeover'), 'blocked admin is told how to take over');
  const takeover = checkOwnerAccess(lease, admin, 'default', { mutating: true, takeover: true });
  eq(takeover.ok, true, 'explicit takeover header allows admin mutation');
  eq(takeover.takeover, true, 'takeover is marked on the access result');
  eq(takeover.autoClaim, false, 'takeover still does not auto-claim');
  eq(takeover.touch, false, 'takeover does not touch the previous lease');
}

console.log('ownership: persisted leases survive a restart');
{
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'apkvm-own-'));
  const file = path.join(dir, 'leases.json');
  try {
    const owner = createOwner({ scope: 'conversation', sessionId: 'sess-persist' });
    const first = fakeManager({ leasesFile: file, leaseReservationTtlMs: 60_000 });
    const claimed = await first.forOwner(owner);
    eq(claimed.default, true, 'first conversation claims the free default VM');
    const raw = loadLeaseStore(file);
    eq(raw.length, 1, 'lease is persisted to disk');
    eq(raw[0].id, 'default', 'persisted lease names the default VM');
    eq(raw[0].key, owner.key, 'persisted lease keeps the owner key');
    ok(Number(raw[0].reservedUntil) > Date.now(), 'persisted lease keeps the reservation deadline');

    const second = fakeManager({ leasesFile: file, leaseReservationTtlMs: 60_000 });
    eq(second.ownerInfo('default').key, owner.key, 'restart restores the default reservation');
    const reused = await second.forOwner(owner);
    eq(reused.default, true, 'the reserved owner gets the default VM after restart');

    const other = createOwner({ scope: 'conversation', sessionId: 'sess-extra' });
    const third = fakeManager({ leasesFile: file, leaseReservationTtlMs: 60_000 });
    const extra = await third.forOwner(other);
    ok(extra.default !== true, 'a second reserved conversation gets an extra VM');
    ok(loadLeaseStore(file).some((entry) => entry.id === extra.id), 'extra VM lease is persisted too');

    const fourth = fakeManager({ leasesFile: file, leaseReservationTtlMs: 60_000 });
    const resumed = await fourth.forOwner(other);
    ok(resumed.default !== true, 'restart keeps the extra VM dedicated');
    eq(fourth.ownerInfo(resumed.id).key, other.key, 'restored extra VM belongs to the same owner');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

console.log('ownership: stale persisted leases for deleted AVDs are dropped');
{
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'apkvm-own-'));
  const file = path.join(dir, 'leases.json');
  try {
    const owner = createOwner({ scope: 'conversation', sessionId: 'sess-ghost', label: 'ghost' });
    const now = Date.now();
    await fsp.writeFile(file, JSON.stringify({
      version: 1,
      savedAt: new Date(now).toISOString(),
      leases: [{
        id: 'ghost-1',
        key: owner.key,
        scope: owner.scope,
        sessionId: owner.sessionId,
        workspace: owner.workspace,
        label: owner.label,
        role: owner.role,
        since: now,
        lastSeenAt: now,
        expiresAt: now + 3_600_000,
        reservedUntil: now + 86_400_000,
      }],
    }, null, 2));
    const manager = fakeManager({ leasesFile: file, leaseReservationTtlMs: 60_000 });
    manager._extraAvdExists = () => false; // the AVD was removed by clean_storage
    const assigned = await manager.forOwner(owner);
    eq(assigned.default, true, 'stale lease is dropped and scheduling falls back to the free default');
    ok(!loadLeaseStore(file).some((entry) => entry.id === 'ghost-1'), 'stale lease is removed from disk');
    ok(!manager.instances.has('ghost-1'), 'the deleted AVD is not recreated');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

console.log('ownership: explicit claim redirects implicit resolution');
{
  const manager = fakeManager();
  const blocker = createOwner({ scope: 'conversation', sessionId: 'blocker' });
  manager.claimOwner('default', blocker);
  const owner = createOwner({ scope: 'conversation', sessionId: 'sess-claim', label: 'claimant' });
  const dedicated = await manager.forOwner(owner);
  ok(dedicated.default !== true, 'a dedicated VM is created while the default is busy');

  // The agent explicitly claims the default VM, as the claim_vm action does.
  manager.claimOwner('default', owner, { force: true });
  const sharedOwner = createOwner({ scope: 'shared', sessionId: 'sess-claim' });
  const resolved = await manager.forOwner(sharedOwner);
  eq(resolved.default, true, 'implicit shared-scope calls follow the claimed default VM');
  const conversationAgain = await manager.forOwner(owner);
  eq(conversationAgain.default, true, 'the conversation scope resolves to the same claimed VM');

  manager.releaseOwner('default', owner);
  const afterRelease = await manager.forOwner(createOwner({ scope: 'shared', sessionId: 'sess-claim' }));
  eq(afterRelease.default, true, 'a released, unleased default VM is available again');

  // Releasing an extra VM must clear its implicit mapping as well.
  const third = fakeManager();
  const holder = createOwner({ scope: 'shared', sessionId: 'holder-2' });
  await third.forOwner(holder);
  const releasable = createOwner({ scope: 'conversation', sessionId: 'sess-release' });
  const extra = await third.forOwner(releasable);
  ok(extra.default !== true, 'releasable conversation gets an isolated VM');
  third.releaseOwner(extra.id, releasable);
  const afterExtraRelease = await third.forOwner(createOwner({ scope: 'shared', sessionId: 'sess-release' }));
  ok(afterExtraRelease.id !== extra.id, 'releasing an extra VM clears its implicit mapping');

  // Claiming an extra VM must also redirect implicit calls to that instance.
  const second = fakeManager();
  await second.forOwner(holder);
  const extraOwner = createOwner({ scope: 'conversation', sessionId: 'sess-extra-claim' });
  const claimedExtra = await second.forOwner(extraOwner);
  ok(claimedExtra.default !== true, 'second conversation gets an isolated VM');
  second.claimOwner(claimedExtra.id, extraOwner, { force: true });
  const extraShared = await second.forOwner(createOwner({ scope: 'shared', sessionId: 'sess-extra-claim' }));
  eq(extraShared.id, claimedExtra.id, 'claiming an extra VM redirects implicit calls to it');
}

console.log('ownership: VM locks');
{
  const book = new VmLeaseBook({ ttlMs: 0, now: () => 1000 });
  const alice = createOwner({ scope: 'conversation', sessionId: 'sess-lock-a' });
  const bob = createOwner({ scope: 'conversation', sessionId: 'sess-lock-b' });
  assert.throws(() => book.lock('default', alice.key), /not leased/);
  book.claim('default', alice, { force: false });
  const locked = book.lock('default', alice.key);
  ok(locked.locked === true && Number(locked.lockedAt) === 1000, 'leasing owner can lock the VM');
  const readOk = checkOwnerAccess(book.get('default'), bob, 'default', { mutating: false });
  ok(readOk.ok === true, 'read-only requests pass while locked');
  const bobChange = checkOwnerAccess(book.get('default'), bob, 'default', { mutating: true });
  eq(bobChange.code, 'vm-locked', 'other owners are blocked while locked');
  const bobTakeover = checkOwnerAccess(book.get('default'), bob, 'default', { mutating: true, takeover: true });
  eq(bobTakeover.code, 'vm-locked', 'takeover does not break a lock');
  const admin = createOwner({ key: 'panel-admin:desktop', scope: 'shared', label: 'Desktop panel', role: 'admin' });
  const adminChange = checkOwnerAccess(book.get('default'), admin, 'default', { mutating: true, takeover: true });
  eq(adminChange.code, 'vm-locked', 'panel admin takeover is blocked while locked');
  const adminRead = checkOwnerAccess(book.get('default'), admin, 'default', { mutating: false });
  ok(adminRead.ok === true, 'panel admin can still read a locked VM');
  const ownerChange = checkOwnerAccess(book.get('default'), alice, 'default', { mutating: true });
  ok(ownerChange.ok === true, 'lock owner keeps operating');
  assert.throws(() => book.claim('default', bob, { force: true }), (error) => error.code === 'vm-locked');
  ok(true, 'ownerForce cannot steal a locked VM');
  const snapshot = book.snapshot();
  eq(snapshot[0].locked, true, 'snapshot records the lock');
  const restoredBook = new VmLeaseBook({ ttlMs: 0, now: () => 2000 });
  restoredBook.restore(snapshot);
  eq(restoredBook.get('default').locked, true, 'restored lease keeps the lock');
  const unlocked = book.unlock('default', admin.key, { force: true });
  ok(unlocked.locked === false, 'admin can force-unlock');
  const adminAfter = checkOwnerAccess(book.get('default'), admin, 'default', { mutating: true, takeover: true });
  ok(adminAfter.ok === true, 'after unlock, an explicit takeover is allowed again');
}

console.log('ownership: lock policy modes');
{
  const book = new VmLeaseBook({ ttlMs: 0, now: () => 3000 });
  const alice = createOwner({ scope: 'conversation', sessionId: 'sess-policy-a' });
  const bob = createOwner({ scope: 'conversation', sessionId: 'sess-policy-b' });
  const admin = createOwner({ key: 'panel-admin:desktop', scope: 'shared', label: 'Desktop panel', role: 'admin' });
  book.claim('default', alice, { force: false });
  book.lock('default', alice.key);

  const offForeign = checkOwnerAccess(book.get('default'), bob, 'default', { mutating: true, lockMode: 'off' });
  ok(offForeign.ok === false && /locked/.test(String(offForeign.error)) === false, 'lockMode off falls back to the normal reservation conflict');
  const offAdmin = checkOwnerAccess(book.get('default'), admin, 'default', { mutating: true, lockMode: 'off' });
  eq(offAdmin.code, 'vm-takeover-required', 'lockMode off keeps the admin takeover confirmation');
  const offRead = checkOwnerAccess(book.get('default'), bob, 'default', { mutating: false, lockMode: 'off' });
  ok(offRead.ok === false && offRead.code === 'vm-busy', 'lockMode off keeps the normal owner guard for other sessions');
  const offAdminRead = checkOwnerAccess(book.get('default'), admin, 'default', { mutating: false, lockMode: 'off' });
  ok(offAdminRead.ok === true && offAdminRead.admin === true, 'lockMode off keeps admin read-only access');

  const agentsForeign = checkOwnerAccess(book.get('default'), bob, 'default', { mutating: true, lockMode: 'agents' });
  eq(agentsForeign.code, 'vm-locked', 'lockMode agents still blocks other agents');
  const agentsAdmin = checkOwnerAccess(book.get('default'), admin, 'default', { mutating: true, lockMode: 'agents' });
  ok(agentsAdmin.ok === true && agentsAdmin.locked === true, 'lockMode agents lets the local panel operate a locked VM');
  const agentsAdminRead = checkOwnerAccess(book.get('default'), admin, 'default', { mutating: false, lockMode: 'agents' });
  ok(agentsAdminRead.ok === true, 'lockMode agents keeps read-only access');
}

console.log(`\n${checks} checks passed`);

