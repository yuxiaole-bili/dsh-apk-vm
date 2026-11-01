#!/usr/bin/env node
/**
 * VM ownership / dedicated conversation VM tests.
 *
 * These are unit tests: no emulator is started. InstanceManager.create is
 * stubbed with a minimal ExtraVmInstance-shaped object, so the scheduling and
 * lease behavior is exercised without touching an AVD.
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_LEASE_TTL_MS,
  OWNER_SCOPE,
  VmLeaseBook,
  VmLeaseConflict,
  createOwner,
  ownerKeyFor,
  ownerLabelFor,
  publicOwner,
} from '../lib/vm-ownership.js';
import { InstanceManager } from '../lib/instances.js';
import { checkOwnerAccess, ownerFromHttp } from '../lib/http-owner.js';

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

function fakeManager() {
  const manager = new InstanceManager({ maxInstances: 4, leaseTtlMs: 0 });
  let next = 0;
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

console.log(`\n${checks} checks passed`);
