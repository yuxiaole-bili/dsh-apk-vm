#!/usr/bin/env node
/**
 * Hermetic checks for InstanceManager lifecycle helpers (no emulator/AVD).
 */
import assert from 'node:assert/strict';

import { InstanceManager } from '../lib/instances.js';

const manager = new InstanceManager({ idleTimeoutMs: 60_000, maxInstances: 3 });

// Agent assignment: first Agent gets default, default owner is visible.
const first = await manager.forAgent('agent-a');
assert.equal(first.id, 'default');
assert.equal(first.default, true);
assert.equal(manager.defaultOwner, 'agent-a');

const fake = {
  id: 'idle-one',
  owner: 'agent-b',
  lastUsedAt: Date.now() - 120_000,
  installInFlight: false,
  vm: { _state: 'ready', _serialActive: 'emulator-5560', serial: 'emulator-5560', _root: true },
  stream: { clients: new Set() },
  snapshotApk: () => null,
  stop: async () => {
    fake.vm._state = 'stopped';
    fake.stopped = true;
  },
};
manager.instances.set(fake.id, fake);

const listed = manager.list().find((entry) => entry.id === fake.id);
assert.ok(listed);
assert.equal(listed.owner, 'agent-b');
assert.equal(listed.idleTimeoutMs, 60_000);
assert.ok(listed.idleMs >= 60_000);

// Active stream clients and recent use must prevent reaping.
manager.instances.get(fake.id).stream.clients.add({});
assert.equal((await manager.reapIdle()).length, 0);
manager.instances.get(fake.id).stream.clients.clear();
manager.instances.get(fake.id).lastUsedAt = Date.now();
assert.equal((await manager.reapIdle()).length, 0);

// Old, idle instance is stopped.
manager.instances.get(fake.id).lastUsedAt = Date.now() - 120_000;
const reaped = await manager.reapIdle();
assert.deepEqual(reaped.map((entry) => entry.id), ['idle-one']);
assert.equal(fake.stopped, true);

// A stopped instance is not reaped again.
fake.vm._state = 'stopped';
fake.stopped = false;
assert.equal((await manager.reapIdle()).length, 0);

console.log('instances lifecycle: all checks passed');
